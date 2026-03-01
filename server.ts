import { WebSocketServer, WebSocket } from "ws";
import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
// *** THE FIX IS HERE: Import the parser and game state interfaces ***
import { parseLogLine, getInitialState, GameState } from "./parser.js";

const APP_DIR = process.cwd();
const FORGE_DECKS_DIR = path.join(APP_DIR, "decks", "constructed");

// --- WebSocket Server Setup ---
const wss = new WebSocketServer({ port: 8080 });
console.log(`[INIT] Sidecar WebSocket server started on port 8080.`);
wss.on('listening', () => console.log('[HEALTH_CHECK] Server is listening on port 8080.'));
if (!fs.existsSync(FORGE_DECKS_DIR)) {
    fs.mkdirSync(FORGE_DECKS_DIR, { recursive: true });
}

wss.on("connection", (ws) => {
  console.log("[WSS] Client connected.");
  ws.send(JSON.stringify({ type: "CONNECTION_ESTABLISHED", status: "Ready to start match." }));
  ws.on("message", (message) => {
    try {
        const data = JSON.parse(message.toString());
        if (data.type === "START_MATCH") {
          console.log("[WSS] Received START_MATCH signal. Starting match.");
          startMatch(ws, data.payload); // Changed from startDiagnostic to startMatch
        }
    } catch (e) { console.error("[WSS] Failed to parse incoming WebSocket message:", e); }
  });
});

// --- Main Match Logic ---
function startMatch(ws: WebSocket, payload: any) {
  const { deck1, deck2 } = payload;
  const jarPath = path.join(APP_DIR, "forgeSim.jar");
  
  // *** THE FIX IS HERE: Initialize a state object for the match ***
  let currentGameState: GameState = getInitialState();

  try {
    fs.writeFileSync(path.join(FORGE_DECKS_DIR, deck1.filename), deck1.content);
    fs.writeFileSync(path.join(FORGE_DECKS_DIR, deck2.filename), deck2.content);
    console.log(`[MATCH] Deck files written to: ${FORGE_DECKS_DIR}`);
  } catch(e: any) {
    console.error(`[MATCH] FATAL: Failed during deck file write.`, e.message);
    ws.send(JSON.stringify({ type: "ERROR", message: "Failed to write deck files to disk." }));
    return;
  }

  const commandToRun = "java";
  const commandArgs = [
      "-Xmx1024m",
      `-Djava.awt.headless=true`,
      `-Dsentry.enabled=false`,
      `-Dforge.home=${APP_DIR}`,
      "-jar",
      jarPath,
      "sim",
      "-d", deck1.filename, deck2.filename,
      "-a", deck1.aiProfile, deck2.aiProfile,
      "-n", "1",
  ];

  console.log(`[MATCH] Spawning process with command: ${commandToRun} ${commandArgs.join(' ')}`);

  const forgeProcess = spawn(commandToRun, commandArgs, { cwd: APP_DIR });

  forgeProcess.on('error', (err) => {
    console.error('[FATAL_SPAWN_ERROR] Failed to start the simulation process.', err);
    broadcast({ type: "ERROR", message: 'Failed to start simulation process.' });
  });

  // stdout contains the forge simulation log we need to parse
  forgeProcess.stdout.on('data', (data) => {
      const logChunk = data.toString();
      console.log(`[FORGE_LOG]: ${logChunk}`); // Keep logging the raw output for debugging

      // *** THE FIX IS HERE: Process each line with the parser ***
      const lines = logChunk.split('\\n');
      for (const line of lines) {
        if (line.trim() === '') continue;
        const newState = parseLogLine(line, currentGameState);
        if (newState) {
          currentGameState = newState;
          // Broadcast the updated game state to all clients
          broadcast({ type: 'GAME_STATE_UPDATE', payload: currentGameState });
        }
      }
  });
  
  // Also listen to stderr for any Java errors
  forgeProcess.stderr.on('data', (data) => {
      console.error(`[JVM_STDERR]: ${data.toString()}`);
  });

  forgeProcess.on("close", (code) => {
    if (code === 0) {
      console.log(`[MATCH_SUCCESS] Process exited with code ${code}`);
      broadcast({ type: "MATCH_COMPLETE", success: true, message: `Match finished successfully.` });
    } else {
      console.error(`[MATCH_FAILURE] Process exited with non-zero code ${code}`);
      broadcast({ type: "MATCH_COMPLETE", success: false, message: `Match failed with exit code ${code}.` });
    }
  });
}

function broadcast(data: object) {
  const payload = JSON.stringify(data);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
}

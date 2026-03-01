import { WebSocketServer, WebSocket } from "ws";
import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
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
          startMatch(ws, data.payload);
        }
    } catch (e) { console.error("[WSS] Failed to parse incoming WebSocket message:", e); }
  });
});

// --- Main Match Logic ---
function startMatch(ws: WebSocket, payload: any) {
  const { deck1, deck2 } = payload;
  const jarPath = path.join(APP_DIR, "forgeSim.jar");
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
  
  // *** THE FIX IS HERE: Dynamic command generation based on environment variable ***
  const diagLevel = process.env.DIAG_LEVEL;
  console.log(`[DIAG] Diagnostic level set to: ${diagLevel || '1 (Production)'}`);

  let commandToRun: string;
  let commandArgs: string[];

  const baseJavaArgs = [
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

  switch (diagLevel) {
    case '3': // Highest verbosity: strace + verbose:class
      commandToRun = "strace";
      commandArgs = ["-f", "java", "-verbose:class", ...baseJavaArgs];
      break;
    case '2': // Medium verbosity: verbose:class
      commandToRun = "java";
      commandArgs = ["-verbose:class", ...baseJavaArgs];
      break;
    default:  // Level 1 or unset: Production mode
      commandToRun = "java";
      commandArgs = baseJavaArgs;
      break;
  }

  console.log(`[MATCH] Spawning process with command: ${commandToRun} ${commandArgs.join(' ')}`);

  const forgeProcess = spawn(commandToRun, commandArgs, { cwd: APP_DIR });

  forgeProcess.on('error', (err) => {
    console.error('[FATAL_SPAWN_ERROR] Failed to start the simulation process.', err);
    broadcast({ type: "ERROR", message: 'Failed to start simulation process.' });
  });

  forgeProcess.stdout.on('data', (data) => {
      const logChunk = data.toString();
      console.log(`[FORGE_LOG]: ${logChunk}`);
      const lines = logChunk.split('\\n');
      for (const line of lines) {
        if (line.trim() === '') continue;
        const newState = parseLogLine(line, currentGameState);
        if (newState) {
          currentGameState = newState;
          broadcast({ type: 'GAME_STATE_UPDATE', payload: currentGameState });
        }
      }
  });
  
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

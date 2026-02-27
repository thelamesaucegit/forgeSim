import { WebSocketServer, WebSocket } from "ws";
import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";

// NOTE: chokidar and parser are not used in this diagnostic script,
// as we only care about the STDERR output from strace.
import chokidar from "chokidar";
import { parseLogLine, getInitialState, GameState } from "./parser.js";

// --- Server State (Minimal for this test) ---
let simulationStatus: "idle" | "running" | "finished" = "idle";

// --- WebSocket Server Setup ---
const wss = new WebSocketServer({ port: 8080 });
const APP_DIR = process.cwd();
console.log(`[INIT] Sidecar WebSocket server started on port 8080.`);
console.log(`[INIT] Application root directory: ${APP_DIR}`);

const FORGE_DECKS_DIR = path.join(APP_DIR, "res", "decks", "constructed");
if (!fs.existsSync(FORGE_DECKS_DIR)) {
    console.log(`[INIT] Decks directory not found. Creating it...`);
    fs.mkdirSync(FORGE_DECKS_DIR, { recursive: true });
}

wss.on("connection", (ws) => {
  console.log("[WSS] Client connected.");
  ws.send(JSON.stringify({ type: "CONNECTION_ESTABLISHED", status: "STRACE_DIAGNOSTIC_READY" }));

  ws.on("message", (message) => {
    try {
        const data = JSON.parse(message.toString());
        if (data.type === "START_MATCH") {
          console.log("[DIAG] Received START_MATCH signal. Running strace diagnostic.");
          const { deck1, deck2 } = data.payload;
          startForgeSimulation(ws, deck1, deck2);
        }
    } catch (e) {
        console.error("[WSS] Failed to parse incoming WebSocket message:", e);
    }
  });

  ws.on("close", () => console.log("[WSS] Client disconnected."));
});

// --- strace Diagnostic Simulation Logic ---
function startForgeSimulation(ws: WebSocket, deck1: any, deck2: any) {
  simulationStatus = "running";
  const jarPath = path.join(APP_DIR, "forgeSim.jar");

  // Deck file writing is still necessary for the Java command to be valid.
  try {
    fs.writeFileSync(path.join(FORGE_DECKS_DIR, deck1.filename), deck1.content);
    fs.writeFileSync(path.join(FORGE_DECKS_DIR, deck2.filename), deck2.content);
  } catch(e) {
    console.error(`[SIM] FATAL: Failed to write deck files.`, e);
    simulationStatus = "idle";
    return;
  }
  
  // The command to run is 'strace'. The rest of the command is its arguments.
  const commandToRun = "strace";
  const commandArgs = [
      "-f", // Follow any child processes forked by Java
      "java",
      `-Djava.awt.headless=true`,
      `-Dforge.home=${APP_DIR}`,
      "-jar",
      jarPath,
      "sim",
      "-d", deck1.filename, 
      "-d", deck2.filename,
      "-a", deck1.aiProfile, 
      "-a", deck2.aiProfile,
      "-l", "gamelog.txt", 
      "-n", "1",
  ];

  console.log(`[DIAGNOSTIC] Spawning process with command: ${commandToRun} ${commandArgs.join(' ')}`);

  const diagnosticProcess = spawn(commandToRun, commandArgs, { cwd: APP_DIR });

  diagnosticProcess.on('error', (err) => {
      console.error('[SPAWN_ERROR] Failed to start strace process.', err);
      broadcast({ type: "ERROR", message: "Critical error: Failed to start the diagnostic tool." });
      simulationStatus = "idle";
  });

  // `strace` prints all its output to STDERR. This is now our primary log.
  diagnosticProcess.stderr.on('data', (data) => {
      // We log this directly to the console. It will be very verbose.
      console.log(`[STRACE_OUTPUT]: ${data.toString()}`);
  });

  diagnosticProcess.on("close", (code) => {
    console.log(`[DIAGNOSTIC] strace process exited with code ${code}`);
    simulationStatus = "finished";
    broadcast({ type: "DIAGNOSTIC_COMPLETE", message: `Diagnostic finished. Check server logs for STRACE_OUTPUT.` });
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

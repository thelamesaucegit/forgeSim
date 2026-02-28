import { WebSocketServer, WebSocket } from "ws";
import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { parseLogLine, getInitialState, GameState } from "./parser.js";

// --- Server State ---
let simulationStatus: "idle" | "running" | "finished" = "idle";
let activeGameState: GameState = getInitialState();

// --- WebSocket Server Setup ---
const wss = new WebSocketServer({ port: 8080 });
const APP_DIR = process.cwd();

// Based on your Java fix, this is the correct, final location for user decks.
const FORGE_DECKS_DIR = path.join(APP_DIR, "decks", "constructed");

console.log(`[INIT] Sidecar WebSocket server started on port 8080.`);
console.log(`[INIT] Decks will be written to the correct user data directory: ${FORGE_DECKS_DIR}`);

if (!fs.existsSync(FORGE_DECKS_DIR)) {
    fs.mkdirSync(FORGE_DECKS_DIR, { recursive: true });
}

wss.on("connection", (ws) => {
  console.log("[WSS] Client connected.");
  ws.send(JSON.stringify({ type: "CONNECTION_ESTABLISHED", status: simulationStatus, state: activeGameState }));

  ws.on("message", (message) => {
    try {
        const data = JSON.parse(message.toString());
        if (data.type === "START_MATCH") {
          const { deck1, deck2 } = data.payload;
          activeGameState = getInitialState();
          startForgeSimulation(ws, deck1, deck2);
        }
    } catch (e) {
        console.error("[WSS] Failed to parse incoming WebSocket message:", e);
    }
  });
});

// --- Final Production Simulation Logic ---
function startForgeSimulation(ws: WebSocket, deck1: any, deck2: any) {
  simulationStatus = "running";
  const jarPath = path.join(APP_DIR, "forgeSim.jar");

  // Write decks to the correct location.
  try {
    const deck1Path = path.join(FORGE_DECKS_DIR, deck1.filename);
    const deck2Path = path.join(FORGE_DECKS_DIR, deck2.filename);
    fs.writeFileSync(deck1Path, deck1.content);
    fs.writeFileSync(deck2Path, deck2.content);
    console.log(`[SIM] Wrote deck files to: ${FORGE_DECKS_DIR}`);
  } catch(e: any) {
    console.error(`[SIM] FATAL: Failed during deck file write.`, e.message);
    simulationStatus = "idle";
    return;
  }

  broadcast({ type: "SIMULATION_STARTING" });

  // --- THE FINAL, VERIFIED COMMAND ---
  // This command is a direct translation of your locally-tested, working command,
  // plus the necessary environmental flags for the Docker container.
  const javaArgs = [
      "-Xmx1024m",                // Set max heap size
      `-Djava.awt.headless=true`,   // Required for headless server environment
      `-Dforge.home=${APP_DIR}`,    // Sets the user data directory root to /app
      "-jar",
      jarPath,
      "sim",
      "-d", deck1.filename,       // Filename only
      "-d", deck2.filename,       // Filename only
      "-a", deck1.aiProfile,      // AI Profile for deck 1
      "-a", deck2.aiProfile,      // AI Profile for deck 2
      "-n", "1",                  // Run 1 game
  ];

  console.log(`[SIM] Spawning Java process with final command: java ${javaArgs.join(' ')}`);
  const forgeProcess = spawn("java", javaArgs, { cwd: APP_DIR });

  // The application prints its log to standard output.
  forgeProcess.stdout.on('data', (data) => {
    processLogChunk(data.toString());
  });

  forgeProcess.stderr.on('data', (data) => {
      console.error(`[FORGE_STDERR]: ${data.toString()}`);
      broadcast({ type: "ERROR", message: `Forge Error: ${data.toString()}` });
  });

  const processLogChunk = (chunk: string) => {
    const lines = chunk.split('\n').filter(line => line.trim() !== '');
    for (const line of lines) {
        console.log(`[RAW_FORGE_LOG]: ${line}`);
        const updatedState = parseLogLine(line, activeGameState);
        if (updatedState) {
            activeGameState = updatedState;
            broadcast({ type: "STATE_UPDATE", state: activeGameState });
        }
    }
  };

  forgeProcess.on("close", (code) => {
    console.log(`[SIM] Forge process exited with code ${code}`);
    simulationStatus = "finished";
    broadcast({ type: "SIMULATION_COMPLETE", finalState: activeGameState });
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

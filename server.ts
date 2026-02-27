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
const FORGE_DECKS_DIR = path.join(APP_DIR, "res", "decks", "constructed");

console.log(`[INIT] Sidecar WebSocket server started on port 8080.`);
console.log(`[INIT] Application root directory: ${APP_DIR}`);

// On startup, ensure the decks directory exists.
if (!fs.existsSync(FORGE_DECKS_DIR)) {
    console.log(`[INIT] Decks directory not found. Creating it...`);
    fs.mkdirSync(FORGE_DECKS_DIR, { recursive: true });
}

wss.on("connection", (ws) => {
  console.log("[WSS] Client connected.");
  ws.send(JSON.stringify({ type: "CONNECTION_ESTABLISHED", status: simulationStatus, state: activeGameState }));

  ws.on("message", (message) => {
    try {
        const data = JSON.parse(message.toString());
        if (data.type === "START_MATCH") {
          if (simulationStatus === "running") {
            ws.send(JSON.stringify({ type: "ERROR", message: "A match is already in progress." }));
            return;
          }
          const { deck1, deck2 } = data.payload;
          activeGameState = getInitialState();
          startForgeSimulation(ws, deck1, deck2);
        }
    } catch (e) {
        console.error("[WSS] Failed to parse incoming WebSocket message:", e);
    }
  });
});

// --- Forge Simulation Logic ---
function startForgeSimulation(ws: WebSocket, deck1: any, deck2: any) {
  simulationStatus = "running";
  const jarPath = path.join(APP_DIR, "forgeSim.jar");

  try {
    // --- THE "TWO-PLAYER TOURNAMENT" WORKAROUND ---
    // 1. Clean the decks directory to ensure only our two new decks are present.
    console.log(`[SIM] Cleaning directory: ${FORGE_DECKS_DIR}`);
    fs.rmSync(FORGE_DECKS_DIR, { recursive: true, force: true });
    fs.mkdirSync(FORGE_DECKS_DIR, { recursive: true });

    // 2. Write the new deck files into the clean directory.
    const deck1Path = path.join(FORGE_DECKS_DIR, deck1.filename);
    const deck2Path = path.join(FORGE_DECKS_DIR, deck2.filename);
    console.log(`[SIM] Writing deck 1 to: ${deck1Path}`);
    fs.writeFileSync(deck1Path, deck1.content);
    console.log(`[SIM] Writing deck 2 to: ${deck2Path}`);
    fs.writeFileSync(deck2Path, deck2.content);

  } catch(e: any) {
    console.error(`[SIM] FATAL: Failed during deck file write.`, e.message);
    simulationStatus = "idle";
    return;
  }

  broadcast({ type: "SIMULATION_STARTING" });

  // --- THE DEFINITIVE COMMAND STRUCTURE for Tournament Mode ---
  const javaArgs = [
      `-Djava.awt.headless=true`,
      `-Dforge.home=${APP_DIR}`,
      "-jar",
      jarPath,
      "sim",
      "-t", "RoundRobin",       // Use tournament mode
      "-p", "2",                // For a two-player game
      "-D", FORGE_DECKS_DIR,   // The absolute path to the directory containing the decks
      "-a", deck1.aiProfile,
      "-a", deck2.aiProfile,
      "-n", "1",                // Run 1 game per match in the tournament
  ];

  console.log(`[SIM] Spawning Java process with command: java ${javaArgs.join(' ')}`);
  const forgeProcess = spawn("java", javaArgs, { cwd: APP_DIR });

  // Listen to stdout for the game log, as defined by SimulateMatch.java
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
        // We can now re-enable the parser and state updates
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

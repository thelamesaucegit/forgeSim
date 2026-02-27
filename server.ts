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

  ws.on("close", () => console.log("[WSS] Client disconnected."));
});

// --- Forge Simulation Logic ---
function startForgeSimulation(ws: WebSocket, deck1: any, deck2: any) {
  simulationStatus = "running";
  const jarPath = path.join(APP_DIR, "forgeSim.jar");

  // --- DIAGNOSTIC STEP 1: Verify Deck File Writing ---
  try {
    const deck1Path = path.join(FORGE_DECKS_DIR, deck1.filename);
    console.log(`[DIAGNOSTIC] Writing deck 1 to: ${deck1Path}`);
    fs.writeFileSync(deck1Path, deck1.content);
    const deck1ReadBack = fs.readFileSync(deck1Path, 'utf8');
    console.log(`[DIAGNOSTIC] Read back deck 1 content:\n---\n${deck1ReadBack}\n---`);
    if (deck1ReadBack.trim() !== deck1.content.trim()) {
        throw new Error("Deck 1 content mismatch after writing!");
    }

    const deck2Path = path.join(FORGE_DECKS_DIR, deck2.filename);
    console.log(`[DIAGNOSTIC] Writing deck 2 to: ${deck2Path}`);
    fs.writeFileSync(deck2Path, deck2.content);
    const deck2ReadBack = fs.readFileSync(deck2Path, 'utf8');
    console.log(`[DIAGNOSTIC] Read back deck 2 content:\n---\n${deck2ReadBack}\n---`);
    if (deck2ReadBack.trim() !== deck2.content.trim()) {
        throw new Error("Deck 2 content mismatch after writing!");
    }
    console.log("[DIAGNOSTIC] Deck file write/read verification successful.");

  } catch(e: any) {
    console.error(`[DIAGNOSTIC] FATAL: Failed during deck file write/read verification.`, e.message);
    simulationStatus = "idle";
    return;
  }

  broadcast({ type: "SIMULATION_STARTING" });

  const deck1RelativePath = path.join("res", "decks", "constructed", deck1.filename);
  const deck2RelativePath = path.join("res", "decks", "constructed", deck2.filename);

  // --- DIAGNOSTIC STEP 2: Be Explicit with AI Profile Names ---
  const javaArgs = [
      `-Djava.awt.headless=true`,
      `-Dforge.home=${APP_DIR}`,
      "-jar",
      jarPath,
      "sim",
      "-d", deck1RelativePath,
      "-d", deck2RelativePath,
      "-a", deck1.aiProfile + ".ai", // Add the .ai extension
      "-a", deck2.aiProfile + ".ai", // Add the .ai extension
      "-n", "1",
  ];

  console.log(`[SIM] Spawning Java process with command: java ${javaArgs.join(' ')}`);
  const forgeProcess = spawn("java", javaArgs, { cwd: APP_DIR });

  forgeProcess.stdout.on('data', (data) => {
    processLogChunk(data.toString());
  });

  forgeProcess.stderr.on('data', (data) => {
      console.error(`[FORGE_STDERR]: ${data.toString()}`);
      broadcast({ type: "ERROR", message: `Forge Error: ${data.toString()}` });
  });

  forgeProcess.on('error', (err) => {
      console.error('[SPAWN_ERROR] Failed to start Java process.', err);
      simulationStatus = "idle";
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

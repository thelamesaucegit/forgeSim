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
console.log(`[INIT] Sidecar WebSocket server started on port 8080.`);
const APP_DIR = process.cwd();
console.log(`[INIT] Application root directory: ${APP_DIR}`);

const FORGE_DECKS_DIR = path.join(APP_DIR, "res", "decks", "constructed");
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

  try {
    const deck1Path = path.join(FORGE_DECKS_DIR, deck1.filename);
    const deck2Path = path.join(FORGE_DECKS_DIR, deck2.filename);
    console.log(`[SIM] Writing deck 1 to: ${deck1Path}`);
    fs.writeFileSync(deck1Path, deck1.content);
    console.log(`[SIM] Writing deck 2 to: ${deck2Path}`);
    fs.writeFileSync(deck2Path, deck2.content);
  } catch(e) {
    console.error(`[SIM] FATAL: Failed to write deck files.`, e);
    simulationStatus = "idle";
    return;
  }

  broadcast({ type: "SIMULATION_STARTING" });

  const deck1RelativePath = path.join("res", "decks", "constructed", deck1.filename);
  const deck2RelativePath = path.join("res", "decks", "constructed", deck2.filename);

  // --- THE FINAL, CORRECTED COMMAND ---
  // The '-l' flag is removed entirely. We will listen to STDOUT instead.
  const javaArgs = [
      `-Djava.awt.headless=true`,
      `-Dforge.home=${APP_DIR}`,
      "-jar",
      jarPath,
      "sim",
      "-d", deck1RelativePath,
      "-d", deck2RelativePath,
      "-a", deck1.aiProfile,
      "-a", deck2.aiProfile,
      "-n", "1", // Simulate 1 game
  ];

  console.log(`[SIM] Spawning Java process with command: java ${javaArgs.join(' ')}`);
  const forgeProcess = spawn("java", javaArgs, { cwd: APP_DIR });

  // --- THE FINAL, CORRECTED LOGIC ---
  // We now listen to 'stdout' for the game log, not a file.
  forgeProcess.stdout.on('data', (data) => {
    const chunk = data.toString();
    // Pass the raw chunk from stdout directly to our log processor.
    processLogChunk(chunk);
  });

  forgeProcess.stderr.on('data', (data) => {
      // Any output here is a true Java error.
      console.error(`[FORGE_STDERR]: ${data.toString()}`);
      broadcast({ type: "ERROR", message: `Forge Error: ${data.toString()}` });
  });

  forgeProcess.on('error', (err) => {
      console.error('[SPAWN_ERROR] Failed to start Java process.', err);
      broadcast({ type: "ERROR", message: "Critical error: Failed to start the simulation engine." });
      simulationStatus = "idle";
  });

  const processLogChunk = (chunk: string) => {
    const lines = chunk.split('\n').filter(line => line.trim() !== '');
    for (const line of lines) {
        // We no longer need to prefix this, as stdout is now dedicated to the game log.
        // console.log(`[RAW_FORGE_LOG]: ${line}`); 
        
        // This is a temporary filter to reduce noise. We can remove it later.
        if (line.startsWith("GAME") || line.startsWith("STACK") || line.startsWith("TURN")) {
            const updatedState = parseLogLine(line, activeGameState);
            if (updatedState) {
                activeGameState = updatedState;
                broadcast({ type: "STATE_UPDATE", state: activeGameState });
            }
        }
    }
  };

  forgeProcess.on("close", (code) => {
    console.log(`[SIM] Forge process exited with code ${code}`);
    simulationStatus = "finished";
    // The final result is always the last thing printed to stdout.
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

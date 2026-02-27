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
console.log(`[INIT] Sidecar WebSocket server started on port 8080.`);
console.log(`[INIT] Application root directory: ${APP_DIR}`);

// --- THE COMBINED SOLUTION: Create expected user directories ---
try {
    const userDir = path.join(APP_DIR, ".forge");
    const cacheDir = path.join(APP_DIR, ".cache", "forge");

    if (!fs.existsSync(userDir)) {
        console.log(`[INIT] Creating expected user directory: ${userDir}`);
        fs.mkdirSync(userDir, { recursive: true });
    }
    if (!fs.existsSync(cacheDir)) {
        console.log(`[INIT] Creating expected cache directory: ${cacheDir}`);
        fs.mkdirSync(cacheDir, { recursive: true });
    }
} catch (e: any) {
    console.error(`[INIT] FATAL: Could not create user directories.`, e.message);
}

wss.on("connection", (ws) => {
  console.log("[WSS] Client connected.");
  ws.send(JSON.stringify({ type: "CONNECTION_ESTABLISHED", status: simulationStatus, state: activeGameState }));

  ws.on("message", (message) => {
    try {
        const data = JSON.parse(message.toString());
        if (data.type === "START_MATCH") {
          console.log("[DIAG] Received START_MATCH signal. Running final test.");
          activeGameState = getInitialState();
          startForgeSimulation(ws);
        }
    } catch (e) { console.error("[WSS] Failed to parse incoming WebSocket message:", e); }
  });
});

// --- Final Test Simulation Logic ---
function startForgeSimulation(ws: WebSocket) {
  simulationStatus = "running";
  const jarPath = path.join(APP_DIR, "forgeSim.jar");

  broadcast({ type: "SIMULATION_STARTING" });

  const knownGoodDecksDir = path.join(APP_DIR, "res", "geneticaidecks");

  // --- THE COMBINED SOLUTION: Add memory flag and use known-good data ---
  const javaArgs = [
      "-Xmx1024m",              // Explicitly set max heap size to 1GB
      `-Djava.awt.headless=true`,
      `-Dforge.home=${APP_DIR}`,
      "-jar",
      jarPath,
      "sim",
      "-t", "RoundRobin",
      "-p", "2",
      "-D", knownGoodDecksDir,
      "-n", "1",
  ];

  console.log(`[DIAG] Spawning Java process with final command: java ${javaArgs.join(' ')}`);
  const forgeProcess = spawn("java", javaArgs, { cwd: APP_DIR });

  forgeProcess.stdout.on('data', (data) => {
    processLogChunk(data.toString());
  });

  forgeProcess.stderr.on('data', (data) => {
      console.error(`[FORGE_STDERR]: ${data.toString()}`);
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
    console.log(`[DIAG] Final test exited with code ${code}`);
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

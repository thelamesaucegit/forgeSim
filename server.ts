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

wss.on("connection", (ws) => {
  console.log("[WSS] Client connected.");
  ws.send(JSON.stringify({ type: "CONNECTION_ESTABLISHED", status: simulationStatus, state: activeGameState }));

  ws.on("message", (message) => {
    try {
        const data = JSON.parse(message.toString());
        if (data.type === "START_MATCH") {
          console.log("[DIAG] Received START_MATCH signal. Running 'Known-Good Data' test.");
          activeGameState = getInitialState();
          // We don't need deck payload, but we call the function to start the process.
          startForgeSimulation(ws);
        }
    } catch (e) { console.error("[WSS] Failed to parse incoming WebSocket message:", e); }
  });
});

// --- "Known-Good Data" Simulation Logic ---
function startForgeSimulation(ws: WebSocket) {
  simulationStatus = "running";
  const jarPath = path.join(APP_DIR, "forgeSim.jar");

  broadcast({ type: "SIMULATION_STARTING" });

  // --- THE "KNOWN-GOOD DATA" COMMAND ---
  // We use tournament mode to point to the built-in genetic AI decks directory.
  // We do not pass deck names or AI profiles. The app will use all decks in the directory.
  const knownGoodDecksDir = path.join(APP_DIR, "res", "geneticaidecks");

  const javaArgs = [
      `-Djava.awt.headless=true`,
      `-Dforge.home=${APP_DIR}`,
      "-jar",
      jarPath,
      "sim",
      "-t", "RoundRobin",   // Run a tournament
      "-p", "2",              // with 2 players per match
      "-D", knownGoodDecksDir, // using the known-good decks directory
      "-n", "1",              // for 1 game per match
  ];

  console.log(`[DIAG] Spawning Java process with KNOWN-GOOD DATA command: java ${javaArgs.join(' ')}`);
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
    console.log(`[DIAG] "Known-Good Data" test exited with code ${code}`);
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

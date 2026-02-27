import { WebSocketServer, WebSocket } from "ws";
import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import chokidar from "chokidar";
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
console.log(`[INIT] Expecting decks directory at: ${FORGE_DECKS_DIR}`);

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
  console.log(`[SIM] Simulation status set to 'running'.`);

  const deck1Path = path.join(FORGE_DECKS_DIR, deck1.filename);
  const deck2Path = path.join(FORGE_DECKS_DIR, deck2.filename);
  const jarPath = path.join(APP_DIR, "forgeSim.jar");
  const logFileName = "gamelog.txt";
  const logFilePath = path.join(APP_DIR, logFileName);

  try {
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

  if (fs.existsSync(logFilePath)) {
    fs.unlinkSync(logFilePath);
  }
  
  // --- THIS IS THE FINAL, CORRECT COMMAND STRUCTURE ---
  // We use '-jar' because 'forge.view.Main' is the correct entry point.
  // The 'sim' command is an argument TO that entry point.
  const javaArgs = [
      "-jar",
      jarPath,
      "sim",
      "-d", deck1.filename, 
      "-d", deck2.filename,
      "-a", deck1.aiProfile,
      "-a", deck2.aiProfile,
      "-l", logFileName,
      "-n", "1",
  ];

  console.log(`[SIM] Spawning Java process with command: java ${javaArgs.join(' ')}`);

  // We run the process from the application's root directory, where the JAR and 'res' folder are located.
  const forgeProcess = spawn("java", javaArgs, { cwd: APP_DIR });

  forgeProcess.on('error', (err) => {
      console.error('[SPAWN_ERROR] Failed to start Java process.', err);
      broadcast({ type: "ERROR", message: "Critical error: Failed to start the simulation engine." });
      simulationStatus = "idle";
  });

  forgeProcess.stderr.on('data', (data) => {
      console.error(`[FORGE_STDERR]: ${data.toString()}`);
      broadcast({ type: "ERROR", message: `Forge Error: ${data.toString()}` });
  });

  // Watch for the log file in the application's root directory.
  const watcher = chokidar.watch(logFilePath, {
      persistent: true, usePolling: true, interval: 100
  });

  console.log(`[SIM] Watching for log file at: ${logFilePath}`);

  let lastSize = 0;
  watcher.on("change", (changedPath) => {
    fs.stat(changedPath, (err, stats) => {
        if (err) { console.error("Error stating file:", err); return; }
        if (stats.size > lastSize) {
            const stream = fs.createReadStream(changedPath, { start: lastSize, end: stats.size, encoding: 'utf8' });
            stream.on('data', (chunk) => processLogChunk(chunk.toString()));
            lastSize = stats.size;
        }
    });
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
    watcher.close();
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

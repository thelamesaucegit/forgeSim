import { WebSocketServer, WebSocket } from "ws";
// 1. Import 'exec' alongside 'spawn'
import { spawn, exec } from "child_process";
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
console.log(`[INIT] Current working directory: ${process.cwd()}`);

const FORGE_DECKS_DIR = path.join(process.cwd(), "res", "decks", "constructed");
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
        console.log(`[WSS] Received message of type: ${data.type}`);
        if (data.type === "START_MATCH") {
          if (simulationStatus === "running") {
            console.warn("[WSS] Received START_MATCH signal while a simulation is already running.");
            ws.send(JSON.stringify({ type: "ERROR", message: "A match is already in progress." }));
            return;
          }
          console.log("[WSS] Processing START_MATCH signal.");
          const { deck1, deck2 } = data.payload;
          activeGameState = getInitialState();
          startForgeSimulation(ws, deck1, deck2);
        }
    } catch (e) {
        console.error("[WSS] Failed to parse incoming WebSocket message:", e);
    }
  });

  ws.on("close", () => {
    console.log("[WSS] Client disconnected.");
  });
});

// --- Forge Simulation Logic ---
function startForgeSimulation(ws: WebSocket, deck1: any, deck2: any) {
  simulationStatus = "running";
  console.log(`[SIM] Simulation status set to 'running'.`);

  const deck1Path = path.join(FORGE_DECKS_DIR, deck1.filename);
  const deck2Path = path.join(FORGE_DECKS_DIR, deck2.filename);
  const jarPath = path.join(process.cwd(), "forgeSim.jar");
  const logFileName = "gamelog.txt";
  const logFilePath = path.join(process.cwd(), logFileName);

  try {
    console.log(`[SIM] Writing deck files...`);
    fs.writeFileSync(deck1Path, deck1.content);
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

  const diagnosticCommand = `unzip -p ${jarPath} META-INF/MANIFEST.MF`;
  console.log(`[DIAGNOSTIC] Running command: ${diagnosticCommand}`);
  exec(diagnosticCommand, (error, stdout, stderr) => {
    if (error) {
        console.error(`[DIAGNOSTIC] Failed to inspect JAR manifest: ${error.message}`);
        broadcast({ type: "ERROR", message: "Internal server error: Could not inspect simulation engine." });
        simulationStatus = "idle";
        return;
    }
    console.log(`[DIAGNOSTIC] JAR Manifest Contents:\n---\n${stdout.trim()}\n---`);
    
    runForgeProcess(ws, deck1, deck2, jarPath, logFileName, logFilePath);
  });
}

function runForgeProcess(ws: WebSocket, deck1: any, deck2: any, jarPath: string, logFileName: string, logFilePath: string) {
    const javaArgs = [
        "-Xdiag", 
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

    if (!fs.existsSync(jarPath)) {
        console.error(`[SIM] FATAL: Cannot find forgeSim.jar at ${jarPath}`);
        simulationStatus = "idle";
        return;
    }

    const forgeProcess = spawn("java", javaArgs, { cwd: FORGE_DECKS_DIR });

    forgeProcess.on('error', (err) => {
        console.error('[SPAWN_ERROR] Failed to start Java process.', err);
        broadcast({ type: "ERROR", message: "Critical error: Failed to start the simulation engine." });
        simulationStatus = "idle";
    });

    forgeProcess.stderr.on('data', (data) => {
        console.error(`[FORGE_STDERR_VERBOSE]: ${data.toString()}`);
        broadcast({ type: "ERROR", message: `Forge Error: ${data.toString()}` });
    });

    // 2. The watcher and process handlers must be part of this function
    const watcher = chokidar.watch(logFilePath, {
        persistent: true,
        usePolling: true,
        interval: 100,
        cwd: FORGE_DECKS_DIR
    });

    console.log(`[SIM] Watching for log file at: ${logFilePath}`);

    let lastSize = 0;
    watcher.on("change", (path) => {
        const fullLogPath = path.isAbsolute(path) ? path : logFilePath;
        fs.stat(fullLogPath, (err, stats) => {
            if (err) { console.error("Error stating file:", err); return; }
            if (stats.size > lastSize) {
                const stream = fs.createReadStream(fullLogPath, { start: lastSize, end: stats.size, encoding: 'utf8' });
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
        console.log(`[SIM] Forge process exited with code 

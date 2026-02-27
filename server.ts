import { WebSocketServer, WebSocket } from "ws";
import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import chokidar from "chokidar";
import { parseLogLine, getInitialState, GameState } from "./parser.js";

let simulationStatus: "idle" | "running" | "finished" = "idle";
let activeGameState: GameState = getInitialState();

const wss = new WebSocketServer({ port: 8080 });
console.log(`[INIT] Sidecar WebSocket server started on port 8080.`);
console.log(`[INIT] Current working directory: ${process.cwd()}`);

// Define the directory inside the container where Forge expects to find custom decks
const FORGE_DECKS_DIR = path.join(process.cwd(), "res", "decks", "constructed");
console.log(`[INIT] Expecting decks directory at: ${FORGE_DECKS_DIR}`);

// Ensure this directory exists when the server starts up.
if (!fs.existsSync(FORGE_DECKS_DIR)) {
    console.log(`[INIT] Decks directory not found. Creating it...`);
    fs.mkdirSync(FORGE_DECKS_DIR, { recursive: true });
}

// The directory inside the container where Forge expects decks
const FORGE_DECKS_DIR = path.join(process.cwd(), "res", "decks", "constructed");

// Ensure the directory exists when the server starts
if (!fs.existsSync(FORGE_DECKS_DIR)) {
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
          // Extract the dynamic payload from the message
          const { deck1, deck2 } = data.payload;
          // Reset game state for the new match
          activeGameState = getInitialState();
          // Pass the deck data to the simulation function
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
// The function now accepts the dynamic deck data from the WebSocket message
function startForgeSimulation(ws: WebSocket, deck1: any, deck2: any) {
  simulationStatus = "running";
  console.log(`[SIM] Simulation status set to 'running'.`);


  const jarPath = path.join(process.cwd(), "forgeSim.jar");
  const logFileName = "gamelog.txt"; // Forge needs just the filename for the -l flag
  const logFilePath = path.join(process.cwd(), logFileName);

  // Attempt to write the received deck strings to local files for Forge to use
  try {
    console.log(`[SIM] Writing deck 1 to: ${deck1Path}`);
    fs.writeFileSync(deck1Path, deck1.content);
    console.log(`[SIM] Writing deck 2 to: ${deck2Path}`);
    fs.writeFileSync(deck2Path, deck2.content);
  } catch(e) {
    console.error(`[SIM] FATAL: Failed to write deck files.`, e);
    broadcast({ type: "ERROR", message: "Internal server error: Could not write deck files." });
    simulationStatus = "idle";
    return;
  }

  broadcast({ type: "SIMULATION_STARTING" });

  // Clean up log file from previous runs
  if (fs.existsSync(logFilePath)) {
    fs.unlinkSync(logFilePath);
  }

  // Construct the arguments for the Java process
  const javaArgs = [
    "-jar",
    jarPath,
    "sim",
    "-d", deck1.filename, deck2.filename,
    "-a", deck1.aiProfile, deck2.aiProfile, 
    "-l", logFileName,
    "-n", "1",
  ];

  console.log(`[SIM] Spawning Java process with command: java ${javaArgs.join(' ')}`);
  
  // Pre-flight check: Verify all necessary files exist before attempting to spawn
  if (!fs.existsSync(jarPath)) {
      console.error(`[SIM] FATAL: Cannot find forgeSim.jar at ${jarPath}`);
      broadcast({ type: "ERROR", message: "Internal server error: The forgeSim.jar executable was not found." });
      simulationStatus = "idle";
      return;
  }

  const forgeProcess = spawn("java", javaArgs);

  // Listen for errors during the process spawn itself (e.g., 'java' command not found)
  forgeProcess.on('error', (err) => {
    console.error('[SPAWN_ERROR] Failed to start Java process.', err);
    broadcast({ type: "ERROR", message: "Critical error: Failed to start the simulation engine." });
    simulationStatus = "idle";
  });

  // Use chokidar to watch the log file for new data
  const watcher = chokidar.watch(logFilePath, {
    persistent: true,
    usePolling: true, // Necessary for some container/filesystem environments
    interval: 100,
  });

  console.log(`[SIM] Watching for log file at: ${logFilePath}`);

  let lastSize = 0;
  watcher.on("change", (filePath) => {
    fs.stat(filePath, (err, stats) => {
      if (err) return;
      if (stats.size > lastSize) {
        const stream = fs.createReadStream(filePath, { start: lastSize, end: stats.size, encoding: "utf8" });
        stream.on("data", (chunk) => processLogChunk(chunk.toString()));
        lastSize = stats.size;
      }
    });
  });

  // Processes new chunks of text from the gamelog.txt
  const processLogChunk = (chunk: string) => {
    const lines = chunk.split("\n").filter(line => line.trim() !== "");
    for (const line of lines) {
      console.log(`[RAW_FORGE_LOG]: ${line}`);
      const updatedState = parseLogLine(line, activeGameState);
      if (updatedState) {
        activeGameState = updatedState;
        broadcast({ type: "STATE_UPDATE", state: activeGameState });
      }
    }
  };

  // Handles the completion of the Forge process
  forgeProcess.on("close", (code) => {
    console.log(`[SIM] Forge process exited with code ${code}`);
    simulationStatus = "finished";
    broadcast({ type: "SIMULATION_COMPLETE", finalState: activeGameState });
    watcher.close(); // Stop watching the file
  });

  // Captures and broadcasts any errors from the Java process
  forgeProcess.stderr.on('data', (data) => {
    const errorMessage = data.toString();
    console.error(`[FORGE_STDERR]: ${errorMessage}`);
    broadcast({ type: "ERROR", message: `Forge Error: ${errorMessage}` });
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

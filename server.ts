import { WebSocketServer, WebSocket } from "ws";
import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import chokidar from "chokidar";
// THE FIX IS HERE: The path should not include './app/'.
import { parseLogLine, getInitialState, GameState } from "./parser.js";

// --- Server State ---
let simulationStatus: "idle" | "running" | "finished" = "idle";
let activeGameState: GameState = getInitialState();

// --- WebSocket Server Setup ---
const wss = new WebSocketServer({ port: 8080 });
console.log("Sidecar WebSocket server started on port 8080");

wss.on("connection", (ws) => {
  console.log("Client connected");
  ws.send(JSON.stringify({ type: "CONNECTION_ESTABLISHED", status: simulationStatus, state: activeGameState }));

  ws.on("message", (message) => {
    const messageString = message.toString();
    if (messageString === "START_MATCH") {
      if (simulationStatus === "running") {
        ws.send(JSON.stringify({ type: "ERROR", message: "A match is already in progress." }));
        return;
      }
      activeGameState = getInitialState();
      startForgeSimulation(ws);
    }
  });

  ws.on("close", () => {
    console.log("Client disconnected");
  });
});

// --- Forge Simulation Logic ---
function startForgeSimulation(ws: WebSocket) {
  simulationStatus = "running";
  const logFileName = "gamelog.txt";
  const logFilePath = path.join(process.cwd(), logFileName);

  broadcast({ type: "SIMULATION_STARTING" });

  if (fs.existsSync(logFilePath)) {
    fs.unlinkSync(logFilePath);
  }

  const deck1 = "creeps-deck.dck";
  const deck2 = "ninja-deck.dck";
  const aiProfile1 = "Control";
  const aiProfile2 = "Aggro";

  const forgeProcess = spawn("java", [
    "-jar",
    "forgeSim.jar",
    "sim",
    "-d", deck1, deck2,
    "-a", aiProfile1, aiProfile2,
    "-l", logFileName,
    "-n", "1",
  ]);

  const watcher = chokidar.watch(logFilePath, {
    persistent: true,
    usePolling: true,
    interval: 100,
  });

  console.log(`Watching for log file at: ${logFilePath}`);

  let lastSize = 0;
  watcher.on("change", (path) => {
    fs.stat(path, (err, stats) => {
      if (err) {
        console.error("Error stating file:", err);
        return;
      }
      if (stats.size > lastSize) {
        const stream = fs.createReadStream(path, { start: lastSize, end: stats.size, encoding: 'utf8' });
        stream.on('data', (chunk) => processLogChunk(chunk.toString()));
        lastSize = stats.size;
      }
    });
  });

  const processLogChunk = (chunk: string) => {
    const lines = chunk.split('\n').filter(line => line.trim() !== '');
    for (const line of lines) {
      console.log(`[RAW LOG]: ${line}`);
      const updatedState = parseLogLine(line, activeGameState);
      if (updatedState) {
        activeGameState = updatedState;
        broadcast({ type: "STATE_UPDATE", state: activeGameState });
      }
    }
  };

  forgeProcess.on("close", (code) => {
    console.log(`Forge process exited with code ${code}`);
    simulationStatus = "finished";
    broadcast({ type: "SIMULATION_COMPLETE", finalState: activeGameState });
    watcher.close();
  });

  forgeProcess.stderr.on('data', (data) => {
    console.error(`Forge STDERR: ${data}`);
    broadcast({ type: "ERROR", message: `Forge Error: ${data}` });
  });
}

// --- Helper to Broadcast to All Connected Clients ---
function broadcast(data: object) {
  const payload = JSON.stringify(data);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
}
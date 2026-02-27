import { WebSocketServer, WebSocket } from "ws";
import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import chokidar from "chokidar";
import { parseLogLine, getInitialState, GameState } from "./parser.js";

let simulationStatus: "idle" | "running" | "finished" = "idle";
let activeGameState: GameState = getInitialState();

const wss = new WebSocketServer({ port: 8080 });
console.log("Sidecar WebSocket server started on port 8080");

// The directory inside the container where Forge expects decks
const FORGE_DECKS_DIR = path.join(process.cwd(), "res", "decks", "constructed");

// Ensure the directory exists when the server starts
if (!fs.existsSync(FORGE_DECKS_DIR)) {
    fs.mkdirSync(FORGE_DECKS_DIR, { recursive: true });
}

wss.on("connection", (ws) => {
  console.log("Client connected");
  ws.send(JSON.stringify({ type: "CONNECTION_ESTABLISHED", status: simulationStatus, state: activeGameState }));

  ws.on("message", (message) => {
    try {
        const data = JSON.parse(message.toString());

        if (data.type === "START_MATCH") {
          if (simulationStatus === "running") {
            ws.send(JSON.stringify({ type: "ERROR", message: "A match is already in progress." }));
            return;
          }

          // Extract the payload sent from Next.js
          const { deck1, deck2 } = data.payload;

          // Write the string contents to local .dck files inside the container
          fs.writeFileSync(path.join(FORGE_DECKS_DIR, deck1.filename), deck1.content);
          fs.writeFileSync(path.join(FORGE_DECKS_DIR, deck2.filename), deck2.content);

          activeGameState = getInitialState();
          
          // Pass the data to the simulation function
          startForgeSimulation(ws, deck1, deck2);
        }
    } catch (e) {
        console.error("Failed to parse incoming WebSocket message:", e);
    }
  });

  ws.on("close", () => {
    console.log("Client disconnected");
  });
});

// Update function signature to accept the dynamic deck data
function startForgeSimulation(ws: WebSocket, deck1: any, deck2: any) {
  simulationStatus = "running";
  const logFileName = "gamelog.txt";
  const logFilePath = path.join(process.cwd(), logFileName);

  broadcast({ type: "SIMULATION_STARTING" });

  if (fs.existsSync(logFilePath)) {
    fs.unlinkSync(logFilePath);
  }

  // Use the dynamic variables passed from Next.js
  const forgeProcess = spawn("java", [
    "-jar",
    "forgeSim.jar",
    "sim",
    "-d", deck1.filename, deck2.filename,
    "-a", deck1.aiProfile, deck2.aiProfile, 
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

  const processLogChunk = (chunk: string) => {
    const lines = chunk.split("\n").filter(line => line.trim() !== "");
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

  forgeProcess.stderr.on("data", (data) => {
    console.error(`Forge STDERR: ${data}`);
    broadcast({ type: "ERROR", message: `Forge Error: ${data}` });
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

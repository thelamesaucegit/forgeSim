import { WebSocketServer, WebSocket } from "ws";
import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";

const APP_DIR = process.cwd();
// This is the correct user data path based on your fix to ForgeProfileProperties.java
const FORGE_DECKS_DIR = path.join(APP_DIR, "decks", "constructed");

// --- WebSocket Server Setup ---
const wss = new WebSocketServer({ port: 8080 });
console.log(`[INIT] Sidecar WebSocket server started on port 8080.`);
wss.on('listening', () => console.log('[HEALTH_CHECK] Server is listening on port 8080.'));
if (!fs.existsSync(FORGE_DECKS_DIR)) {
    fs.mkdirSync(FORGE_DECKS_DIR, { recursive: true });
}

wss.on("connection", (ws) => {
  console.log("[WSS] Client connected.");
  ws.send(JSON.stringify({ type: "CONNECTION_ESTABLISHED", status: "DIAGNOSTIC_READY" }));
  ws.on("message", (message) => {
    try {
        const data = JSON.parse(message.toString());
        if (data.type === "START_MATCH") {
          console.log("[DIAG] Received START_MATCH signal. Running final diagnostic.");
          startDiagnostic(ws, data.payload);
        }
    } catch (e) { console.error("[WSS] Failed to parse incoming WebSocket message:", e); }
  });
});

// --- The Final Diagnostic ---
function startDiagnostic(ws: WebSocket, payload: any) {
  const { deck1, deck2 } = payload;
  const jarPath = path.join(APP_DIR, "forgeSim.jar");

  // Write decks to the correct location
  try {
    fs.writeFileSync(path.join(FORGE_DECKS_DIR, deck1.filename), deck1.content);
    fs.writeFileSync(path.join(FORGE_DECKS_DIR, deck2.filename), deck2.content);
    console.log(`[DIAG] Deck files written to correct user data directory: ${FORGE_DECKS_DIR}`);
  } catch(e: any) {
    console.error(`[DIAG] FATAL: Failed during deck file write.`, e.message);
    ws.send(JSON.stringify({ type: "ERROR", message: "Failed to write deck files to disk." }));
    return;
  }

  // *** THE FIX IS HERE: We are now running the java command directly without strace ***
  const commandToRun = "java";
  
  const commandArgs = [
      "-verbose:class", // Keep verbose flag for detailed class loading output
      "-Xmx1024m",
      `-Djava.awt.headless=true`,
      `-Dforge.home=${APP_DIR}`,
      "-jar",
      jarPath,
      "sim",
      "-d", deck1.filename,
      "-d", deck2.filename,
      "-a", deck1.aiProfile, deck2.aiProfile,
      "-n", "1",
  ];

  console.log(`[DIAGNOSTIC] Spawning process with command: ${commandToRun} ${commandArgs.join(' ')}`);

  const diagnosticProcess = spawn(commandToRun, commandArgs, { cwd: APP_DIR });

  diagnosticProcess.on('error', (err) => {
    console.error('[FATAL_SPAWN_ERROR] Failed to start the simulation process.', err);
    broadcast({ type: "ERROR", message: 'Failed to start simulation process. Check server logs.' });
  });

  // The verbose java output will go to STDERR
  diagnosticProcess.stderr.on('data', (data) => {
      console.log(`[JVM_STDERR]: ${data.toString()}`);
  });

  // stdout will contain the actual forge simulation log if it succeeds
  diagnosticProcess.stdout.on('data', (data) => {
      console.log(`[FORGE_STDOUT]: ${data.toString()}`);
  });

  diagnosticProcess.on("close", (code) => {
    if (code === 0) {
      console.log(`[DIAGNOSTIC_SUCCESS] Process exited with code ${code}`);
      broadcast({ type: "DIAGNOSTIC_COMPLETE", success: true, message: `Diagnostic finished successfully.` });
    } else {
      console.error(`[DIAGNOSTIC_FAILURE] Process exited with non-zero code ${code}`);
      broadcast({ type: "DIAGNOSTIC_COMPLETE", success: false, message: `Diagnostic failed with exit code ${code}. Check server logs.` });
    }
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

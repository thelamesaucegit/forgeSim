import { WebSocketServer, WebSocket } from "ws";
import { spawn, exec } from "child_process";
import * as fs from "fs";
import * as path from "path";

// --- Minimal Server State for Diagnostics ---
const APP_DIR = process.cwd();
const FORGE_DECKS_DIR = path.join(APP_DIR, "res", "decks", "constructed");

// --- WebSocket Server Setup ---
const wss = new WebSocketServer({ port: 8080 });
console.log(`[INIT] Sidecar WebSocket server started on port 8080.`);
console.log(`[INIT] Application root directory: ${APP_DIR}`);

if (!fs.existsSync(FORGE_DECKS_DIR)) {
    console.log(`[INIT] Decks directory not found. Creating it...`);
    fs.mkdirSync(FORGE_DECKS_DIR, { recursive: true });
}

wss.on("connection", (ws) => {
  console.log("[WSS] Client connected.");
  ws.send(JSON.stringify({ type: "CONNECTION_ESTABLISHED", status: "FINAL_DIAGNOSTIC_READY" }));

  ws.on("message", (message) => {
    try {
        const data = JSON.parse(message.toString());
        if (data.type === "START_MATCH") {
          console.log("[DIAG] Received START_MATCH signal. Running final diagnostic sequence.");
          startFinalDiagnostic(ws, data.payload);
        }
    } catch (e) {
        console.error("[WSS] Failed to parse incoming WebSocket message:", e);
    }
  });
});

// --- Final Diagnostic Sequence ---
function startFinalDiagnostic(ws: WebSocket, payload: any) {
  const { deck1, deck2 } = payload;

  // 1. Verify deck file writing (we know this works, but we keep it for consistency)
  try {
    fs.writeFileSync(path.join(FORGE_DECKS_DIR, deck1.filename), deck1.content);
    fs.writeFileSync(path.join(FORGE_DECKS_DIR, deck2.filename), deck2.content);
    console.log("[DIAG] Deck files written successfully.");
  } catch(e: any) {
    console.error(`[DIAG] FATAL: Failed during deck file writing.`, e.message);
    return;
  }

  // 2. Verify AI file presence
  const aiDir = path.join(APP_DIR, "res", "ai");
  console.log(`[DIAG] Verifying contents of AI directory: ${aiDir}`);
  exec(`ls -l ${aiDir}`, (error, stdout, stderr) => {
    if (error) {
        console.error(`[DIAG] Failed to list AI directory: ${error.message}`);
        broadcast({ type: "ERROR", message: "Failed to verify AI file directory." });
        return;
    }
    console.log(`[DIAG] AI Directory Contents:\n---\n${stdout.trim()}\n---`);
    
    // 3. If AI files are present, run the strace command
    console.log("[DIAG] AI directory verified. Proceeding with strace.");
    runStraceDiagnostic(ws, payload);
  });
}

function runStraceDiagnostic(ws: WebSocket, payload: any) {
  const { deck1, deck2 } = payload;
  const jarPath = path.join(APP_DIR, "forgeSim.jar");
  const deck1RelativePath = path.join("res", "decks", "constructed", deck1.filename);
  const deck2RelativePath = path.join("res", "decks", "constructed", deck2.filename);

  const commandToRun = "strace";
  const commandArgs = [
      "-f",
      "java",
      `-Djava.awt.headless=true`,
      `-Dforge.home=${APP_DIR}`,
      "-jar",
      jarPath,
      "sim",
      "-d", deck1RelativePath,
      "-d", deck2RelativePath,
      "-a", deck1.aiProfile, // We revert to not adding .ai to see where it looks
      "-a", deck2.aiProfile,
      "-n", "1",
  ];

  console.log(`[DIAGNOSTIC] Spawning process with command: ${commandToRun} ${commandArgs.join(' ')}`);

  const diagnosticProcess = spawn(commandToRun, commandArgs, { cwd: APP_DIR });

  diagnosticProcess.stderr.on('data', (data) => {
      console.log(`[STRACE_OUTPUT]: ${data.toString()}`);
  });

  diagnosticProcess.on("close", (code) => {
    console.log(`[DIAGNOSTIC] strace process exited with code ${code}`);
    broadcast({ type: "DIAGNOSTIC_COMPLETE", message: `Diagnostic finished. Check server logs.` });
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

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
  const logFileName = "gamelog.txt";
  const logFilePath = path.join(APP_DIR, logFileName);

  try {
    fs.writeFileSync(path.join(FORGE_DECKS_DIR, deck1.filename), deck1.content);
    fs.writeFileSync(path.join(FORGE_DECKS_DIR, deck2.filename), deck2.content);
  } catch(e) {
    console.error(`[SIM] FATAL: Failed to write deck files.`, e);
    return;
  }

  broadcast({ type: "SIMULATION_STARTING" });

  if (fs.existsSync(logFilePath)) {
    fs.unlinkSync(logFilePath);
  }
  
  // --- The `strace` Diagnostic Command ---
  // We are now wrapping the entire `java` command with `strace`.
  // -f : Follow any child processes that are forked.
  // -o strace.log : Write the massive output to a file instead of flooding STDERR.
  // We then execute the original 'java' command as an argument to strace.
  const commandToRun = "strace";
  const commandArgs = [
      "-f", // Follow child processes
      "java",
      `-Djava.awt.headless=true`,
      `-Dforge.home=${APP_DIR}`,
      "-jar",
      jarPath,
      "sim",
      "-d", deck1.filename, "-d", deck2.filename,
      "-a", deck1.aiProfile, "-a", deck2.aiProfile,
      "-l", logFileName, "-n", "1",
  ];

  console.log(`[DIAGNOSTIC] Spawning process with command: ${commandToRun} ${commandArgs.join(' ')}`);

  const forgeProcess = spawn(commandToRun, commandArgs, { cwd: APP_DIR });

  forgeProcess.on('error', (err) => {
      console.error('[SPAWN_ERROR] Failed to start strace process.', err);
      broadcast({ type: "ERROR", message: "Critical error: Failed to start the diagnostic tool." });
  });

  // `strace` prints its output to STDERR by default. This is now our primary source of information.
  forgeProcess.stderr.on('data', (data) => {
      console.log(`[STRACE_OUTPUT]: ${data.toString()}`);
  });

  forgeProcess.on("close", (code) => {
    console.log(`[DIAGNOSTIC] strace process exited with code ${code}`);
    simulationStatus = "finished";
    broadcast({ type: "DIAGNOSTIC_COMPLETE", message: `Diagnostic finished with code ${code}. Check server logs for STRACE_OUTPUT.` });
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
import { WebSocketServer, WebSocket } from "ws";
import { spawn, exec } from "child_process";
import * as fs from "fs";
import * as path from "path";

// NOTE: chokidar and parser are not used in this diagnostic script, but kept for future use.
import chokidar from "chokidar";
import { parseLogLine, getInitialState, GameState } from "./parser.js";

const APP_DIR = process.cwd();

// --- WebSocket Server Setup ---
const wss = new WebSocketServer({ port: 8080 });
console.log(`[INIT] Sidecar WebSocket server started on port 8080.`);
console.log(`[INIT] Application root directory: ${APP_DIR}`);

wss.on("connection", (ws) => {
  console.log("[WSS] Client connected.");
  ws.send(JSON.stringify({ type: "CONNECTION_ESTABLISHED", status: "DIAGNOSTIC_READY" }));

  ws.on("message", (message) => {
    try {
        const data = JSON.parse(message.toString());
        if (data.type === "START_MATCH") {
          console.log("[DIAG] Received START_MATCH signal. Beginning sequential test plan.");
          // We pass the full payload to the test runner.
          startDiagnosticSequence(ws, data.payload); 
        }
    } catch (e) {
        console.error("[WSS] Failed to parse incoming WebSocket message:", e);
    }
  });

  ws.on("close", () => console.log("[WSS] Client disconnected."));
});

// --- Main Diagnostic Sequence Runner ---
function startDiagnosticSequence(ws: WebSocket, payload: any) {
  runTest1(ws, payload); // Start with the first test
}

// --- Test 1: Can `java` be executed? ---
function runTest1(ws: WebSocket, payload: any) {
  const testName = "TEST_1_JAVA_VERSION";
  console.log(`[${testName}] EXECUTING: Check if Java runtime is available.`);
  broadcast({ type: "DIAGNOSTIC_MESSAGE", payload: `[${testName}] RUNNING...` });

  const process = spawn("java", ["-version"], { cwd: APP_DIR });

  process.stderr.on('data', (data) => {
    console.log(`[${testName}_STDERR]: ${data.toString()}`);
  });

  process.on("close", (code) => {
    console.log(`[${testName}] Process exited with code ${code}`);
    if (code === 0) {
      broadcast({ type: "DIAGNOSTIC_MESSAGE", payload: `[${testName}] SUCCEEDED. Java is installed.` });
      // If successful, proceed to the next test.
      runTest2(ws, payload);
    } else {
      broadcast({ type: "DIAGNOSTIC_MESSAGE", payload: `[${testName}] FAILED. Java command could not be executed.` });
    }
  });
}

// --- Test 2: Can the JVM load the JAR and find the main class? ---
function runTest2(ws: WebSocket, payload: any) {
  const testName = "TEST_2_JAR_AND_MAIN_CLASS";
  console.log(`[${testName}] EXECUTING: Check if JAR is valid and forge.view.Main can be loaded.`);
  broadcast({ type: "DIAGNOSTIC_MESSAGE", payload: `[${testName}] RUNNING...` });

  const jarPath = path.join(APP_DIR, "forgeSim.jar");
  const javaArgs = ["-cp", jarPath, "forge.view.Main"];

  const process = spawn("java", javaArgs, { cwd: APP_DIR });

  let output = "";
  process.stderr.on('data', (data) => {
      output += data.toString();
  });

  process.on("close", (code) => {
    console.log(`[${testName}] Process exited with code ${code}`);
    console.log(`[${testName}_STDERR]: ${output}`);
    // For this test, ANY execution that doesn't result in "Could not find or load main class" is a success.
    if (!output.includes("Could not find or load main class")) {
      broadcast({ type: "DIAGNOSTIC_MESSAGE", payload: `[${testName}] SUCCEEDED. JAR and Main-Class are valid.` });
      // If successful, proceed to the next test.
      runTest3(ws, payload);
    } else {
      broadcast({ type: "DIAGNOSTIC_MESSAGE", payload: `[${testName}] FAILED. JAR is invalid or Main-Class not found.` });
    }
  });
}

// --- Test 3: Does the `sim` argument get recognized? ---
function runTest3(ws: WebSocket, payload: any) {
  const testName = "TEST_3_SIM_ARGUMENT";
  console.log(`[${testName}] EXECUTING: Check if 'sim' argument is recognized by the application.`);
  broadcast({ type: "DIAGNOSTIC_MESSAGE", payload: `[${testName}] RUNNING...` });

  const jarPath = path.join(APP_DIR, "forgeSim.jar");
  const javaArgs = ["-Djava.awt.headless=true", "-Dforge.home=/app", "-jar", jarPath, "sim"];
  
  const process = spawn("java", javaArgs, { cwd: APP_DIR });

  let output = "";
  process.stderr.on('data', (data) => {
      output += data.toString();
  });

  process.on("close", (code) => {
    console.log(`[${testName}] Process exited with code ${code}`);
    console.log(`[${testName}_STDERR]: ${output}`);
    // A SUCCESS is seeing an error about missing deck/AI arguments. This proves the 'sim' branch was taken.
    if (output.includes("ArrayIndexOutOfBoundsException") || output.includes("Missing deck")) {
      broadcast({ type: "DIAGNOSTIC_MESSAGE", payload: `[${testName}] SUCCEEDED. The 'sim' command was recognized.` });
      // If all tests pass, run the full command as a final attempt.
      runFullSimulation(ws, payload);
    } else {
      broadcast({ type: "DIAGNOSTIC_MESSAGE", payload: `[${testName}] FAILED. The 'sim' command was not processed as expected.` });
    }
  });
}

// --- Final Attempt: Run the full simulation command ---
function runFullSimulation(ws: WebSocket, payload: any) {
  const testName = "FINAL_ATTEMPT";
  console.log(`[${testName}] EXECUTING: All tests passed. Attempting full simulation command.`);
  broadcast({ type: "DIAGNOSTIC_MESSAGE", payload: `[${testName}] RUNNING...` });

  const { deck1, deck2 } = payload;
  const jarPath = path.join(APP_DIR, "forgeSim.jar");
  const javaArgs = [
    `-Djava.awt.headless=true`,
    `-Dforge.home=${APP_DIR}`,
    "-jar", jarPath,
    "sim",
    "-d", deck1.filename, "-d", deck2.filename,
    "-a", deck1.aiProfile, "-a", deck2.aiProfile,
    "-l", "gamelog.txt", "-n", "1",
  ];

  const forgeProcess = spawn("java", javaArgs, { cwd: APP_DIR });

  forgeProcess.stderr.on('data', (data) => {
    console.error(`[${testName}_STDERR]: ${data.toString()}`);
    broadcast({ type: "ERROR", message: `[${testName}] ${data.toString()}` });
  });

  forgeProcess.on("close", (code) => {
    console.log(`[${testName}] Process exited with code ${code}`);
    if (code !== 0) {
        broadcast({ type: "DIAGNOSTIC_MESSAGE", payload: `[${testName}] FAILED with exit code ${code}.` });
    } else {
        broadcast({ type: "DIAGNOSTIC_MESSAGE", payload: `[${testName}] SUCCEEDED? Process exited with code 0.` });
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

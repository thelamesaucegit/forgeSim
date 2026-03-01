import { WebSocketServer, WebSocket } from "ws";
import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { parseLogLine, getInitialState, GameState } from "./parser.js";

const APP_DIR = process.cwd();
const FORGE_DECKS_DIR = path.join(APP_DIR, "decks", "constructed");

const wss = new WebSocketServer({ port: 8080 });
console.log(`[INIT] Sidecar WebSocket server started on port 8080.`);
wss.on('listening', () => console.log('[HEALTH_CHECK] Server is listening on port 8080.'));
if (!fs.existsSync(FORGE_DECKS_DIR)) {
    fs.mkdirSync(FORGE_DECKS_DIR, { recursive: true });
}

wss.on("connection", (ws) => {
  console.log("[WSS] Client connected.");
  ws.send(JSON.stringify({ type: "CONNECTION_ESTABLISHED", status: "Ready to start match." }));
  ws.on("message", (message) => {
    try {
        const data = JSON.parse(message.toString());
        if (data.type === "START_MATCH") {
          console.log("[WSS] Received START_MATCH signal. Starting match.");
          startMatch(ws, data.payload);
        }
    } catch (e) { console.error("[WSS] Failed to parse incoming WebSocket message:", e); }
  });
});

function startMatch(ws: WebSocket, payload: any) {
  const { deck1, deck2 } = payload;
  const jarPath = path.join(APP_DIR, "forgeSim.jar");
  let currentGameState: GameState = getInitialState();

  try {
    fs.writeFileSync(path.join(FORGE_DECKS_DIR, deck1.filename), deck1.content);
    fs.writeFileSync(path.join(FORGE_DECKS_DIR, deck2.filename), deck2.content);
  } catch(e: any) {
    console.error(`[MATCH] FATAL: Failed during deck file write.`, e.message);
    return;
  }
  
  const diagLevel = process.env.DIAG_LEVEL || '1';
  let commandToRun: string;
  let commandArgs: string[];
  const baseJavaArgs = ["-Xmx1024m", `-Djava.awt.headless=true`, `-Dsentry.enabled=false`, `-Dforge.home=${APP_DIR}`, "-jar", jarPath, "sim", "-d", deck1.filename, deck2.filename, "-a", deck1.aiProfile, deck2.aiProfile, "-n", "1"];

  switch (diagLevel) {
    case '3': commandToRun = "strace"; commandArgs = ["-f", "java", "-verbose:class", ...baseJavaArgs]; break;
    case '2': commandToRun = "java"; commandArgs = ["-verbose:class", ...baseJavaArgs]; break;
    default:  commandToRun = "java"; commandArgs = baseJavaArgs; break;
  }

  console.log(`[MATCH] Spawning process with command: ${commandToRun} ${commandArgs.join(' ')}`);
  const forgeProcess = spawn(commandToRun, commandArgs, { cwd: APP_DIR });

  // Buffer for incomplete lines from stdout
  let stdoutBuffer = "";
  forgeProcess.stdout.on('data', (data) => {
      stdoutBuffer += data.toString();
      let newlineIndex;
      // Process all complete lines in the buffer
      while ((newlineIndex = stdoutBuffer.indexOf('\\n')) >= 0) {
        const line = stdoutBuffer.substring(0, newlineIndex).trim();
        stdoutBuffer = stdoutBuffer.substring(newlineIndex + 1);
        
        if (line) {
          console.log(`[PARSE_ATTEMPT] Parsing line: "${line}"`);
          const newState = parseLogLine(line, currentGameState);
          if (newState) {
            console.log(`[PARSE_SUCCESS] State updated. Broadcasting.`);
            currentGameState = newState;
            broadcast({ type: 'GAME_STATE_UPDATE', payload: currentGameState });
          } else {
            console.log(`[PARSE_FAILURE] Line did not produce a state update.`);
          }
        }
      }
  });
  
  forgeProcess.stderr.on('data', (data) => {
      console.error(`[JVM_STDERR]: ${data.toString()}`);
  });

  forgeProcess.on("close", (code) => {
    console.log(`[FINAL_STATE] Match ended. Final game state was:`, JSON.stringify(currentGameState, null, 2));
    const result = { type: "MATCH_COMPLETE", success: code === 0, message: `Match finished with code ${code}.` };
    broadcast(result);
    console.log(`[MATCH_COMPLETE] Broadcasted final result.`);
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

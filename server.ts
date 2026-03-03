// src/forgesim/server.ts

import { spawn } from "child_process";
import * as fs from "fs/promises";
import * as path from "path";
import * as http from "http";
import { createClient } from "@supabase/supabase-js";
import { parseLogLine, getInitialState, GameState } from "./parser.js";

// --- Type Definitions ---
interface DeckInfo {
  filename: string;
  content: string;
  aiProfile: string;
}

interface StartMatchPayload {
  deck1: DeckInfo;
  deck2: DeckInfo;
  matchId: string;
}

// --- Supabase and App Setup ---
const APP_DIR = process.cwd();
const FORGE_DECKS_DIR = path.join(APP_DIR, "decks", "constructed");

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error("[FATAL] Supabase URL or Service Key is not set. The server cannot start.");
  process.exit(1);
}
const supabase = createClient(supabaseUrl, supabaseKey);
console.log("[INIT] Supabase client initialized.");

// --- Unified HTTP Server Logic ---
const server = http.createServer(async (req: http.IncomingMessage, res: http.ServerResponse) => {
  if (req.url === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  if (req.url === '/start-match' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body);
        console.log("[PAYLOAD_INSPECT] Received payload:", JSON.stringify(payload, null, 2));
        
        // Respond immediately and then start the background processing.
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: "Match simulation job received." }));
        
        startMatch(payload);

      } catch (e: unknown) {
        let message = "An unknown error occurred.";
        if (e instanceof Error) message = e.message;
        console.error("[HTTP_ERROR] Failed during /start-match request processing:", message);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: "An internal server error occurred." }));
        }
      }
    });
    return;
  }

  if (!res.headersSent) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: "Not Found" }));
  }
});

server.listen(8080, () => {
  console.log('[HEALTH_CHECK] HTTP server listening on port 8080 for health checks.');
});

// --- Main Match Logic ---
async function startMatch(payload: StartMatchPayload) {
  const { deck1, deck2, matchId } = payload;

  if (!matchId) {
    console.error("[FATAL_LOGIC] No matchId provided in payload. Aborting simulation.");
    return;
  }

  try {
    // The parsed JSON payload already has correct literal '\n' characters.
    await fs.writeFile(path.join(FORGE_DECKS_DIR, deck1.filename), deck1.content);
    await fs.writeFile(path.join(FORGE_DECKS_DIR, deck2.filename), deck2.content);
  } catch (e: unknown) {
    let message = "An unknown error occurred during file write.";
    if (e instanceof Error) message = e.message;
    console.error(`[FATAL_FILE] Failed for match ${matchId}. Error:`, message);
    return; 
  }

  let currentGameState: GameState = getInitialState();
  const allGameStates: GameState[] = [];

  const jarPath = path.join(APP_DIR, "forgeSim.jar");
  const commandArgs = [
    "-Xmx1024m", `-Djava.awt.headless=true`, `-Dforge.home=${APP_DIR}`, 
    "-jar", jarPath, "sim", "-d", deck1.filename, deck2.filename,
    "-a", deck1.aiProfile, deck2.aiProfile, "-n", "1"
  ];

  console.log(`[MATCH] Spawning process for match ID ${matchId}`);
  
  const forgeProcess = spawn("java", commandArgs, { 
    cwd: APP_DIR, 
    stdio: ['ignore', 'pipe', 'pipe'] 
  });

  const processLine = (line: string) => {
    if (line) {
      const newState = parseLogLine(line, currentGameState);
      if (newState) {
        currentGameState = newState;
        allGameStates.push({ ...currentGameState }); 
      }
    }
  };

  forgeProcess.stdout.on('data', (data) => {
    let stdoutBuffer = data.toString();
    let newlineIndex;
    // --- FIX: Use a literal newline '\n' for correct stream processing ---
    while ((newlineIndex = stdoutBuffer.indexOf('\n')) >= 0) {
      const line = stdoutBuffer.substring(0, newlineIndex).trim();
      stdoutBuffer = stdoutBuffer.substring(newlineIndex + 1);
      processLine(line);
    }
    if (stdoutBuffer.length > 0) {
        processLine(stdoutBuffer.trim());
    }
  });

  forgeProcess.stderr.on('data', (data) => {
    console.error(`[JVM_STDERR] Match ${matchId}: ${data.toString().trim()}`);
  });

  forgeProcess.on("close", async (code) => {
    console.log(`[MATCH_COMPLETE] Match ${matchId} finished with code ${code}.`);
    
    if (code === 0 && currentGameState.winner) {
      console.log(`[DB] Match ${matchId} winner is ${currentGameState.winner}. Saving full game log...`);

      const { error: updateError } = await supabase
        .from('sim_matches')
        .update({ 
          winner: currentGameState.winner,
          game_states: allGameStates
        })
        .eq('id', matchId);
      
      if (updateError) {
        console.error(`[DB_WINNER_ERROR] Failed to update final match data for ${matchId}:`, updateError.message);
      } else {
        console.log(`[DB] Successfully saved winner and game log for match ${matchId}.`);
      }
    } else if (code !== 0) {
      console.error(`[MATCH_ERROR] Java process for match ${matchId} exited with non-zero code: ${code}`);
    } else {
      console.warn(`[MATCH_WARN] Match ${matchId} finished cleanly but no winner was parsed from the logs.`);
    }
  });

  forgeProcess.on('error', (err) => {
    console.error(`[SPAWN_ERROR] Failed to start Java process for match ${matchId}:`, err);
  });
}

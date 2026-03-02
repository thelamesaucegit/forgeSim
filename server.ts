// src/server.ts

import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as http from "http";
import { createClient } from "@supabase/supabase-js";
import { parseLogLine, getInitialState, GameState } from "./parser.js";

// --- Supabase and App Setup ---
const APP_DIR = process.cwd();
const FORGE_DECKS_DIR = path.join(APP_DIR, "decks", "constructed");

// Initialize Supabase client
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error("[FATAL] Supabase URL or Service Key is not set. The server cannot start.");
  process.exit(1);
}
const supabase = createClient(supabaseUrl, supabaseKey);
console.log("[INIT] Supabase client initialized.");

// --- Unified HTTP Server Logic ---
const server = http.createServer((req: http.IncomingMessage, res: http.ServerResponse) => {
  // Route: Health Check
  if (req.url === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  // Route: Start Match Simulation
  if (req.url === '/start-match' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        console.log("[HTTP] Received START_MATCH signal via POST request.");
        // Asynchronously start the match process. Do not await it here.
        startMatch(payload);

        // Immediately send a 202 Accepted response to the client.
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: "Match simulation accepted and has started." }));
      } catch (e: any) {
        console.error("[HTTP] Failed to parse request body:", e);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: "Invalid JSON in request body.", details: e.message }));
      }
    });
    return;
  }

  // Fallback Route: Not Found for all other requests
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: "Not Found" }));
});

server.listen(8080, () => {
  console.log('[HEALTH_CHECK] HTTP server listening on port 8080 for health checks.');
});

// --- Main Match Logic (No changes below this line) ---
async function startMatch(payload: any) {
  const { deck1, deck2 } = payload;
  const jarPath = path.join(APP_DIR, "forgeSim.jar");
  let currentGameState: GameState = getInitialState();

  const player1Info = `${deck1.filename} (AI: ${deck1.aiProfile})`;
  const player2Info = `${deck2.filename} (AI: ${deck2.aiProfile})`;

  const { data: matchData, error: matchError } = await supabase
    .from('sim_matches')
    .insert({ player1_info: player1Info, player2_info: player2Info })
    .select('id')
    .single();

  if (matchError || !matchData) {
    console.error("[DB_ERROR] Could not create new sim_matches entry:", matchError);
    return;
  }
  const matchId = matchData.id;
  console.log(`[DB] New simulation match created with ID: ${matchId}`);

  try {
    // This is synchronous file writing. For a busy server, consider making this async.
    fs.writeFileSync(path.join(FORGE_DECKS_DIR, deck1.filename), deck1.content);
    fs.writeFileSync(path.join(FORGE_DECKS_DIR, deck2.filename), deck2.content);
  } catch(e: any) {
    console.error(`[FATAL] Failed during deck file write.`, e.message);
    // In a real scenario, you might want to update the DB to mark this match as failed.
    return;
  }

  const commandToRun = "java";
  const commandArgs = ["-Xmx1024m", `-Djava.awt.headless=true`, `-Dforge.home=${APP_DIR}`, "-jar", jarPath, "sim", "-d", deck1.filename, deck2.filename, "-a", deck1.aiProfile, deck2.aiProfile, "-n", "1"];
  
  console.log(`[MATCH] Spawning process for match ID ${matchId}`);
  const forgeProcess = spawn(commandToRun, commandArgs, { cwd: APP_DIR });

  let stdoutBuffer = "";
  forgeProcess.stdout.on('data', async (data) => {
    stdoutBuffer += data.toString();
    let newlineIndex;

    while ((newlineIndex = stdoutBuffer.indexOf('\\n')) >= 0) {
      const line = stdoutBuffer.substring(0, newlineIndex).trim();
      stdoutBuffer = stdoutBuffer.substring(newlineIndex + 1);
      
      if (line) {
        const newState = parseLogLine(line, currentGameState);
        if (newState) {
          currentGameState = newState;
          const { error: stateError } = await supabase
            .from('sim_match_states')
            .insert({ match_id: matchId, state_data: currentGameState });

          if (stateError) {
            console.error("[DB_ERROR] Failed to insert game state:", stateError);
          } else {
            console.log(`[DB] Saved state for turn ${currentGameState.turn} of match ${matchId}`);
          }
        }
      }
    }
  });

  forgeProcess.stderr.on('data', (data) => {
    console.error(`[JVM_STDERR]: ${data.toString()}`);
  });

  forgeProcess.on("close", async (code) => {
    console.log(`[MATCH_COMPLETE] Match ${matchId} finished with code ${code}.`);
    if (code === 0 && currentGameState.winner) {
      const { error: updateError } = await supabase
        .from('sim_matches')
        .update({ winner: currentGameState.winner })
        .eq('id', matchId);
      
      if (updateError) {
        console.error("[DB_ERROR] Failed to update match winner:", updateError);
      } else {
        console.log(`[DB] Match ${matchId} winner updated: ${currentGameState.winner}`);
      }
    }
  });
}

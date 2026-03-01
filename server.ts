// src/server.ts

import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
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

// This server's primary purpose is now to run simulations and write to the DB.
// The HTTP server exists mainly for health checks and to trigger jobs.
const http = require('http');
const server = http.createServer((req: any, res: any) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
  } else {
    res.writeHead(404);
    res.end();
  }
});

server.listen(8080, () => {
  console.log('[HEALTH_CHECK] HTTP server listening on port 8080 for health checks.');
});

// A simple HTTP endpoint to trigger a match simulation.
server.on('request', (req: any, res: any) => {
    if (req.method === 'POST' && req.url === '/start-match') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', () => {
            try {
                const payload = JSON.parse(body);
                console.log("[HTTP] Received START_MATCH signal via POST request.");
                // Start the match simulation but don't wait for it to finish.
                // This makes the endpoint responsive.
                startMatch(payload);
                res.writeHead(202, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ message: "Match simulation accepted and started." }));
            } catch (e) {
                console.error("[HTTP] Failed to parse request body:", e);
                res.writeHead(400);
                res.end();
            }
        });
    }
});


// --- Main Match Logic ---
async function startMatch(payload: any) {
  const { deck1, deck2 } = payload;
  const jarPath = path.join(APP_DIR, "forgeSim.jar");
  let currentGameState: GameState = getInitialState();

  // 1. Create a new match entry in the dedicated `sim_matches` table.
  const player1Info = `${deck1.filename} (AI: ${deck1.aiProfile})`;
  const player2Info = `${deck2.filename} (AI: ${deck2.aiProfile})`;

  const { data: matchData, error: matchError } = await supabase
    .from('sim_matches') // CORRECTED TABLE NAME
    .insert({ player1_info: player1Info, player2_info: player2Info })
    .select('id')
    .single();

  if (matchError || !matchData) {
    console.error("[DB_ERROR] Could not create new sim_matches entry:", matchError);
    return;
  }
  const matchId = matchData.id;
  console.log(`[DB] New simulation match created with ID: ${matchId}`);

  // (Deck writing and command setup remains the same)
  try {
    fs.writeFileSync(path.join(FORGE_DECKS_DIR, deck1.filename), deck1.content);
    fs.writeFileSync(path.join(FORGE_DECKS_DIR, deck2.filename), deck2.content);
  } catch(e: any) {
    console.error(`[FATAL] Failed during deck file write.`, e.message);
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
          // 2. Insert the new game state into the dedicated `sim_match_states` table.
          const { error: stateError } = await supabase
            .from('sim_match_states') // CORRECTED TABLE NAME
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

    // 3. Update the `sim_matches` entry with the winner.
    if (code === 0 && currentGameState.winner) {
      const { error: updateError } = await supabase
        .from('sim_matches') // CORRECTED TABLE NAME
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

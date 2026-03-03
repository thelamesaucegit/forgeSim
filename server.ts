// src/forgesim/server.ts

import { spawn } from "child_process";
import * as fs from "fs/promises"; // Changed to fs.promises for async operations
import * as path from "path";
import * as http from "http";
import { createClient } from "@supabase/supabase-js";
import { parseLogLine, getInitialState, GameState } from "./parser.js";

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
        
        // --- Added Logging for Payload ---
        console.log("[PAYLOAD_INSPECT] Received payload:", JSON.stringify(payload, null, 2));
        
        await startMatch(payload, res);

      } catch (e: any) {
        console.error("[HTTP_ERROR] Failed during /start-match request processing:", e);
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
async function startMatch(payload: any, res: http.ServerResponse) {
  const { deck1, deck2 } = payload;
  let matchId: string; // This will be set after DB insertion

  try {
    // --- FIX: Create the match entry before responding to the client ---
    // This allows us to get matchId to the frontend immediately.
    const { data: matchData, error: matchError } = await supabase
      .from('sim_matches')
      .insert({ 
          player1_info: `${deck1.filename} (AI: ${deck1.aiProfile})`, 
          player2_info: `${deck2.filename} (AI: ${deck2.aiProfile})` 
      })
      .select('id')
      .single();

    if (matchError || !matchData) {
      throw new Error(matchError?.message || "Failed to create DB entry.");
    }
    
    matchId = matchData.id;
    console.log(`[DB] New simulation match created with ID: ${matchId}`);

    // Immediately respond to the client with the ID so it can start polling.
    // This happens BEFORE the Java process is spawned or files are written.
    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ matchId: matchId, message: "Match simulation accepted and processing in background." }));

  } catch (error: any) {
    console.error("[FATAL_DB] Could not create match entry in DB for new simulation:", error.message);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: "A database error occurred during match creation." }));
    }
    return; // Stop execution if DB fails
  }

  // --- Background Processing (now truly non-blocking) ---
  try {
    // --- FIX: Use async file writing to prevent blocking the event loop ---
    await fs.writeFile(path.join(FORGE_DECKS_DIR, deck1.filename), deck1.content);
    await fs.writeFile(path.join(FORGE_DECKS_DIR, deck2.filename), deck2.content);
  } catch (e: any) {
    console.error(`[FATAL_FILE] Failed during deck file write for match ${matchId}. Error:`, e.message);
    // In a real app, you might want to update the 'sim_matches' table to mark this match as 'failed'.
    return; 
  }

  let currentGameState: GameState = getInitialState();
  const jarPath = path.join(APP_DIR, "forgeSim.jar");
  const commandArgs = [
    "-Xmx1024m", 
    `-Djava.awt.headless=true`, 
    `-Dforge.home=${APP_DIR}`, 
    "-jar", 
    jarPath, 
    "sim", 
    "-d", 
    deck1.filename, 
    deck2.filename, 
    "-a", 
    deck1.aiProfile, 
    deck2.aiProfile, 
    "-n", 
    "1"
  ];

  console.log("[SPAWN_ARGS] Assembled command args for Java process:", commandArgs);
  console.log(`[MATCH] Spawning process for match ID ${matchId}`);
  
  // --- FIX: Use non-blocking spawn ---
  const forgeProcess = spawn("java", commandArgs, { 
      cwd: APP_DIR,
      detached: true, // Crucial for long-running background processes
      stdio: ['ignore', 'pipe', 'pipe'] // Pipe stdout/stderr, ignore stdin
  });

  // This is important to allow the parent process to exit independently of the child.
  // We're handling the output via pipes.
  forgeProcess.unref();

  let stdoutBuffer = "";
  const processLine = (line: string) => {
    if (line) {
      const newState = parseLogLine(line, currentGameState);
      if (newState) {
        currentGameState = newState;
        // Fire-and-forget the state update to avoid blocking.
        supabase.from('sim_match_states').insert({ match_id: matchId, state_data: currentGameState })
          .then(
            ({ error }) => {
              if (error) console.error(`[DB_STATE_ERROR] Match ${matchId} Turn ${currentGameState.turn}:`, error.message);
            },
            (err: any) => console.error(`[DB_STATE_FATAL] Uncaught error saving state for Match ${matchId}:`, err)
          );
      }
    }
  };

  forgeProcess.stdout.on('data', (data) => {
    stdoutBuffer += data.toString();
    let newlineIndex;
    while ((newlineIndex = stdoutBuffer.indexOf('\n')) >= 0) {
      const line = stdoutBuffer.substring(0, newlineIndex).trim();
      stdoutBuffer = stdoutBuffer.substring(newlineIndex + 1);
      processLine(line);
    }
  });

  forgeProcess.stderr.on('data', (data) => {
    console.error(`[JVM_STDERR] Match ${matchId}: ${data.toString().trim()}`);
  });

  forgeProcess.on("close", async (code) => {
    console.log(`[MATCH_COMPLETE] Match ${matchId} finished with code ${code}.`);

    // Process any remaining data in the buffer before checking the final state.
    if (stdoutBuffer.length > 0) {
      console.log(`[BUFFER_FLUSH] Match ${matchId}: Processing remaining stdout buffer...`);
      stdoutBuffer.split('\n').forEach(line => processLine(line.trim()));
    }

    if (code === 0 && currentGameState.winner) {
      const { error: updateError } = await supabase
        .from('sim_matches')
        .update({ winner: currentGameState.winner })
        .eq('id', matchId);
      
      if (updateError) {
        console.error(`[DB_WINNER_ERROR] Failed to update winner for match ${matchId}:`, updateError.message);
      } else {
        console.log(`[DB] Match ${matchId} winner updated: ${currentGameState.winner}`);
      }
    } else if (code !== 0) {
      console.error(`[MATCH_ERROR] Java process for match ${matchId} exited with non-zero code: ${code}`);
      // Optionally update match status to 'failed' in DB
    } else {
      console.warn(`[MATCH_WARN] Match ${matchId} finished cleanly but no winner was parsed from the logs.`);
      // Optionally update match status to 'draw' or 'no winner' in DB
    }
  });

  forgeProcess.on('error', (err) => {
    console.error(`[SPAWN_ERROR] Failed to start Java process for match ${matchId}:`, err);
    // Optionally update match status to 'failed' in DB
  });
}

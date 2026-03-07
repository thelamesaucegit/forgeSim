// src/forgesim/server.ts

import { spawn } from "child_process";
import * as fs from "fs/promises";
import * as path from "path";
import * as http from "http";
import { createClient } from "@supabase/supabase-js";
import { parseLogLine, getInitialState, GameState } from "./parser.js";

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

async function cleanDecksDirectory(): Promise<void> {
    try {
        const files = await fs.readdir(FORGE_DECKS_DIR);
        const deletePromises = files
            .filter(file => file.endsWith('.dck'))
            .map(file => fs.unlink(path.join(FORGE_DECKS_DIR, file)));
        await Promise.all(deletePromises);
        console.log("[CLEANUP] Successfully removed old .dck files.");
    } catch (error: unknown) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
            console.log("[CLEANUP] Decks directory not found, will be created.");
            await fs.mkdir(FORGE_DECKS_DIR, { recursive: true });
        } else {
            console.error("[CLEANUP_ERROR] Failed to clean decks directory:", error);
            throw error;
        }
    }
}


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

async function startMatch(payload: StartMatchPayload) {
  const { deck1, deck2, matchId } = payload;
  if (!matchId) {
    console.error("[FATAL_LOGIC] No matchId provided in payload. Aborting simulation.");
    return;
  }
  
  let validTeamIds: string[];

  try {
    const { data: teamsData, error: teamsError } = await supabase.from('teams').select('id');
    if (teamsError || !teamsData) {
        throw new Error(teamsError?.message || "Failed to fetch team IDs for parser validation.");
    }
    validTeamIds = teamsData.map(t => t.id);

    await cleanDecksDirectory();
    await fs.writeFile(path.join(FORGE_DECKS_DIR, deck1.filename), deck1.content);
    await fs.writeFile(path.join(FORGE_DECKS_DIR, deck2.filename), deck2.content);
  } catch (e: unknown) {
    let message = "An unknown error occurred during file write/cleanup.";
    if (e instanceof Error) message = e.message;
    console.error(`[FATAL_SETUP] Failed for match ${matchId}. Error:`, message);
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
      const newState = parseLogLine(line, currentGameState, validTeamIds);
      if (newState) {
        currentGameState = newState;
        allGameStates.push({ ...currentGameState });
      }
    }
  };

  // ---
  // FIX: Implement a buffer to handle incomplete stream data. This ensures
  // the parser only ever receives complete lines, preventing intermittent failures.
  // ---
  let stdoutBuffer = '';
  forgeProcess.stdout.on('data', (data) => {
    stdoutBuffer += data.toString();
    let newlineIndex;
    while ((newlineIndex = stdoutBuffer.indexOf('\n')) >= 0) {
      const line = stdoutBuffer.substring(0, newlineIndex).trim();
      stdoutBuffer = stdoutBuffer.substring(newlineIndex + 1);
      if (line) { // Process non-empty lines
        processLine(line);
      }
    }
  });

  // Process any remaining data when the stream closes.
  forgeProcess.stdout.on('end', () => {
    if (stdoutBuffer.length > 0) {
      processLine(stdoutBuffer.trim());
    }
  });

  forgeProcess.stderr.on('data', (data) => {
    console.error(`[JVM_STDERR] Match ${matchId}: ${data.toString().trim()}`);
  });

  forgeProcess.on("close", async (code) => {
    console.log(`[MATCH_COMPLETE] Match ${matchId} finished with code ${code}.`);
    
    const finalPlayerKeys = Object.keys(currentGameState.players);
    if (code === 0 && currentGameState.winner && finalPlayerKeys.length >= 2) {
      console.log(`[DB] Match ${matchId} winner is ${currentGameState.winner}. Saving full game log...`);
      
      const { error: updateError } = await supabase
        .from('sim_matches')
        .update({
          winner: currentGameState.winner,
          game_states: allGameStates,
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
      console.warn(`[MATCH_WARN] Match ${matchId} finished but key data (winner or players) was not parsed.`);
    }
  });

  forgeProcess.on('error', (err) => {
    console.error(`[SPAWN_ERROR] Failed to start Java process for match ${matchId}:`, err);
  });
}

// src/forgesim/server.ts

import { spawn } from "child_process";
import * as fs from "fs/promises";
import * as path from "path";
import * as http from "http";
import { createClient } from "@supabase/supabase-js";
import { postProcessLog } from "./parser.js"; // We import the new post-processor

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
const LOGS_DIR = path.join(APP_DIR, "logs"); // A new directory for raw logs

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error("[FATAL] Supabase URL or Service Key is not set. The server cannot start.");
  process.exit(1);
}
const supabase = createClient(supabaseUrl, supabaseKey);
console.log("[INIT] Supabase client initialized.");

async function ensureDir(dir: string): Promise<void> {
  try {
    await fs.access(dir);
  } catch (error) {
    await fs.mkdir(dir, { recursive: true });
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
  
  try {
    await ensureDir(FORGE_DECKS_DIR);
    await ensureDir(LOGS_DIR);
    await fs.writeFile(path.join(FORGE_DECKS_DIR, deck1.filename), deck1.content);
    await fs.writeFile(path.join(FORGE_DECKS_DIR, deck2.filename), deck2.content);
  } catch (e: unknown) {
    let message = "An unknown error occurred during file write/cleanup.";
    if (e instanceof Error) message = e.message;
    console.error(`[FATAL_SETUP] Failed for match ${matchId}. Error:`, message);
    return; 
  }

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

  const rawLogData: string[] = [];
  forgeProcess.stdout.on('data', (data) => {
    rawLogData.push(data.toString());
  });

  forgeProcess.stderr.on('data', (data) => {
    console.error(`[JVM_STDERR] Match ${matchId}: ${data.toString().trim()}`);
  });

  forgeProcess.on("close", async (code) => {
    console.log(`[MATCH_COMPLETE] Match ${matchId} finished with code ${code}.`);
    
    if (code === 0) {
      const fullLog = rawLogData.join('');
      const logFilePath = path.join(LOGS_DIR, `${matchId}.log`);
      await fs.writeFile(logFilePath, fullLog);
      console.log(`[LOG_SAVED] Raw log saved to ${logFilePath}`);

      // --- TRIGGER THE POST-PROCESSING STEP ---
      try {
        const { data: teamsData, error: teamsError } = await supabase.from('teams').select('id');
        if (teamsError || !teamsData) throw new Error("Could not fetch team IDs for post-processing.");
        const validTeamIds = teamsData.map(t => t.id);

        const { gameStates, winner } = postProcessLog(fullLog, validTeamIds, deck1.content, deck2.content);

        if (winner && gameStates.length > 0) {
          console.log(`[DB] Post-processing complete. Winner is ${winner}. Saving full game log...`);
          const { error: updateError } = await supabase
            .from('sim_matches')
            .update({ winner: winner, game_states: gameStates })
            .eq('id', matchId);
          
          if (updateError) {
            console.error(`[DB_UPDATE_ERROR] Failed to update final match data for ${matchId}:`, updateError.message);
          } else {
            console.log(`[DB] Successfully saved winner and game log for match ${matchId}.`);
          }
        } else {
          console.warn(`[POST_PROCESS_WARN] Match ${matchId} post-processing did not yield a winner or game states.`);
        }
      } catch(e) {
         console.error(`[POST_PROCESS_FATAL] A critical error occurred during post-processing for match ${matchId}:`, e);
      }
    } else {
      console.error(`[MATCH_ERROR] Java process for match ${matchId} exited with non-zero code: ${code}`);
    }
  });

  forgeProcess.on('error', (err) => {
    console.error(`[SPAWN_ERROR] Failed to start Java process for match ${matchId}:`, err);
  });
}

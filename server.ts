import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as http from 'http';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { postProcessLog } from './parser';
import { processReplay } from './ReplayProcessor'; // New import for the final step

// --- CONFIGURATION ---
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY!;
const LOGS_DIR = path.join(process.cwd(), 'logs');
const DECKS_DIR = path.join(process.cwd(), 'decks/constructed');

// --- INITIALIZATION ---
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
console.log('[INIT] Supabase client initialized.');

// Ensure log directory exists
fs.mkdir(LOGS_DIR, { recursive: true });

// --- HELPER: FETCH CARD DATA FROM SUPABASE ---
async function getCardDictionary(deck1Path: string, deck2Path: string): Promise<Map<string, string>> {
    console.log('[DB_FETCH] Reading deck files to build card dictionary...');
    const cardDictionary = new Map<string, string>();
    const cardNameSet = new Set<string>();
    const cardNameRegex = /^\d+\s+(.+)/;

    try {
        const deck1Content = await fs.readFile(deck1Path, 'utf-8');
        const deck2Content = await fs.readFile(deck2Path, 'utf-8');

        deck1Content.split('\n').forEach(line => {
            const match = line.trim().match(cardNameRegex);
            if (match && match[1]) cardNameSet.add(match[1].trim());
        });

        deck2Content.split('\n').forEach(line => {
            const match = line.trim().match(cardNameRegex);
            if (match && match[1]) cardNameSet.add(match[1].trim());
        });

        const cardNames = Array.from(cardNameSet);
        if (cardNames.length === 0) {
            console.error('[DB_FETCH] No card names found in deck files.');
            return cardDictionary;
        }

        console.log(`[DB_FETCH] Querying Supabase for ${cardNames.length} unique card types...`);
        const { data, error } = await supabase
            .from('card_pools')
            .select('card_name, card_type')
            .in('card_name', cardNames);

        if (error) {
            console.error('[DB_FETCH] Error fetching card types from Supabase:', error);
            return cardDictionary;
        }

        if (data) {
            for (const card of data) {
                cardDictionary.set(card.card_name, card.card_type);
            }
            console.log(`[DB_FETCH] Successfully built dictionary with ${cardDictionary.size} entries.`);
        }
    } catch (e) {
        console.error('[DB_FETCH] Failed to read deck files or process card names:', e);
    }
    
    return cardDictionary;
}


// --- MAIN SIMULATION PROCESS ---
async function spawnMatchProcess(
    matchId: string,
    deck1: string,
    profile1: string,
    deck2: string,
    profile2: string
) {
    console.log(`[MATCH] Spawning process for match ID ${matchId}`);
    const deck1Path = path.join(DECKS_DIR, `${deck1}.dck`);
    const deck2Path = path.join(DECKS_DIR, `${deck2}.dck`);

    // STEP 1: Fetch all required card data from Supabase *before* simulation.
    const cardDictionary = await getCardDictionary(deck1Path, deck2Path);

    const child = spawn('java', [
        '-Xmx1024m',
        '-jar',
        'forgeSim.jar',
        'sim',
        '-d', deck1, deck2,
        '-a', profile1, profile2,
        '-n', '1',
    ]);

    let rawLog = '';
    let errorLog = '';

    child.stdout.on('data', (data) => {
        const chunk = data.toString();
        rawLog += chunk;
        console.log(`[FORGE_LOG_CHUNK] ${chunk.trim()}`);
    });

    child.stderr.on('data', (data) => {
        const chunk = data.toString();
        errorLog += chunk;
        console.error(`[JVM_STDERR] Match ${matchId}: ${chunk.trim()}`);
    });

    child.on('close', async (code) => {
        console.log(`[MATCH_COMPLETE] Match ${matchId} finished with code ${code}.`);

        if (code !== 0) {
            console.error(`[MATCH_ERROR] Java process for match ${matchId} exited with non-zero code: ${code}.`);
            await fs.writeFile(path.join(LOGS_DIR, `${matchId}-error.log`), errorLog);
            return;
        }

        try {
            await fs.writeFile(path.join(LOGS_DIR, `${matchId}.log`), rawLog);
            console.log(`[LOG_SAVED] Raw log saved to ${path.join(LOGS_DIR, `${matchId}.log`)}`);

            const deck1Content = await fs.readFile(deck1Path, 'utf-8');
            const deck2Content = await fs.readFile(deck2Path, 'utf-8');

            // STEP 2: Generate the raw, unfiltered game states using the parser.
            const rawGameStates = await postProcessLog(
                rawLog,
                [deck1, deck2],
                deck1Content,
                deck2Content,
                matchId,
                cardDictionary // Pass the card dictionary to the parser.
            );

            if (!rawGameStates.winner) {
                console.warn(`[POST_PROCESS_WARN] Match ${matchId} post-processing did not yield a winner.`);
                return;
            }

            // STEP 3: Process the raw states into a clean, paced replay.
            const finalReplay = processReplay(rawGameStates.gameStates);

            // STEP 4: Save the final, polished replay to the database.
            const { error: dbError } = await supabase
                .from('matches')
                .update({ winner: rawGameStates.winner, game_log: finalReplay })
                .eq('id', matchId);

            if (dbError) {
                console.error(`[DB] Error saving game log for match ${matchId}:`, dbError);
            } else {
                console.log(`[DB] Successfully saved winner and processed game log for match ${matchId}.`);
            }
        } catch (e) {
            console.error(`[POST_PROCESS_FATAL] Unhandled exception during post-processing for match ${matchId}:`, e);
        }
    });
}


// --- HEALTH CHECK SERVER & ENTRY POINT ---
const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
    } else {
        res.writeHead(404);
        res.end();
    }
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
    console.log(`[HEALTH_CHECK] HTTP server listening on port ${PORT} for health checks.`);
});

// Example of how to call the function
// You would replace this with your actual trigger (e.g., a Supabase subscription)
spawnMatchProcess(
    'test-match-' + Date.now(),
    'shards', 'BerserkerHorde',
    'creeps', 'Reckless'
);

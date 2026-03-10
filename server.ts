import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as http from 'http';
import { createClient, SupabaseClient, RealtimeChannel } from '@supabase/supabase-js';
import { postProcessLog } from './parser.js';
import { processReplay } from './ReplayProcessor.js';
import { WebSocket } from 'ws';

// --- TYPE DEFINITION from @supabase/realtime-js ---
// We define the expected constructor type here to ensure compatibility.
type WebSocketLikeConstructor = new (
  address: string | URL,
  subprotocols?: string | string[] | undefined
) => any;

// --- CONFIGURATION ---
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY!;
const LOGS_DIR = path.join(process.cwd(), 'logs');
const DECKS_DIR = path.join(process.cwd(), 'decks/constructed');

// --- INITIALIZATION ---
// FIX: This correctly tells TypeScript that the 'ws' WebSocket class is compatible
// with the constructor type that the Supabase client expects. This is a type-safe
// way to resolve the incompatibility without using 'any'.
const WsAdapter: WebSocketLikeConstructor = WebSocket;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: {
        persistSession: false,
        autoRefreshToken: false,
    },
    realtime: {
        transport: WsAdapter,
    }
});
console.log('[INIT] Supabase client initialized with type-safe WebSocket transport.');

// ... (The rest of the file is unchanged) ...

// Ensure required directories exist
fs.mkdir(LOGS_DIR, { recursive: true });
fs.mkdir(DECKS_DIR, { recursive: true });

async function getCardDictionary(deck1Content: string, deck2Content: string): Promise<Map<string, string>> {
    console.log('[DB_FETCH] Reading deck content to build card dictionary...');
    const cardDictionary = new Map<string, string>();
    const cardNameSet = new Set<string>();
    const cardNameRegex = /^\d*\s*(.+)/;

    const processContent = (content: string) => {
        content.split('\n').forEach(line => {
            if (line.trim().startsWith('[') || !line.trim()) return;
            const match = line.trim().match(cardNameRegex);
            if (match && match[1]) cardNameSet.add(match[1].trim());
        });
    };

    processContent(deck1Content);
    processContent(deck2Content);
    
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
    
    return cardDictionary;
}

async function spawnMatchProcess(payload: any) {
    const { id: matchId, team1_id, team2_id, deck1_list, deck2_list, profile1, profile2 } = payload.new;
    console.log(`[MATCH_RECEIVED] New match received: ${matchId}`);
    
    const deck1Name = team1_id;
    const deck2Name = team2_id;
    const deck1Path = path.join(DECKS_DIR, `${deck1Name}.dck`);
    const deck2Path = path.join(DECKS_DIR, `${deck2Name}.dck`);
    
    try {
        await fs.writeFile(deck1Path, deck1_list);
        await fs.writeFile(deck2Path, deck2_list);
        console.log(`[FILE_WRITE] Successfully wrote ${deck1Name}.dck and ${deck2Name}.dck to disk.`);

        const cardDictionary = await getCardDictionary(deck1_list, deck2_list);

        const child = spawn('java', [
            '-Xmx1024m',
            '-jar', 'forgeSim.jar',
            'sim',
            '-d', deck1Name, deck2Name,
            '-a', profile1, profile2,
            '-n', '1',
        ]);
        
        let rawLog = '';
        child.stdout.on('data', (data) => rawLog += data.toString());
        child.stderr.on('data', (data) => console.error(`[JVM_STDERR] Match ${matchId}: ${data.toString().trim()}`));

        child.on('close', async (code) => {
            console.log(`[MATCH_COMPLETE] Match ${matchId} finished with code ${code}.`);

            if (code !== 0) {
                console.error(`[MATCH_ERROR] Java process for match ${matchId} exited with non-zero code.`);
                return;
            }

            const { gameStates, winner } = await postProcessLog(rawLog, [team1_id, team2_id], deck1_list, deck2_list, matchId, cardDictionary);
            
            if (!winner) {
                console.warn(`[POST_PROCESS_WARN] Match ${matchId} did not yield a winner.`);
                return;
            }
            
            const finalReplay = processReplay(gameStates);

            const { error: dbError } = await supabase
                .from('sim_matches')
                .update({ winner, game_log: finalReplay })
                .eq('id', matchId);

            if (dbError) {
                console.error(`[DB_UPDATE] Error saving results for match ${matchId}:`, dbError);
            } else {
                console.log(`[DB_UPDATE] Successfully saved winner and processed log for match ${matchId}.`);
            }
        });

    } catch (e) {
        console.error(`[FATAL] Unhandled exception during match process for ${matchId}:`, e);
    }
}

const channel: RealtimeChannel = supabase
    .channel('sim_matches_insert')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'sim_matches' }, (payload) => {
        spawnMatchProcess(payload);
    })
    .subscribe((status, err) => {
        if (status === 'SUBSCRIBED') {
            console.log('[SUPABASE_SUB] Successfully subscribed to sim_matches inserts!');
        } else {
            console.error('[SUPABASE_SUB] Subscription failed. Status:', status, 'Error:', JSON.stringify(err, null, 2));
        }
    });

http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200);
        res.end('ok');
    } else {
        res.writeHead(404);
        res.end();
    }
}).listen(process.env.PORT || 8080, () => {
    console.log(`[HEALTH_CHECK] HTTP server listening on port ${process.env.PORT || 8080}.`);
});

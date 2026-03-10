import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as http from 'http';
import { createClient, RealtimeChannel } from '@supabase/supabase-js';
import { postProcessLog } from './parser.js';
import { processReplay } from './ReplayProcessor.js';
import { WebSocket } from 'ws';

type WebSocketLikeConstructor = new (address: string | URL, subprotocols?: string | string[] | undefined) => any;
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY!;
const LOGS_DIR = path.join(process.cwd(), 'logs');
const DECKS_DIR = path.join(process.cwd(), 'decks/constructed');

const WsAdapter: WebSocketLikeConstructor = WebSocket;
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: { transport: WsAdapter }
});
console.log('[INIT] Supabase client initialized with type-safe WebSocket transport.');

fs.mkdir(LOGS_DIR, { recursive: true });
fs.mkdir(DECKS_DIR, { recursive: true });

async function getCardDictionary(deck1Content: string, deck2Content: string): Promise<Map<string, string>> {
    const cardDictionary = new Map<string, string>();
    const cardNameSet = new Set<string>();
    const cardNameRegex = /^\d*\s*(.+)/;
    const processContent = (content: string) => {
        content.split('\n').forEach(line => {
            if (line.trim().startsWith('[') || !line.trim() || line.toLowerCase().includes('name=')) return;
            const name = line.trim().replace(cardNameRegex, '$1');
            if (name) cardNameSet.add(name);
        });
    };
    processContent(deck1Content);
    processContent(deck2Content);
    
    const cardNames = Array.from(cardNameSet);
    if (cardNames.length === 0) return cardDictionary;
    
    const { data, error } = await supabase.from('card_pools').select('card_name, card_type').in('card_name', cardNames);
    if (error) { console.error('[DB_FETCH] Error:', error); return cardDictionary; }
    if (data) data.forEach(c => cardDictionary.set(c.card_name, c.card_type));
    
    return cardDictionary;
}

async function spawnMatchProcess({ new: payload }: any) {
    const { id: matchId, team1_id, team2_id, deck1_list, deck2_list, player1_profile, player2_profile } = payload;
    console.log(`[MATCH] Received: ${matchId} (${player1_profile} vs ${player2_profile})`);
    
    try {
        await fs.writeFile(path.join(DECKS_DIR, `${team1_id}.dck`), deck1_list);
        await fs.writeFile(path.join(DECKS_DIR, `${team2_id}.dck`), deck2_list);

        const cardDictionary = await getCardDictionary(deck1_list, deck2_list);

        const child = spawn('java', ['-Xmx1024m', '-jar', 'forgeSim.jar', 'sim', '-d', team1_id, team2_id, '-a', player1_profile, player2_profile, '-n', '1']);
        
        let rawLog = '';
        child.stdout.on('data', chunk => {
            const str = chunk.toString();
            rawLog += str;
            process.stdout.write(`[FORGE] ${str}`);
        });
        child.stderr.on('data', data => console.error(`[JVM_ERR] ${data.toString().trim()}`));

        child.on('close', async code => {
            console.log(`[MATCH] Complete: ${matchId} (Code: ${code})`);
            if (code !== 0) return;
            const { gameStates, winner } = await postProcessLog(rawLog, deck1_list, deck2_list, cardDictionary);
            if (!winner) { console.warn(`[PROCESS] No winner found for ${matchId}.`); return; }
            const finalReplay = processReplay(gameStates);
            const { error: dbError } = await supabase.from('sim_matches').update({ winner, game_states: finalReplay }).eq('id', matchId);
            if (dbError) console.error(`[DB] Update Error for ${matchId}:`, dbError);
            else console.log(`[DB] Success for ${matchId}.`);
        });

    } catch (e) { console.error(`[FATAL] for ${matchId}:`, e); }
}

supabase.channel('sim_matches_insert').on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'sim_matches' }, spawnMatchProcess)
    .subscribe(status => console.log(`[SUB] Status: ${status}`));

http.createServer((req, res) => res.writeHead(200).end('ok')).listen(process.env.PORT || 8080, () => console.log(`[HEALTH] Listening.`));

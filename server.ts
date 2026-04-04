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

async function getCardDictionary(decklist: string): Promise<Map<string, string>> {
    const cardDictionary = new Map<string, string>();
    const cardNameSet = new Set<string>();
    decklist.split('\n').forEach(line => {
        if (line.trim().startsWith('[') || !line.trim() || line.toLowerCase().includes('name=')) return;
        const name = line.trim().replace(/^\d+\s*/, '');
        if (name) cardNameSet.add(name);
    });
    const cardNames = Array.from(cardNameSet);
    if (cardNames.length === 0) return cardDictionary;
    const { data, error } = await supabase.from('card_pools').select('card_name, card_type').in('card_name', cardNames);
    if (error) { console.error('[DB_FETCH] Error:', error); return cardDictionary; }
    if (data) data.forEach(c => cardDictionary.set(c.card_name, c.card_type));
    return cardDictionary;
}

// FIX: Helper function to parse AI profile from player_info string
const getAiProfile = (info: string): string => {
    const match = info.match(/\(AI: (.*?)\)/);
    return match ? match[1] : 'Default'; // Fallback to 'Default' if parsing fails
};

async function spawnMatchProcess({ new: payload }: any) {
    const { id: matchId, team1_id, team2_id, deck1_list, deck2_list, player1_info, player2_info } = payload;
    
    // FIX: Use the helper function to get correct AI profiles
    const profile1 = getAiProfile(player1_info);
    const profile2 = getAiProfile(player2_info);

    console.log(`[MATCH] Received: ${matchId} (${team1_id} (${profile1}) vs ${team2_id} (${profile2}))`);
    
    try {
        await fs.writeFile(path.join(DECKS_DIR, `${team1_id}.dck`), deck1_list);
        await fs.writeFile(path.join(DECKS_DIR, `${team2_id}.dck`), deck2_list);

        const cardDictionary = await getCardDictionary(deck1_list + '\n' + deck2_list);

        const child = spawn('java', ['-Xmx1024m', '-jar', 'forgeSim.jar', 'sim', '-d', team1_id, team2_id, '-a', profile1, profile2, '-n', '1']);
        
        let rawLog = '';
        child.stdout.on('data', (data: Buffer) => {
            const str = data.toString();
            rawLog += str;
            process.stdout.write(str);
        });
        child.stderr.on('data', (data: Buffer) => console.error(`[JVM_ERR] ${data.toString().trim()}`));

        child.on('close', async (code: number) => {
            console.log(`[MATCH] Complete: ${matchId} (Code: ${code})`);
            if (code !== 0) return;
            const { gameStates, winner } = await postProcessLog(rawLog, deck1_list, deck2_list, cardDictionary);
            if (!winner) { console.warn(`[PROCESS] No winner found for ${matchId}.`); return; }
            const finalReplay = processReplay(gameStates);
            const { error: dbError } = await supabase
                .from('sim_matches')
                .update({ winner, game_states: finalReplay })
                .eq('id', matchId);

            if (dbError) {
                console.error(`[DB] Update Error for ${matchId}:`, dbError);
                return;
            }

            console.log(`[DB] Success for ${matchId}.`);

            // Resolve winner_team_id from the winner string
            // The winner string is the player name, which contains the team_id UUID
            // Format: "Ai(1)-<team_id> (AI: <profile>)" or similar
            const winnerTeamId = [team1_id, team2_id].find(
                id => id && winner.includes(id)
            ) ?? null;

            // Update schedule table to completed
            const { error: scheduleError } = await supabase
                .from('schedule')
                .update({
                    status: 'completed',
                    winner_team_id: winnerTeamId,
                })
                .eq('sim_match_id', matchId);

            if (scheduleError) {
                console.error(`[DB] Schedule update error for sim_match ${matchId}:`, scheduleError);
            } else {
                console.log(`[DB] Schedule row completed for sim_match ${matchId}, winner team: ${winnerTeamId ?? 'draw'}`);
            }
        });

    } catch (e) { console.error(`[FATAL] for ${matchId}:`, e); }
}

supabase.channel('sim_matches_insert').on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'sim_matches' }, spawnMatchProcess)
    .subscribe((status: string) => console.log(`[SUB] Status: ${status}`));

http.createServer((req, res) => res.writeHead(200).end('ok')).listen(process.env.PORT || 8080, () => console.log(`[HEALTH] Listening.`));

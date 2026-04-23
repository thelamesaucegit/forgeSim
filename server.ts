import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as http from 'http';
import { createClient } from '@supabase/supabase-js';
import { postProcessLog } from './parser.js';
import { processReplay } from './ReplayProcessor.js';
import { WebSocket } from 'ws';
import { findPlayerNamesFromRawLog } from './utils.js';

type WebSocketLikeConstructor = new (address: string | URL, subprotocols?: string | string[]) => any;

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY!;
const LOGS_DIR = path.join(process.cwd(), 'logs');
const DECKS_DIR = path.join(process.cwd(), 'decks/constructed');
const WsAdapter: WebSocketLikeConstructor = WebSocket;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: { transport: WsAdapter }
});

console.log('[INIT] Supabase client initialized.');
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

async function enrichGameStates(rawGameStates: any[], matchId: string): Promise<any[]> {
    console.log(`[ENRICH] Fetching team data for match ${matchId}...`);
    const { data: matchData, error: matchError } = await supabase
        .from('sim_matches')
        .select('team1_name, team2_name, team1_color, team1_seccolor, team2_color, team2_seccolor')
        .eq('id', matchId)
        .single();

    if (matchError || !matchData) {
        console.error(`[ENRICH] Failed to fetch match data for enrichment:`, matchError);
        return rawGameStates;
    }

    const { team1_name, team1_color, team1_seccolor, team2_name, team2_color, team2_seccolor } = matchData;
    
    const firstState = rawGameStates[0];
    if (!firstState?.player1Name || !firstState?.player2Name) {
        console.warn("[ENRICH] Could not find raw player names in game states to replace.");
        return rawGameStates;
    }
    const rawP1Name = firstState.player1Name;
    const rawP2Name = firstState.player2Name;
    
    console.log(`[ENRICH] Mapping raw names: '${rawP1Name}' -> '${team1_name}', '${rawP2Name}' -> '${team2_name}'`);

    return rawGameStates.map(state => {
        const newState = JSON.parse(JSON.stringify(state));
        
        if (newState.gameState?.players) {
            newState.gameState.players.forEach((player: any) => {
                if (player.name === rawP1Name) {
                    player.name = team1_name;
                    player.theme = { primary: team1_color, secondary: team1_seccolor };
                } else if (player.name === rawP2Name) {
                    player.name = team2_name;
                    player.theme = { primary: team2_color, secondary: team2_seccolor };
                }
            });
        }
        
        if (newState.player1Name === rawP1Name) newState.player1Name = team1_name;
        if (newState.player2Name === rawP2Name) newState.player2Name = team2_name;
        
        const replaceIdIfNeeded = (id: string) => {
            if (id === rawP1Name) return team1_name;
            if (id === rawP2Name) return team2_name;
            return id;
        }

        if (newState.gameState?.activePlayerId) newState.gameState.activePlayerId = replaceIdIfNeeded(newState.gameState.activePlayerId);
        if (newState.gameState?.priorityPlayerId) newState.gameState.priorityPlayerId = replaceIdIfNeeded(newState.gameState.priorityPlayerId);
        if (newState.gameState?.winnerId) newState.gameState.winnerId = replaceIdIfNeeded(newState.gameState.winnerId);

        return newState;
    });
}

const getAiProfile = (info: string): string => {
    const match = info.match(/\(AI: (.*?)\)/);
    return match ? match[1] : 'Default';
};

async function spawnMatchProcess({ new: payload }: any) {
    const { id: matchId, team1_id, team2_id, deck1_list, deck2_list, player1_info, player2_info, team1_name, team2_name } = payload;
    
    const profile1 = getAiProfile(player1_info);
    const profile2 = getAiProfile(player2_info);
    console.log(`[MATCH] Received: ${matchId} (${team1_name} (${profile1}) vs ${team2_name} (${profile2}))`);
    
    try {
        await fs.writeFile(path.join(DECKS_DIR, `${team1_id}.dck`), deck1_list);
        await fs.writeFile(path.join(DECKS_DIR, `${team2_id}.dck`), deck2_list);
        
        const child = spawn('java', ['-Xmx1024m', '-jar', 'forgeSim.jar', 'sim', '-d', team1_id, team2_id, '-a', profile1, profile2, '-n', '1','-id', matchId]);
        
        let rawLog = '';
        child.stdout.on('data', (data: Buffer) => { rawLog += data.toString(); process.stdout.write(data.toString()); });
        child.stderr.on('data', (data: Buffer) => { console.error(`[JVM_ERR] ${data.toString().trim()}`); });

        child.on('close', async (code: number) => {
            console.log(`[MATCH] Complete: ${matchId} (Code: ${code})`);
            if (code !== 0) {
                 await supabase.from('sim_matches').update({ status: 'sim_failed' }).eq('id', matchId);
                 return;
            }

            // --- THIS IS THE DEFINITIVE FIX ---

            // 1. Process legacy log and update 'game_states' and 'winner'
            const cardDictionary = await getCardDictionary(deck1_list + '\n' + deck2_list);
            const { gameStates: legacyGameStates, winner } = await postProcessLog(rawLog, team1_name, team2_name, deck1_list, deck2_list, cardDictionary);
            
            if (!winner) { 
                console.warn(`[PROCESS] No winner found for ${matchId} in legacy log.`);
                // Don't return, still try to process argentum log.
            } else {
                const finalLegacyReplay = processReplay(legacyGameStates);
                const { error: legacyUpdateError } = await supabase
                    .from('sim_matches')
                    .update({ winner, game_states: finalLegacyReplay, status: 'processing' })
                    .eq('id', matchId);

                if (legacyUpdateError) {
                    console.error(`[DB] Legacy replay/winner update error for ${matchId}:`, legacyUpdateError);
                } else {
                    console.log(`[DB] Legacy replay and winner saved for ${matchId}.`);
                }
            }

            // 2. Process new 'argentum_game_states' enrichment after a delay
            setTimeout(async () => {
                const { data: match, error: fetchErr } = await supabase.from('sim_matches').select('argentum_game_states').eq('id', matchId).single();
                if (fetchErr || !match?.argentum_game_states || (match.argentum_game_states as any[]).length === 0) {
                    console.error(`[ENRICH] Could not fetch argentum_game_states for match ${matchId}:`, fetchErr);
                    await supabase.from('sim_matches').update({ status: 'processing_failed' }).eq('id', matchId);
                    return;
                }
                
                const enrichedStates = await enrichGameStates(match.argentum_game_states as any[], matchId);
                
                const { error: replayError } = await supabase.from('sim_matches').update({ argentum_game_states: enrichedStates }).eq('id', matchId);
                if (replayError) {
                    console.error(`[DB] Enriched replay update error for ${matchId}:`, replayError);
                    await supabase.from('sim_matches').update({ status: 'processing_failed' }).eq('id', matchId);
                } else {
                    console.log(`[DB] Enriched replay successfully saved for ${matchId}.`);
                    await supabase.from('sim_matches').update({ status: 'completed' }).eq('id', matchId);
                }
            }, 5000);

            // 3. Update schedule table (This logic can run immediately)
            // It relies on the `winner` from the legacy log processing, which is fast.
            const winnerTeamId = [
                { name: team1_name, id: team1_id }, 
                { name: team2_name, id: team2_id }
            ].find(t => t.name === winner)?.id ?? null;

            const { data: scheduleRow } = await supabase.from('schedule').select('id, weekly_matchup_id').eq('sim_match_id', matchId).maybeSingle();
            
            if (scheduleRow) {
                const { error: scheduleError } = await supabase
                    .from('schedule')
                    .update({ status: 'completed', winner_team_id: winnerTeamId })
                    .eq('id', scheduleRow.id);

                if (scheduleError) {
                    console.error(`[DB] Schedule update error for sim_match ${matchId}:`, scheduleError);
                } else {
                    console.log(`[DB] Schedule row completed for sim_match ${matchId}, winner team: ${winnerTeamId ?? 'draw'}`);
                }

                if (scheduleRow.weekly_matchup_id) {
                    await fetch(`${process.env.NEXT_PUBLIC_APP_URL}/api/record-sim-result`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            weeklyMatchupId: scheduleRow.weekly_matchup_id,
                            winnerTeamId,
                        }),
                    });
                }
            }
        });
    } catch (e) { console.error(`[FATAL] for ${matchId}:`, e); }
}

supabase.channel('sim_matches_insert').on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'sim_matches' }, spawnMatchProcess)
    .subscribe((status: string) => console.log(`[SUB] Status: ${status}`));

http.createServer((req, res) => res.writeHead(200).end('ok')).listen(process.env.PORT || 8080, () => console.log(`[HEALTH] Listening.`));

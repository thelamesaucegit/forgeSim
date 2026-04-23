//server.ts

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
// This function takes the raw game states and enriches them with team data.
async function enrichGameStates(
    rawGameStates: any[], 
    matchId: string
): Promise<any[]> {
    console.log(`[ENRICH] Fetching team data for match ${matchId}...`);
    const { data: matchData, error: matchError } = await supabase
        .from('sim_matches')
        .select('team1_id, team2_id, team1_name, team2_name, team1_color, team1_seccolor, team2_color, team2_seccolor')
        .eq('id', matchId)
        .single();

    if (matchError || !matchData) {
        console.error(`[ENRICH] Failed to fetch match data for enrichment:`, matchError);
        return rawGameStates; // Return raw states as a fallback
    }

    const { 
        team1_name, team1_color, team1_seccolor,
        team2_name, team2_color, team2_seccolor 
    } = matchData;

    const { player1: rawP1Name, player2: rawP2Name } = findPlayerNamesFromRawLog(JSON.stringify(rawGameStates)); // A bit inefficient but reliable

    if (!rawP1Name || !rawP2Name) {
        console.warn("[ENRICH] Could not find raw player names in game states to replace.");
        return rawGameStates;
    }
    
    console.log(`[ENRICH] Mapping raw names: '${rawP1Name}' -> '${team1_name}', '${rawP2Name}' -> '${team2_name}'`);

    // Iterate over each state and replace names/add colors.
    return rawGameStates.map(state => {
        const newState = { ...state };
        
        // Replace player names and add theme data in the players array
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
        
        // Replace top-level player names
        if (newState.player1Name === rawP1Name) newState.player1Name = team1_name;
        if (newState.player2Name === rawP2Name) newState.player2Name = team2_name;
        
        // Replace active player and priority player IDs (if they are names)
        if (newState.gameState?.activePlayerId === rawP1Name) newState.gameState.activePlayerId = team1_name;
        if (newState.gameState?.activePlayerId === rawP2Name) newState.gameState.activePlayerId = team2_name;
        if (newState.gameState?.priorityPlayerId === rawP1Name) newState.gameState.priorityPlayerId = team1_name;
        if (newState.gameState?.priorityPlayerId === rawP2Name) newState.gameState.priorityPlayerId = team2_name;

        // Replace winner ID
        if (newState.gameState?.winnerId === rawP1Name) newState.gameState.winnerId = team1_name;
        if (newState.gameState?.winnerId === rawP2Name) newState.gameState.winnerId = team2_name;

        return newState;
    });
}
// FIX: Helper function to parse AI profile from player_info string
const getAiProfile = (info: string): string => {
    const match = info.match(/\(AI: (.*?)\)/);
    return match ? match[1] : 'Default'; // Fallback to 'Default' if parsing fails
};

async function spawnMatchProcess({ new: payload }: any) {
    const { id: matchId, team1_id, team2_id, deck1_list, deck2_list, player1_info, player2_info, team1_name, team2_name } = payload;
    
    // FIX: Use the helper function to get correct AI profiles
    const profile1 = getAiProfile(player1_info);
    const profile2 = getAiProfile(player2_info);

    console.log(`[MATCH] Received: ${matchId} (${team1_name} (${profile1}) vs ${team2_name} (${profile2}))`);
    
    try {
        await fs.writeFile(path.join(DECKS_DIR, `${team1_id}.dck`), deck1_list);
        await fs.writeFile(path.join(DECKS_DIR, `${team2_id}.dck`), deck2_list);

        const cardDictionary = await getCardDictionary(deck1_list + '\n' + deck2_list);

        const child = spawn('java', ['-Xmx1024m', '-jar', 'forgeSim.jar', 'sim', '-d', team1_id, team2_id, '-a', profile1, profile2, '-n', '1','-id', matchId]);
        
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
 setTimeout(async () => {
                const { data: match, error: fetchErr } = await supabase
                    .from('sim_matches')
                    .select('argentum_game_states')
                    .eq('id', matchId)
                    .single();
     if (fetchErr || !match || !match.argentum_game_states) {
                    console.error(`[ENRICH] Could not fetch argentum_game_states for match ${matchId}:`, fetchErr);
                    return;
                }
            
            const { gameStates, winner } = await postProcessLog(rawLog, team1_name, team2_name, deck1_list, deck2_list, cardDictionary);
            if (!winner) { console.warn(`[PROCESS] No winner found for ${matchId}.`); return; }
            // Write winner first — small, fast, critical.
            const { error: winnerError } = await supabase
                .from('sim_matches')
                .update({ winner })
                .eq('id', matchId);

            if (winnerError) {
                console.error(`[DB] Winner update error for ${matchId}:`, winnerError);
                return;
            }
            console.log(`[DB] Winner saved for ${matchId}.`);
      const enrichedStates = await enrichGameStates(match.argentum_game_states as any[], matchId);
                const finalReplay = processReplay(enrichedStates);

            // Write replay separately — large payload, allowed to be slow.
            
            const { error: replayError } = await supabase
                .from('sim_matches')
                .update({ argentum_game_states: finalReplay })
                .eq('id', matchId);

            if (replayError) {
                    console.error(`[DB] Enriched replay update error for ${matchId}:`, replayError);
                } else {
                    console.log(`[DB] Enriched replay successfully saved for ${matchId}.`);
                }

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
            const { data: scheduleRow } = await supabase
    .from('schedule')
    .select('weekly_matchup_id, team1_id, team2_id')
    .eq('sim_match_id', matchId)
    .maybeSingle();

if (scheduleRow?.weekly_matchup_id) {
    // winner is the player name string containing the team UUID
    const winnerTeamId = [team1_id, team2_id].find(id => id && winner.includes(id)) ?? null;
    
    await fetch(`${process.env.NEXT_PUBLIC_APP_URL}/api/record-sim-result`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            weeklyMatchupId: scheduleRow.weekly_matchup_id,
            winnerTeamId,
        }),
    });
}
        });

    } catch (e) { console.error(`[FATAL] for ${matchId}:`, e); }
}

supabase.channel('sim_matches_insert').on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'sim_matches' }, spawnMatchProcess)
    .subscribe((status: string) => console.log(`[SUB] Status: ${status}`));

http.createServer((req, res) => res.writeHead(200).end('ok')).listen(process.env.PORT || 8080, () => console.log(`[HEALTH] Listening.`));

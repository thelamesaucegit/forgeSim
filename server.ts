//server.ts

import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as http from 'http';
import { createClient } from '@supabase/supabase-js';
import { postProcessLog } from './parser.js';
import { processReplay } from './ReplayProcessor.js';


const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY!;
const LOGS_DIR = path.join(process.cwd(), 'logs');
const DECKS_DIR = path.join(process.cwd(), 'decks/constructed');

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
});

console.log('[INIT] ForgeSim Server initialized. Ready for HTTP dispatches.');

fs.mkdir(LOGS_DIR, { recursive: true }).catch(console.error);
fs.mkdir(DECKS_DIR, { recursive: true }).catch(console.error);


function compressGameStates(rawGameStates: any[]): any[] {
    if (!rawGameStates || rawGameStates.length === 0) return rawGameStates;

    const compressed: any[] = [];
    compressed.push(rawGameStates[0]); // Always keep the initial match state

    for (let i = 1; i < rawGameStates.length; i++) {
        const state = rawGameStates[i];
        const gs = state.gameState;
        
        if (!gs) {
            compressed.push(state);
            continue;
        }

        // Check if an explicit spell or ability was cast this step
        const hasLog = gs.gameLog && gs.gameLog.length > 0;
        const curPhase = (gs.currentPhase || state.currentPhase || '').toUpperCase();
        
        // RULE 1: Never drop a state that contains an active game log (spell/ability)
        if (hasLog) {
            compressed.push(state);
            continue;
        }

        const lastKeptState = compressed[compressed.length - 1];
        const lastKeptPhase = (lastKeptState.gameState?.currentPhase || lastKeptState.currentPhase || '').toUpperCase();

        // RULE 2: Aggressive Empty Combat Pruning
        const combatPhases = [
            'COMBAT_DECLARE_ATTACKERS',
            'COMBAT_DECLARE_BLOCKERS',
            'COMBAT_FIRST_STRIKEDAMAGE', 
            'COMBAT_FIRST_STRIKE_DAMAGE',
            'COMBAT_DAMAGE',
            'COMBAT_END'
        ];

        if (combatPhases.includes(curPhase)) {
            // Find active combat info from current or previous states
            const combat = state.combat || gs.combat || lastKeptState.combat || lastKeptState.gameState?.combat;
            const hasAttackers = combat && combat.attackers && combat.attackers.length > 0;
            
            // If no attackers are declared and no logs were fired, silently drop this combat step
            if (!hasAttackers) {
                continue; 
            }
        }

        // RULE 3: Squash redundant micro-step transitions in the exact same phase
        if (curPhase === lastKeptPhase) {
            continue;
        }

        // RULE 4: Squash End_of_Turn / Cleanup priority passing loops
        if (
            (curPhase === 'CLEANUP' && lastKeptPhase === 'END_OF_TURN') ||
            (curPhase === 'END_OF_TURN' && lastKeptPhase === 'CLEANUP')
        ) {
            continue;
        }

        // If the state survived all filtering rules, keep it
        compressed.push(state);
    }

    console.log(`[COMPRESSION] Stripped ${rawGameStates.length - compressed.length} empty states. (New size: ${compressed.length})`);
    return compressed;
}
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
            // FIX: Iterate over the object values, not the object itself
            Object.values(newState.gameState.players).forEach((player: any) => {
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


// ── NEW: HTTP TRIGGER LOGIC ──────────────────────────────────────

async function handleRunMatch(req: http.IncomingMessage, res: http.ServerResponse) {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    
    req.on('end', async () => {
        try {
            const payload = JSON.parse(body);
            const { matchId, team1Id, team2Id, deck1, deck2, profile1, profile2 } = payload;
            
            if (!matchId || !deck1 || !deck2) {
                res.writeHead(400);
                return res.end(JSON.stringify({ error: 'Missing required match data' }));
            }

            console.log(`\n[HTTP] Triggering Match: ${matchId}`);
            
            // 1. Write the decks to the container
            await fs.writeFile(path.join(DECKS_DIR, `${team1Id}.dck`), deck1);
            await fs.writeFile(path.join(DECKS_DIR, `${team2Id}.dck`), deck2);

            // 2. We acknowledge the request immediately so the webserver doesn't timeout
            res.writeHead(200);
            res.end(JSON.stringify({ success: true, message: "Match started" }));

            // 3. Spawn the JVM detached from the HTTP response
            const child = spawn('java', ['-Xmx1024m', '-jar', 'forgeSim.jar', 'sim', '-d', team1Id, team2Id, '-a', profile1 || 'Default', profile2 || 'Default', '-n', '1', '-id', matchId]);
            
            let rawLog = '';
            
            child.stdout.on('data', (data: Buffer) => { rawLog += data.toString(); process.stdout.write(data.toString()); });
            child.stderr.on('data', (data: Buffer) => { console.error(`[JVM_ERR] ${data.toString().trim()}`); });
            
            child.on('close', async (code: number) => {
                console.log(`[MATCH] JVM Exit: ${matchId} (Code: ${code})`);
                if (code !== 0) {
                     console.error(`[FATAL] JVM crashed for ${matchId}. Simulation aborted.`);
                     // Mark schedule as failed so cron job can reset it later
                     await supabase.from('schedule').update({ status: 'failed' } as any).eq('sim_match_id', matchId);
                     return;
                }

                // Process Replays (Unchanged from original)
                try {
                    const cardDictionary = await getCardDictionary(deck1 + '\n' + deck2);
                    
                    // Note: You need to pass the raw team names to postProcessLog if it requires them.
                    // For now, passing 'Team 1' / 'Team 2' or extracting them from the payload is required.
                    const { data: matchMeta } = await supabase.from('sim_matches').select('team1_name, team2_name').eq('id', matchId).single();
                    const t1Name = matchMeta?.team1_name || 'Team 1';
                    const t2Name = matchMeta?.team2_name || 'Team 2';

                    const { gameStates: legacyGameStates, winner } = await postProcessLog(rawLog, t1Name, t2Name, deck1, deck2, cardDictionary);
                    
                    if (winner) {
                        const finalLegacyReplay = processReplay(legacyGameStates);
                        await supabase.from('sim_matches').update({ winner, game_states: finalLegacyReplay } as any).eq('id', matchId);
                        console.log(`[DB] Legacy replay and winner saved for ${matchId}.`);
                    } else {
                        console.warn(`[PROCESS] No winner found for ${matchId} in legacy log.`);
                        await supabase.from('sim_matches').update({ winner: 'Draw' } as any).eq('id', matchId);
                    }

                    setTimeout(async () => {
                        const { data: match, error: fetchErr } = await supabase.from('sim_matches').select('argentum_game_states').eq('id', matchId).single();
                        if (fetchErr || !match?.argentum_game_states || (match.argentum_game_states as any[]).length === 0) {
                            console.error(`[ENRICH] Could not fetch argentum_game_states for match ${matchId}:`, fetchErr);
                            return;
                        }
                        
                        const rawStates = match.argentum_game_states as any[];
                        const compressedStates = compressGameStates(rawStates);
                        const enrichedStates = await enrichGameStates(compressedStates, matchId);
                        
                        const { error: replayError } = await supabase.from('sim_matches').update({ argentum_game_states: enrichedStates } as any).eq('id', matchId);
                        if (replayError) console.error(`[DB] Enriched replay update error for ${matchId}:`, replayError);
                        else console.log(`[DB] Enriched replay successfully saved for ${matchId}.`);
                        
                        const winnerTeamId = [
                            { name: t1Name, id: team1Id }, 
                            { name: t2Name, id: team2Id }
                        ].find(t => t.name === winner)?.id ?? null;
                        
                        const { data: scheduleRow } = await supabase.from('schedule').select('id, weekly_matchup_id').eq('sim_match_id', matchId).maybeSingle();
                        
                        if (scheduleRow) {
                            const { error: scheduleError } = await supabase
                                .from('schedule')
                                .update({ 
                                    status: 'completed', 
                                    winner_team_id: winnerTeamId,
                                    total_steps: compressedStates.length
                                } as any)
                                .eq('id', scheduleRow.id);
                                
                            if (scheduleError) console.error(`[DB] Schedule update error:`, scheduleError);
                            else console.log(`[DB] Schedule completed. Winner: ${winnerTeamId ?? 'draw'}`);

                            if (scheduleRow.weekly_matchup_id) {
                                const webhookUrl = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || "https://www.thedynastycube.com";
                                try {
                                    const webhookRes = await fetch(`${webhookUrl}/api/record-sim-result`, {
                                        method: 'POST',
                                        headers: { 'Content-Type': 'application/json' },
                                        body: JSON.stringify({
                                            weeklyMatchupId: scheduleRow.weekly_matchup_id,
                                            winnerTeamId,
                                        }),
                                    });
                                    if (!webhookRes.ok) console.error(`[WEBHOOK] Failed! HTTP ${webhookRes.status}`);
                                } catch (webhookErr) {
                                    console.error(`[WEBHOOK] Fatal fetch error:`, webhookErr);
                                }
                            }
                        }
                    }, 5000);
                } catch (procErr) {
                     console.error(`[PROCESS_ERR] Error parsing match ${matchId}:`, procErr);
                }
            });
            
        } catch (e) {
            console.error('[HTTP] Failed to parse request body', e);
            res.writeHead(500);
            res.end(JSON.stringify({ error: 'Invalid payload' }));
        }
    });
}

// ── HTTP SERVER ROUTING ──────────────────────────────────────────
const server = http.createServer((req, res) => {
    // Health check endpoint (Used by Digital Ocean)
    if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
        res.writeHead(200);
        return res.end('ok');
    }
    
    // Process Execution endpoint
    if (req.method === 'POST' && req.url === '/run-match') {
        return handleRunMatch(req, res);
    }
    
    res.writeHead(404);
    res.end('Not Found');
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
    console.log(`[SERVER] Listening on port ${PORT}`);
});

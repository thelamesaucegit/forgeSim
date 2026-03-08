// src/forgesim/parser.ts

import * as fs from "fs/promises";
import * as path from "path";

// --- TYPE DEFINITIONS ---
export interface Card {
  id: string;
  name: string;
  isTapped?: boolean;
  isAttacking?: boolean;
  isBlocked?: boolean;
}

export interface PlayerState {
  name: string;
  life: number;
  handSize: number;
  librarySize: number;
  battlefield: Card[];
  graveyard: Card[];
  exile: Card[];
}

export interface GameState {
  turn: number;
  activePlayer: string;
  players: Record<string, PlayerState>;
  winner?: string;
  phase?: string;
}

// This interface mirrors the structure of the JSON we now get from Java
interface GameLogEntry {
    message: string;
    type: string;
    player?: string;
    card?: {
        id: number;
        name: string;
    };
    value?: number;
    // Parameters can hold additional context, like zone moves
    params?: {
        card?: { id: number, name: string };
        fromZone?: string;
        toZone?: string;
        player?: string;
        // Other params can be added as we discover them
    }
}

// Main orchestrator function, now simplified for JSON
export async function postProcessLog(
    rawLog: string, 
    validTeamIds: string[], 
    deck1Content: string, 
    deck2Content: string,
    matchId: string
): Promise<{ gameStates: GameState[], winner: string | null }> {

    const lines = rawLog.split('\n').filter(line => line.trim().startsWith('{') || line.startsWith('JSON_GAME_RESULT'));
    const LOGS_DIR = path.join(process.cwd(), "logs");

    // The first event should be player setup from the old log format
    const { player1, player2 } = findPlayerNamesFromRawLog(rawLog, validTeamIds);
    if (!player1 || !player2) {
        console.error("[PARSER_FATAL] Could not identify both players in the raw log.");
        return { gameStates: [], winner: null };
    }

    const initialState = getInitialState(player1, player2, deck1Content, deck2Content);
    let currentState = JSON.parse(JSON.stringify(initialState));
    const allGameStates: GameState[] = [JSON.parse(JSON.stringify(initialState))];
    
    for (const line of lines) {
        if (line.startsWith("JSON_GAME_RESULT:")) continue; // Handle winner at the end

        try {
            const event: GameLogEntry = JSON.parse(line);
            const stateChanged = applyJsonEvent(currentState, event);
            if (stateChanged) {
                allGameStates.push(JSON.parse(JSON.stringify(currentState)));
            }
        } catch (e) {
            console.warn(`[PARSER_WARN] Could not parse line as JSON: ${line}`);
        }
    }
    
    const winner = findWinner(lines, [player1, player2]);
    if (winner && allGameStates.length > 0) {
       allGameStates[allGameStates.length - 1].winner = winner;
    }

    // Diagnostic step remains
    try {
        const turnsToLog = allGameStates.filter(gs => gs.turn <= 4);
        const debugFilePath = path.join(LOGS_DIR, `${matchId}-debug-turns.json`);
        await fs.writeFile(debugFilePath, JSON.stringify(turnsToLog, null, 2));
        console.log(`[PARSER_DEBUG] Wrote first 4 turns to ${debugFilePath}`);
    } catch (e) {
        console.error("[PARSER_DEBUG] Failed to write debug file:", e);
    }

    return { gameStates: allGameStates, winner };
}

// --- The New Core Logic: Applying a structured event ---
function applyJsonEvent(state: GameState, event: GameLogEntry): boolean {
    if (!event.type) return false;

    switch(event.type) {
        case 'TURN_CHANGE':
            if (event.value === undefined || !event.player) return false;
            state.turn = event.value;
            state.activePlayer = event.player;
            if (state.turn > 1 && state.players[event.player]) {
                state.players[event.player].librarySize--;
                state.players[event.player].handSize++;
            }
            return true;

        case 'PHASE':
            if (event.player) {
                state.phase = `${event.player}'s ${event.message} step`;
                return true;
            }
            return false;

        case 'DAMAGE':
            if (event.params?.player && state.players[event.params.player] && event.value) {
                state.players[event.params.player].life -= event.value;
                return true;
            }
            return false;

        case 'ZONE_MOVE':
            const { card, fromZone, toZone } = event.params || {};
            if (!card || !fromZone || !toZone) return false;
            
            let ownerName: string | null = null;
            let foundCard: Card | undefined;
            const cardIdStr = String(card.id);

            // Find and remove card from its original zone
            for (const pName in state.players) {
                const p = state.players[pName];
                const zone = (p as any)[fromZone.toLowerCase()];
                if (Array.isArray(zone)) {
                    const cardIndex = zone.findIndex((c: Card) => c.id === cardIdStr);
                    if (cardIndex > -1) {
                        ownerName = pName;
                        foundCard = zone.splice(cardIndex, 1)[0];
                        break;
                    }
                }
            }

            // If card was found, add it to the new zone
            if (ownerName && foundCard) {
                const targetZone = (state.players[ownerName] as any)[toZone.toLowerCase()];
                if (Array.isArray(targetZone)) {
                    targetZone.push(foundCard);
                    return true;
                }
            }
            return false;
            
        case 'PLAY': // This covers lands played, and potentially other permanents
             if (event.card && event.player && state.players[event.player]) {
                 state.players[event.player].battlefield.push({ id: String(event.card.id), name: event.card.name });
                 if(event.message.toLowerCase().includes('land')) { // only decrement hand for lands
                    state.players[event.player].handSize--;
                 }
                 return true;
             }
             return false;

        case 'CAST_SPELL':
             if (event.player && state.players[event.player]) {
                 state.players[event.player].handSize--;
                 return true;
             }
             return false;
    }

    return false;
}

// --- UTILITY AND SETUP FUNCTIONS ---
function getInitialState(p1Name: string, p2Name: string, d1Content: string, d2Content: string): GameState {
    const countCards = (content: string): number => {
        return content.split('\n').reduce((count, line) => {
            const trimmed = line.trim();
            if (trimmed && !trimmed.startsWith('[') && trimmed.match(/^\d+\s+.+/)) {
                const quantityMatch = trimmed.match(/^(\d+)\s/);
                return count + (quantityMatch ? parseInt(quantityMatch[1], 10) : 0);
            }
            return count;
        }, 0);
    };
    const deck1Size = countCards(d1Content);
    const deck2Size = countCards(d2Content);
    
    const state: GameState = { turn: 0, activePlayer: "", players: {} };
    state.players[p1Name] = { name: p1Name, life: 20, handSize: 7, librarySize: deck1Size - 7, battlefield: [], graveyard: [], exile: [] };
    state.players[p2Name] = { name: p2Name, life: 20, handSize: 7, librarySize: deck2Size - 7, battlefield: [], graveyard: [], exile: [] };
    return state;
}

function findPlayerNamesFromRawLog(rawLog: string, validTeamIds: string[]): { player1: string | null, player2: string | null } {
    const regex = /^(Ai\(\d+\)-.*? \(AI: .*?\)) vs (Ai\(\d+\)-.*? \(AI: .*?\))/m; // m for multi-line
    const match = rawLog.match(regex);
    if (match && match[1] && match[2]) {
        const p1 = match[1].trim();
        const p2 = match[2].trim();
        if (validTeamIds.some(id => p1.toLowerCase().includes(id)) && validTeamIds.some(id => p2.toLowerCase().includes(id))) {
            return { player1: p1, player2: p2 };
        }
    }
    return { player1: null, player2: null };
}

function findWinner(lines: string[], players: string[]): string | null {
    for (const line of lines.slice().reverse()) {
        if (line.startsWith("JSON_GAME_RESULT:")) {
            try {
                const result = JSON.parse(line.substring("JSON_GAME_RESULT:".length));
                if (result.winner && players.includes(result.winner)) {
                    return result.winner;
                }
            } catch(e) { console.error("Failed to parse winner JSON:", e); }
        }
    }
    return null;
}

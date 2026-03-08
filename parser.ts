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

// This interface mirrors the structure of the JSON DTO we now get from Java
interface GameLogEntry {
    type: string;
    message: string;
    player?: string;
    card?: {
        id: number;
        name: string;
    };
    value?: number;
    params?: {
        card?: { id: number, name: string };
        fromZone?: string;
        toZone?: string;
        player?: string;
        [key: string]: any; // Allow other params
    }
}

// Main orchestrator function
export async function postProcessLog(
    rawLog: string, 
    validTeamIds: string[], 
    deck1Content: string, 
    deck2Content: string,
    matchId: string
): Promise<{ gameStates: GameState[], winner: string | null }> {

    const lines = rawLog.split('\n').filter(line => line.trim() !== '');
    const LOGS_DIR = path.join(process.cwd(), "logs");

    const { player1, player2 } = findPlayerNamesFromRawLog(rawLog, validTeamIds);
    if (!player1 || !player2) {
        console.error("[PARSER_FATAL] Could not identify both players in the log.");
        return { gameStates: [], winner: null };
    }

    const initialState = getInitialState(player1, player2, deck1Content, deck2Content);
    let currentState = JSON.parse(JSON.stringify(initialState));
    const allGameStates: GameState[] = [JSON.parse(JSON.stringify(initialState))];
    
    for (const line of lines) {
        if (line.startsWith("JSON_GAME_RESULT:")) {
            continue; // Final winner line is handled at the end
        }

        try {
            // We only care about lines that are valid JSON objects
            if (line.trim().startsWith("{")) {
                const event: GameLogEntry = JSON.parse(line);
                const stateChanged = applyJsonEvent(currentState, event);
                if (stateChanged) {
                    allGameStates.push(JSON.parse(JSON.stringify(currentState)));
                }
            }
        } catch (e) {
            // console.warn(`[PARSER_WARN] Could not parse line as JSON: ${line}`);
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
        case 'TURN':
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
            } else {
                state.phase = event.message;
            }
            return true;

        case 'DAMAGE':
            const targetPlayerName = event.params?.player as string;
            if (targetPlayerName && state.players[targetPlayerName] && event.value) {
                state.players[targetPlayerName].life -= event.value;
                return true;
            }
            // Damage can also be to a creature, which the ZONE_MOVE event will handle
            return false;

        case 'ZONE_MOVE':
            const { card, fromZone, toZone, player: owner } = event.params || {};
            if (!card || !fromZone || !toZone || !owner) return false;
            
            const cardIdStr = String(card.id);
            const sourcePlayer = state.players[owner];
            if (!sourcePlayer) return false;

            const fromArray = (sourcePlayer as any)[fromZone.toLowerCase()];
            const toArray = (sourcePlayer as any)[toZone.toLowerCase()];
            if (!Array.isArray(fromArray) || !Array.isArray(toArray)) return false;

            const cardIndex = fromArray.findIndex((c: Card) => c.id === cardIdStr);
            if (cardIndex > -1) {
                const [movedCard] = fromArray.splice(cardIndex, 1);
                toArray.push(movedCard);
                return true;
            }
            return false;
            
        case 'PLAY':
             if (event.card && event.player && state.players[event.player]) {
                 state.players[event.player].battlefield.push({ id: String(event.card.id), name: event.card.name });
                 // In Forge, playing a land also triggers a "ZONE_MOVE" from hand to play, so handsize is handled there.
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
    const regex = /^(Ai\(\d+\)-.*? \(AI: .*?\)) vs (Ai\(\d+\)-.*? \(AI: .*?\))/m;
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

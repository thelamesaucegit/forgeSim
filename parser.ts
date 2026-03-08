// src/forgesim/parser.ts

import * as fs from "fs/promises";
import * as path from "path";

// --- TYPE DEFINITIONS ---
// These match the data we will send from the client-side ReplayPlayer
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

// This interface represents the JSON object we now get from the Java side
interface GameLogEntry {
    message: string;
    type: string;
    player: string;
    card: {
        id: number;
        name: string;
    };
    value: number;
    // Other fields from GameLogEntry can be added here if needed
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

    const { player1, player2 } = findPlayerNames(lines, validTeamIds);
    if (!player1 || !player2) {
        console.error("[PARSER_FATAL] Could not identify both players in the log.");
        return { gameStates: [], winner: null };
    }

    const initialState = getInitialState(player1, player2, deck1Content, deck2Content);
    let currentState = JSON.parse(JSON.stringify(initialState));
    const allGameStates: GameState[] = [JSON.parse(JSON.stringify(initialState))];
    
    for (const line of lines) {
        if (line.startsWith("JSON_GAME_RESULT:")) {
            // Final winner line is handled separately
            continue;
        }

        try {
            const event: GameLogEntry = JSON.parse(line);
            const stateChanged = applyJsonEvent(currentState, event);
            if (stateChanged) {
                allGameStates.push(JSON.parse(JSON.stringify(currentState)));
            }
        } catch (e) {
            // Ignore lines that are not valid JSON
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
            }
            return true;

        case 'DAMAGE':
            const targetPlayer = event.message.match(/deals \d+ damage to (Ai\(\d\)-.*? \(AI: .*?\))/);
            if (targetPlayer && targetPlayer[1] && state.players[targetPlayer[1]]) {
                state.players[targetPlayer[1]].life -= event.value;
                return true;
            }
            break;

        case 'ZONE_MOVE':
            // This is the most important event. It handles everything moving.
            const fromZoneMatch = event.message.match(/from (\w+)/);
            const toZoneMatch = event.message.match(/to (\w+)/);
            if (!fromZoneMatch || !toZoneMatch || !event.card) return false;
            
            const from = fromZoneMatch[1].toLowerCase();
            const to = toZoneMatch[1].toLowerCase();
            const card: Card = { id: String(event.card.id), name: event.card.name };
            
            // Remove from the 'from' zone
            let cardFound = false;
            for (const pName in state.players) {
                const p = state.players[pName];
                const fromArray = (p as any)[from];
                if (Array.isArray(fromArray)) {
                    const cardIndex = fromArray.findIndex((c: Card) => c.id === card.id);
                    if (cardIndex > -1) {
                        fromArray.splice(cardIndex, 1);
                        cardFound = true;
                        break;
                    }
                }
            }

            // Add to the 'to' zone (assuming the event's player is the owner)
            if (event.player && state.players[event.player]) {
                const p = state.players[event.player];
                const toArray = (p as any)[to];
                if (Array.isArray(toArray)) {
                    toArray.push(card);
                    return true;
                }
            }
            return cardFound;

        case 'PLAY':
            if (event.card && event.player && state.players[event.player]) {
                 state.players[event.player].battlefield.push({ id: String(event.card.id), name: event.card.name });
                 state.players[event.player].handSize--;
                 return true;
            }
            break;

        case 'CAST_SPELL':
             if (event.player && state.players[event.player]) {
                 state.players[event.player].handSize--;
                 return true;
             }
             break;
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

function findPlayerNames(lines: string[], validTeamIds: string[]): { player1: string | null, player2: string | null } {
    const regex = /^(Ai\(\d+\)-.*? \(AI: .*?\)) vs (Ai\(\d+\)-.*? \(AI: .*?\))/;
    for (const line of lines) {
        const match = line.match(regex);
        if (match && match[1] && match[2]) {
            const p1 = match[1].trim();
            const p2 = match[2].trim();
            if (validTeamIds.some(id => p1.toLowerCase().includes(id)) && validTeamIds.some(id => p2.toLowerCase().includes(id))) {
                return { player1: p1, player2: p2 };
            }
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
            } catch(e) { /* ignore parse error */ }
        }
    }
    return null;
}

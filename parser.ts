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
interface JsonEvent {
    type: string;
    turnNumber?: number;
    turnOwner?: { name: string };
    player?: { name: string };
    phase?: string;
    card?: { id: number, name: string };
    land?: { id: number, name: string };
    from?: string;
    to?: string;
    amount?: number;
    isCombat?: boolean;
    attacks?: { [defender: string]: { id: number, name: string }[] };
}

// Main orchestrator function
export async function postProcessLog(
    rawLog: string, 
    validTeamIds: string[], 
    deck1Content: string, 
    deck2Content: string,
    matchId: string
): Promise<{ gameStates: GameState[], winner: string | null }> {

    const lines = rawLog.split('\n');
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
        if (line.startsWith("JSON_EVENT:")) {
            try {
                const jsonPart = line.substring("JSON_EVENT:".length);
                const event: JsonEvent = JSON.parse(jsonPart);
                const stateChanged = applyJsonEvent(currentState, event);
                if (stateChanged) {
                    allGameStates.push(JSON.parse(JSON.stringify(currentState)));
                }
            } catch (e) {
                console.warn(`[PARSER_WARN] Could not parse line as JSON: ${line}`);
            }
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
function applyJsonEvent(state: GameState, event: JsonEvent): boolean {
    if (!event.type) return false;
    let stateChanged = false;

    switch(event.type) {
        case 'TURN_BEGAN':
            if (event.turnNumber !== undefined && event.turnOwner?.name) {
                state.turn = event.turnNumber;
                state.activePlayer = event.turnOwner.name;
                if (state.turn > 1 && state.players[state.activePlayer]) {
                    state.players[state.activePlayer].librarySize--;
                    state.players[state.activePlayer].handSize++;
                }
                stateChanged = true;
            }
            break;

        case 'PHASE_CHANGED':
            if (event.player?.name && event.phase) {
                state.phase = `${event.player.name}'s ${event.phase} step`;
                stateChanged = true;
            }
            break;

        case 'PLAYER_DAMAGED':
            if (event.player?.name && state.players[event.player.name] && event.amount !== undefined) {
                state.players[event.player.name].life -= event.amount;
                stateChanged = true;
            }
            break;

        case 'ZONE_CHANGE':
            const { card, from, to } = event;
            if (!card || !from || !to) break;

            const cardIdStr = String(card.id);
            
            for (const pName in state.players) {
                const player = state.players[pName];
                const fromZone = (player as any)[from.toLowerCase()];
                const toZone = (player as any)[to.toLowerCase()];

                if (Array.isArray(fromZone)) {
                    const cardIndex = fromZone.findIndex((c: Card) => c.id === cardIdStr);
                    if (cardIndex > -1) {
                        const [movedCard] = fromZone.splice(cardIndex, 1);
                        if (Array.isArray(toZone)) {
                            toZone.push(movedCard);
                            stateChanged = true;
                        }
                        break; 
                    }
                }
            }
            break;
            
        case 'LAND_PLAYED':
             if (event.land && event.player?.name && state.players[event.player.name]) {
                 state.players[event.player.name].battlefield.push({ id: String(event.land.id), name: event.land.name });
                 stateChanged = true;
             }
             break;

        case 'SPELL_CAST':
             if (event.player?.name && state.players[event.player.name]) {
                 state.players[event.player.name].handSize--;
                 stateChanged = true;
             }
             break;
    }

    return stateChanged;
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
        if (validTeamIds.some(id => p1.toLowerCase().includes(id.toLowerCase())) && validTeamIds.some(id => p2.toLowerCase().includes(id.toLowerCase()))) {
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

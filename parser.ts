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
    from?: string; // e.g., "ZoneView[player=p1, zoneType=Library]"
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

// --- Helper function to parse the ZoneView string ---
function parseZoneString(zoneStr: string): { player: string, zone: string } | null {
    const match = zoneStr.match(/ZoneView\[player=([^,]+), zoneType=([^\]]+)\]/);
    if (match && match[1] && match[2]) {
        // The player name can be 'null' for the stack
        const player = match[1] === 'null' ? null : match[1];
        return { player, zone: match[2].toLowerCase() };
    }
    return null;
}

// --- The New Core Logic: Applying a structured event ---
function applyJsonEvent(state: GameState, event: JsonEvent): boolean {
    let stateChanged = false;

    switch(event.type) {
        case 'TURN_BEGAN':
            if (event.turnNumber !== undefined && event.turnOwner?.name) {
                state.turn = event.turnNumber;
                state.activePlayer = event.turnOwner.name;
                // Draw step is handled by its own ZONE_CHANGE event
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
            if (!event.card || !event.from || !event.to) break;

            const fromData = parseZoneString(event.from);
            const toData = parseZoneString(event.to);
            if (!fromData || !toData) break;

            const cardIdStr = String(event.card.id);
            let cardToMove: Card | undefined;
            
            // Find and remove the card from the source zone
            if (fromData.player && state.players[fromData.player]) {
                const sourcePlayer = state.players[fromData.player];
                const sourceZone = (sourcePlayer as any)[fromData.zone];
                if (Array.isArray(sourceZone)) {
                    const cardIndex = sourceZone.findIndex((c: Card) => c.id === cardIdStr);
                    if (cardIndex > -1) {
                        [cardToMove] = sourceZone.splice(cardIndex, 1);
                        stateChanged = true;
                    }
                }
            }
            
            // Add the card to the destination zone
            if (cardToMove && toData.player && state.players[toData.player]) {
                const destPlayer = state.players[toData.player];
                const destZone = (destPlayer as any)[toData.zone];
                if (Array.isArray(destZone)) {
                    destZone.push(cardToMove);
                }
            }

            // Update hand/library sizes based on zone moves
            if (stateChanged) {
                 if (fromData.zone === 'library' && fromData.player) state.players[fromData.player].librarySize--;
                 if (toData.zone === 'library' && toData.player) state.players[toData.player].librarySize++;
                 if (fromData.zone === 'hand' && fromData.player) state.players[fromData.player].handSize--;
                 if (toData.zone === 'hand' && toData.player) state.players[toData.player].handSize++;
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
    for (const line of lines) { // Check from the start
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

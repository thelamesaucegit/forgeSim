// src/forgesim/parser.ts

import * as fs from "fs/promises";
import * as path from "path";

// --- TYPE DEFINITIONS ---
// These are the core data structures used throughout the replay system.
export interface Card {
  id: string;
  name: string;
  isTapped?: boolean;
  isAttacking?: boolean;
  isBlocked?: boolean;
  cardType?: string; // To be enriched by the ReplayProcessor
}

export interface PlayerState {
  name:string;
  life: number;
  hand: Card[];
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
  // A temporary zone for visual representation of spells being cast.
  stack: Card[]; 
}

// This interface mirrors the structure of the JSON DTO we now get from Java
interface JsonEvent {
    type: string;
    turnNumber?: number;
    turnOwner?: { name: string };
    player?: { name: string };
    phase?: string;
    card?: { id: number; name: string };
    land?: { id: number; name: string };
    from?: string;
    to?: string;
    amount?: number;
    isCombat?: boolean;
}

// --- Main Parser Logic ---
export async function postProcessLog(
    rawLog: string, 
    validTeamIds: string[], 
    deck1Content: string, 
    deck2Content: string,
    matchId: string,
    cardDictionary: Map<string, string> // The crucial new argument from server.ts
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
    
    // The parser's job is just to create a raw state for every single event.
    // The ReplayProcessor will handle filtering and pacing later.
    for (const line of lines) {
        if (line.startsWith("JSON_EVENT:")) {
            try {
                const jsonPart = line.substring("JSON_EVENT:".length);
                const event: JsonEvent = JSON.parse(jsonPart);
                applyJsonEvent(currentState, event, cardDictionary);
                allGameStates.push(JSON.parse(JSON.stringify(currentState)));
            } catch (e) {
                // Non-JSON lines or parse errors are ignored
            }
        }
    }
    
    const winner = findWinner(lines, [player1, player2]);
    if (winner && allGameStates.length > 0) {
       allGameStates[allGameStates.length - 1].winner = winner;
    }

    // This debug file now represents the *raw, unfiltered* event stream.
    try {
        const debugFilePath = path.join(LOGS_DIR, `${matchId}-debug-raw-states.json`);
        await fs.writeFile(debugFilePath, JSON.stringify(allGameStates, null, 2));
        console.log(`[PARSER_DEBUG] Wrote raw game states to ${debugFilePath}`);
    } catch (e) {
        console.error("[PARSER_DEBUG] Failed to write debug file:", e);
    }

    return { gameStates: allGameStates, winner };
}

// --- Helper function to parse the ZoneView string ---
function parseZoneString(zoneStr: string): { player: string | null, zone: string } | null {
    const match = zoneStr.match(/ZoneView\[player(?:\\u003d|=)([^,]+), zoneType(?:\\u003d|=)([^\]]+)\]/);
    if (match && match[1] && match[2]) {
        const player = match[1] === 'null' ? null : match[1];
        return { player, zone: match[2].toLowerCase() };
    }
    return null;
}

// --- Event Application Logic ---
function applyJsonEvent(state: GameState, event: JsonEvent, cardDictionary: Map<string, string>): void {
    if (!event.type) return;

    switch(event.type) {
        case 'TURN_BEGAN':
            if (event.turnNumber !== undefined && event.turnOwner?.name) {
                state.turn = event.turnNumber;
                state.activePlayer = event.turnOwner.name;
            }
            break;

        case 'PHASE_CHANGED':
            if (event.player?.name && event.phase) {
                state.phase = `${event.player.name}'s ${event.phase} step`;
            }
            break;

        case 'PLAYER_DAMAGED':
            if (event.player?.name && state.players[event.player.name] && event.amount !== undefined) {
                state.players[event.player.name].life -= event.amount;
            }
            break;

        case 'ZONE_CHANGE':
            const { card, from, to } = event;
            if (!card || !from || !to) break;

            const fromData = parseZoneString(from);
            const toData = parseZoneString(to);
            if (!fromData || !toData) break;

            const cardIdStr = String(card.id);
            const cardType = cardDictionary.get(card.name);
            const cardToMove: Card = { id: cardIdStr, name: card.name, cardType };

            // Find and remove the card from its source zone
            let cardFoundAndRemoved = false;
            if (fromData.zone === 'library') {
                 // We don't track library cards, just decrement the count.
                 if(fromData.player && state.players[fromData.player]) {
                    state.players[fromData.player].librarySize--;
                    cardFoundAndRemoved = true;
                 }
            } else if (fromData.zone === 'stack') {
                const stackIndex = state.stack.findIndex(c => c.id === cardIdStr);
                if (stackIndex > -1) {
                    state.stack.splice(stackIndex, 1);
                    cardFoundAndRemoved = true;
                }
            } else if (fromData.player && state.players[fromData.player]) {
                const sourceZone = (state.players[fromData.player] as any)[fromData.zone];
                if (Array.isArray(sourceZone)) {
                    const cardIndex = sourceZone.findIndex(c => c.id === cardIdStr);
                    if (cardIndex > -1) {
                        sourceZone.splice(cardIndex, 1);
                        if (fromData.zone === 'hand') state.players[fromData.player].handSize--;
                        cardFoundAndRemoved = true;
                    }
                }
            }

            if (!cardFoundAndRemoved) return;

            // Add the card to its destination zone
            if (toData.zone === 'stack') {
                state.stack.push(cardToMove);
            } else if (toData.player && state.players[toData.player]) {
                const destZone = (state.players[toData.player] as any)[toData.zone];
                if (Array.isArray(destZone)) {
                    destZone.push(cardToMove);
                    if (toData.zone === 'hand') state.players[toData.player].handSize++;
                }
            }
            break;
    }
}

// --- UTILITY FUNCTIONS ---
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
    
    return {
        turn: 0,
        activePlayer: "",
        players: {
            [p1Name]: { name: p1Name, life: 20, hand: [], librarySize: deck1Size, battlefield: [], graveyard: [], exile: [] },
            [p2Name]: { name: p2Name, life: 20, hand: [], librarySize: deck2Size, battlefield: [], graveyard: [], exile: [] }
        },
        stack: []
    };
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
    for (const line of lines) {
        if (line.startsWith("JSON_GAME_RESULT:")) {
            try {
                const jsonStr = line.substring("JSON_GAME_RESULT:".length).replace(/\\n/g, '');
                const result = JSON.parse(jsonStr);
                if (result.winner && players.includes(result.winner)) {
                    return result.winner;
                }
            } catch(e) { console.error("Failed to parse winner JSON:", line, e); }
        }
    }
    return null;
}

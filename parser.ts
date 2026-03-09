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

// --- Main Parser Logic ---
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
    
    // --- Initial Hand Draw Simulation ---
    // The first 14 ZONE_CHANGE events are the initial hands.
    const initialDrawEvents = lines.map(line => {
        if(line.startsWith("JSON_EVENT:")) {
            try { return JSON.parse(line.substring("JSON_EVENT:".length)); } catch (e) { return null; }
        }
        return null;
    }).filter(e => e && e.type === "ZONE_CHANGE");

    const player1Hand = initialDrawEvents.slice(0, 7);
    const player2Hand = initialDrawEvents.slice(7, 14);

    player1Hand.forEach(e => applyJsonEvent(currentState, e));
    player2Hand.forEach(e => applyJsonEvent(currentState, e));
    // Save the state after initial hands are drawn
    allGameStates.push(JSON.parse(JSON.stringify(currentState)));


    // --- Process the rest of the game ---
    for (const line of lines) {
        if (line.startsWith("JSON_EVENT:")) {
            try {
                const jsonPart = line.substring("JSON_EVENT:".length);
                const event: JsonEvent = JSON.parse(jsonPart);

                // Skip initial draw events which we've already processed
                if (initialDrawEvents.includes(event)) continue;

                const isVisuallySignificant = applyJsonEvent(currentState, event);
                
                // Only save a new state if something visually changed
                if (isVisuallySignificant) {
                    allGameStates.push(JSON.parse(JSON.stringify(currentState)));
                }
            } catch (e) {
                // Non-JSON lines or parse errors are ignored
            }
        }
    }
    
    const winner = findWinner(lines, [player1, player2]);
    if (winner && allGameStates.length > 0) {
       allGameStates[allGameStates.length - 1].winner = winner;
    }

    try {
        const debugFilePath = path.join(LOGS_DIR, `${matchId}-debug-final.json`);
        await fs.writeFile(debugFilePath, JSON.stringify(allGameStates, null, 2));
        console.log(`[PARSER_DEBUG] Wrote final game state to ${debugFilePath}`);
    } catch (e) {
        console.error("[PARSER_DEBUG] Failed to write debug file:", e);
    }

    return { gameStates: allGameStates, winner };
}


// --- Helper to parse the ZoneView string ---
function parseZoneString(zoneStr: string): { player: string | null, zone: string } | null {
    // FIX: Regex now correctly handles the escaped '=' (\u003d)
    const match = zoneStr.match(/ZoneView\[player(?:\\u003d|=)([^,]+), zoneType(?:\\u003d|=)([^\]]+)\]/);
    if (match && match[1] && match[2]) {
        const player = match[1] === 'null' ? null : match[1];
        return { player, zone: match[2].toLowerCase() };
    }
    return null;
}

// --- Event application logic ---
function applyJsonEvent(state: GameState, event: JsonEvent): boolean {
    if (!event.type) return false;

    switch(event.type) {
        case 'TURN_BEGAN':
            if (event.turnNumber !== undefined && event.turnOwner?.name) {
                state.turn = event.turnNumber;
                state.activePlayer = event.turnOwner.name;
                return true; // Visually significant change
            }
            return false;

        case 'PHASE_CHANGED':
            if (event.player?.name && event.phase) {
                state.phase = `${event.player.name}'s ${event.phase} step`;
            }
            return false; // Not visually significant

        case 'PLAYER_DAMAGED':
            if (event.player?.name && state.players[event.player.name] && event.amount !== undefined) {
                state.players[event.player.name].life -= event.amount;
                return true; // Visually significant change
            }
            return false;

        case 'ZONE_CHANGE':
            const { card, from, to } = event;
            if (!card || !from || !to) return false;

            const fromData = parseZoneString(from);
            const toData = parseZoneString(to);
            if (!fromData || !toData) return false;

            const cardIdStr = String(card.id);
            const cardToMove: Card = { id: cardIdStr, name: card.name };
            
            let cardFoundAndRemoved = false;

            if (fromData.player && state.players[fromData.player]) {
                const sourceZone = (state.players[fromData.player] as any)[fromData.zone];
                if (Array.isArray(sourceZone)) {
                    const cardIndex = sourceZone.findIndex((c: Card) => c.id === cardIdStr);
                    if (cardIndex > -1) {
                        sourceZone.splice(cardIndex, 1);
                        cardFoundAndRemoved = true;
                    }
                }
            } else if (fromData.zone === 'stack') {
                // Card is coming from the stack, it doesn't exist in a player zone yet
                cardFoundAndRemoved = true;
            } else if (fromData.zone === 'library') {
                 // Card is being drawn or milled from library
                 cardFoundAndRemoved = true;
            }

            if (!cardFoundAndRemoved) return false; // If we couldn't find the card, abort.

            if (toData.player && state.players[toData.player]) {
                const destZone = (state.players[toData.player] as any)[toData.zone];
                if (Array.isArray(destZone)) {
                    destZone.push(cardToMove);
                }
            }
            
            // Update hand/library counts
            if (fromData.player && state.players[fromData.player]) {
                if(fromData.zone === 'library') state.players[fromData.player].librarySize--;
                if(fromData.zone === 'hand') state.players[fromData.player].handSize--;
            }
             if (toData.player && state.players[toData.player]) {
                if(toData.zone === 'library') state.players[toData.player].librarySize++;
                if(toData.zone === 'hand') state.players[toData.player].handSize++;
            }
            
            return true; // Zone changes are always visually significant
    }

    return false; // Default to not significant
}

// --- UTILITY FUNCTIONS ---
function getInitialState(p1Name: string, p2Name: string, d1Content: string, d2Content: string): GameState {
    const countCards = (content: string): number => content.split('\n').filter(line => line.trim() && !line.trim().startsWith('[')).length;
    const deck1Size = countCards(d1Content);
    const deck2Size = countCards(d2Content);
    
    return {
        turn: 0,
        activePlayer: "",
        players: {
            [p1Name]: { name: p1Name, life: 20, handSize: 0, librarySize: deck1Size, battlefield: [], graveyard: [], exile: [] },
            [p2Name]: { name: p2Name, life: 20, handSize: 0, librarySize: deck2Size, battlefield: [], graveyard: [], exile: [] }
        }
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

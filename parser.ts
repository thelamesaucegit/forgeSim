// src/forgesim/parser.ts

import * as fs from "fs/promises";
import * as path from "path";

// --- TYPE DEFINITIONS ---
export interface Card {
  id: string;
  name: string;
  cardType: string; // Enriched from the dictionary
  isTapped?: boolean;
}

export interface PlayerState {
  name: string;
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
  stack: Card[]; 
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
}

// --- Main Parser Logic ---
export async function postProcessLog(
    rawLog: string, 
    validTeamIds: string[], 
    deck1Content: string, 
    deck2Content: string,
    matchId: string,
    cardDictionary: Map<string, string>
): Promise<{ gameStates: GameState[], winner: string | null }> {

    const lines = rawLog.split('\n');
    const LOGS_DIR = path.join(process.cwd(), "logs");

    const { player1, player2 } = findPlayerNamesFromRawLog(rawLog, validTeamIds);
    if (!player1 || !player2) {
        console.error(`[PARSER_FATAL] Could not identify both players in the log. Valid IDs: ${validTeamIds.join(', ')}`);
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
                applyJsonEvent(currentState, event, cardDictionary);
                allGameStates.push(JSON.parse(JSON.stringify(currentState)));
            } catch (e) {
                // Ignore errors
            }
        }
    }
    
    const winner = findWinner(lines, [player1, player2]);
    if (winner && allGameStates.length > 0) {
       allGameStates[allGameStates.length - 1].winner = winner;
    }

    try {
        const debugFilePath = path.join(LOGS_DIR, `${matchId}-debug-raw-states.json`);
        await fs.writeFile(debugFilePath, JSON.stringify(allGameStates, null, 2));
        console.log(`[PARSER_DEBUG] Wrote raw game states to ${debugFilePath}`);
    } catch (e) {
        console.error("[PARSER_DEBUG] Failed to write debug file:", e);
    }

    return { gameStates: allGameStates, winner };
}

function parseZoneString(zoneStr: string): { player: string | null, zone: string } | null {
    const match = zoneStr.match(/ZoneView\[player(?:\\u003d|=)([^,]+), zoneType(?:\\u003d|=)([^\]]+)\]/);
    if (match && match[1] && match[2]) {
        const player = match[1] === 'null' ? null : match[1];
        return { player, zone: match[2].toLowerCase() };
    }
    return null;
}

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
            const cardData = event.card || event.land; // Handle both spell and land events
            if (!cardData || !event.from || !event.to) break;

            const fromData = parseZoneString(event.from);
            const toData = parseZoneString(event.to);
            if (!fromData || !toData) break;

            const cardIdStr = String(cardData.id);
            const cardType = cardDictionary.get(cardData.name) || 'Unknown';
            const cardToMove: Card = { id: cardIdStr, name: cardData.name, cardType };

            let cardFoundAndRemoved = false;
            let sourcePlayerName: string | null = fromData.player;

            if (fromData.zone === 'library' && sourcePlayerName && state.players[sourcePlayerName]) {
                state.players[sourcePlayerName].librarySize--;
                cardFoundAndRemoved = true;
            } else if (fromData.zone === 'stack') {
                const stackIndex = state.stack.findIndex(c => c.id === cardIdStr);
                if (stackIndex > -1) {
                    state.stack.splice(stackIndex, 1);
                    cardFoundAndRemoved = true;
                }
            } else if (sourcePlayerName && state.players[sourcePlayerName]) {
                const sourceZone = (state.players[sourcePlayerName] as any)[fromData.zone];
                if (Array.isArray(sourceZone)) {
                    const cardIndex = sourceZone.findIndex((c: Card) => c.id === cardIdStr);
                    if (cardIndex > -1) {
                        sourceZone.splice(cardIndex, 1);
                        cardFoundAndRemoved = true;
                    }
                }
            }

            if (!cardFoundAndRemoved) return;

            if (toData.zone === 'stack') {
                state.stack.push(cardToMove);
            } else if (toData.player && state.players[toData.player]) {
                const destZone = (state.players[toData.player] as any)[toData.zone];
                if (Array.isArray(destZone)) {
                    destZone.push(cardToMove);
                }
            }
            break;
    }
}

function getInitialState(p1Name: string, p2Name: string, d1Content: string, d2Content: string): GameState {
    const countCards = (content: string): number => {
        return content.split('\n').reduce((count, line) => {
            const trimmed = line.trim();
            if (trimmed.startsWith('[') || !trimmed) return count;
            const quantityMatch = trimmed.match(/^(\d+)\s/);
            return count + (quantityMatch ? parseInt(quantityMatch[1], 10) : 1);
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
        return { player1: match[1].trim(), player2: match[2].trim() };
    }
    return { player1: null, player2: null };
}

function findWinner(lines: string[], players: string[]): string | null {
    for (const line of lines) {
        if (line.startsWith("JSON_GAME_RESULT:")) {
            try {
                const jsonStr = line.substring("JSON_GAME_RESULT:".length).replace(/\r?\n|\r/g, '');
                const result = JSON.parse(jsonStr);
                if (result.winner && players.includes(result.winner)) {
                    return result.winner;
                }
            } catch(e) { console.error("Failed to parse winner JSON:", line, e); }
        }
    }
    return null;
}

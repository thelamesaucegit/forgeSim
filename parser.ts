// src/forgesim/parser.ts

import * as fs from "fs/promises";
import * as path from "path";

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

// Main function to orchestrate the parsing
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

    const cardIdMap = buildCardIdMap(lines);
    const initialState = getInitialState(player1, player2, deck1Content, deck2Content);
    let currentState = JSON.parse(JSON.stringify(initialState));
    const allGameStates: GameState[] = [JSON.parse(JSON.stringify(initialState))];
    
    for (const line of lines) {
        let stateChanged = false;
        
        const updateState = (newState: GameState | null) => {
            if (newState) {
                currentState = newState;
                stateChanged = true;
            }
        };

        // --- Event Parsing ---
        updateState(parseTurn(line, currentState));
        updateState(parsePhase(line, currentState));
        updateState(parsePlayerDamage(line, currentState));
        updateState(parseCast(line, currentState));
        updateState(parseResolve(line, currentState, cardIdMap));
        updateState(parseZoneChange(line, currentState));
        updateState(parseAttack(line, currentState, cardIdMap)); // Pass map to update IDs
        updateState(parseLand(line, currentState));
        
        if (stateChanged) {
            allGameStates.push(JSON.parse(JSON.stringify(currentState)));
        }
    }
    
    const winner = findWinner(lines, [player1, player2]);
    if (winner) {
        if(allGameStates.length > 0) {
           allGameStates[allGameStates.length - 1].winner = winner;
        }
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

// --- Sub-Parsers for each event type ---
const regexPlayerSetup = /^(Ai\(\d+\)-.*? \(AI: .*?\)) vs (Ai\(\d+\)-.*? \(AI: .*?\))/;
const regexTurn = /Turn: Turn (?<turnNum>\d+) \((?<player>.+)\)/;
const regexPhase = /^Phase: (.*)/;
const regexGameEnd = /Game Result:.*? (Ai\(\d+\)-.*? \(AI: .*?\)) has won!/;
const regexCast = /Add To Stack: (?<player>.+) cast (?<cardName>.+)/i;
const regexResolve = /Resolve Stack: (?<cardName>.+?) -/;
const regexPlayerDamage = /Damage: .* deals (?<damage>\d+) .*damage to (?<targetPlayer>Ai\(\d+\)-.*? \(AI: .*?\))/;
const regexZoneChange = /Zone Change: (?<cardName>.+?) \((?<cardId>\d+)\) was put into (?<to>\w+) from (?<from>\w+)/;
const regexAttack = /Combat: .* assigned (?<cardName>.+?) \((?<cardId>\d+)\) to attack/;
const regexLand = /Land: (?<player>.+) played (?<cardName>.+) \((?<cardId>\d+)\)/;

function parseTurn(line: string, state: GameState): GameState | null {
    const match = line.match(regexTurn);
    if (!match?.groups) return null;
    const player = match.groups.player.trim();
    state.turn = parseInt(match.groups.turnNum, 10);
    state.activePlayer = player;
    // The first turn of the game is not a draw step.
    if(state.turn > 1 && state.players[player]) {
        const activePlayer = state.players[player];
        activePlayer.librarySize--;
        activePlayer.handSize++;
    }
    return state;
}

function parsePhase(line: string, state: GameState): GameState | null {
    const match = line.match(regexPhase);
    if (!match || !match[1]) return null;
    state.phase = match[1].trim();
    return state;
}

function parsePlayerDamage(line: string, state: GameState): GameState | null {
    const match = line.match(regexPlayerDamage);
    if (!match?.groups) return null;
    const { damage, targetPlayer } = match.groups;
    if (state.players[targetPlayer]) {
        state.players[targetPlayer].life -= parseInt(damage, 10);
    }
    return state;
}

function parseCast(line: string, state: GameState): GameState | null {
    const match = line.match(regexCast);
    if (!match?.groups) return null;
    const { player } = match.groups;
    if (state.players[player]) {
        state.players[player].handSize--;
    }
    return state;
}

function parseResolve(line: string, state: GameState, cardIdMap: Map<string, string>): GameState | null {
    const match = line.match(regexResolve);
    if (!match?.groups) return null;
    
    const { cardName } = match.groups;
    const cleanCardName = cardName.trim();
    const isCreature = line.includes(" - Creature");
    const activePlayer = state.activePlayer;

    if (isCreature && activePlayer && state.players[activePlayer]) {
        // Create with a temporary ID. This ID will be updated when the card is first referenced in another event.
        const tempId = `temp-${cleanCardName}-${Date.now()}`;
        state.players[activePlayer].battlefield.push({ id: tempId, name: cleanCardName });
    } else if (!isCreature && !line.includes(" - Land")) {
        if (activePlayer && state.players[activePlayer]) {
            const tempId = `spell-${cleanCardName}-${Date.now()}`;
            state.players[activePlayer].graveyard.push({ id: tempId, name: cleanCardName });
        }
    }
    return state;
}

function parseZoneChange(line: string, state: GameState): GameState | null {
    const match = line.match(regexZoneChange);
    if (!match?.groups) return null;
    
    const { cardId, to } = match.groups;
    let ownerName: string | null = null;
    let card: Card | undefined;

    for(const pName in state.players) {
        const cardIndex = state.players[pName].battlefield.findIndex(c => c.id === cardId);
        if(cardIndex > -1) {
            ownerName = pName;
            card = state.players[pName].battlefield.splice(cardIndex, 1)[0];
            break;
        }
    }

    if (ownerName && card) {
        if(to.toLowerCase() === 'graveyard') state.players[ownerName].graveyard.push(card);
        else if (to.toLowerCase() === 'exile') state.players[ownerName].exile.push(card);
    }
    return state;
}

function parseAttack(line: string, state: GameState, cardIdMap: Map<string, string>): GameState | null {
    const match = line.match(regexAttack);
    if (!match?.groups) return null;
    const { cardName, cardId } = match.groups;
    
    // First time we see an ID for a creature, it might have a temporary ID.
    const tempCard = findTempCardOnBattlefield(state, cardName);
    if (tempCard) {
        tempCard.id = cardId; // Update the ID from temp to real
        tempCard.isAttacking = true;
    } else {
        const card = findCardOnBattlefield(state, cardId);
        if (card) card.isAttacking = true;
    }
    return state;
}

function parseLand(line: string, state: GameState): GameState | null {
    const match = line.match(regexLand);
    if (!match?.groups) return null;
    const { player, cardName, cardId } = match.groups;
    const trimmedPlayerName = player.trim();
    if(state.players[trimmedPlayerName]) {
        state.players[trimmedPlayerName].battlefield.push({ id: cardId, name: cardName });
        state.players[trimmedPlayerName].handSize--;
    }
    return state;
}


// --- Utility and Setup Functions ---
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
    
    const state: GameState = {
        turn: 0, activePlayer: "", players: {}
    };
    state.players[p1Name] = { name: p1Name, life: 20, handSize: 7, librarySize: deck1Size - 7, battlefield: [], graveyard: [], exile: [] };
    state.players[p2Name] = { name: p2Name, life: 20, handSize: 7, librarySize: deck2Size - 7, battlefield: [], graveyard: [], exile: [] };
    return state;
}

function buildCardIdMap(lines: string[]): Map<string, string> {
    const cardIdMap = new Map<string, string>();
    const regex = /(?<cardName>.+?) \((?<cardId>\d+)\)/;
    for (const line of lines) {
        const match = line.match(regex);
        if (match?.groups) {
            const { cardName, cardId } = match.groups;
            const cleanCardName = cardName.trim();
            if (!cardIdMap.has(cleanCardName)) {
                cardIdMap.set(cleanCardName, cardId);
            }
        }
    }
    return cardIdMap;
}

function findPlayerNames(lines: string[], validTeamIds: string[]): { player1: string | null, player2: string | null } {
    const regex = /^(Ai\(\d+\)-.*? \(AI: .*?\)) vs (Ai\(\d+\)-.*? \(AI: .*?\))/;
    for (const line of lines) {
        const match = line.match(regex);
        if (match && match[1] && match[2]) {
            const p1 = match[1].trim();
            const p2 = match[2].trim();
            const p1IsValid = validTeamIds.some(id => p1.toLowerCase().includes(id.toLowerCase()));
            const p2IsValid = validTeamIds.some(id => p2.toLowerCase().includes(id.toLowerCase()));
            if(p1IsValid && p2IsValid) {
                return { player1: p1, player2: p2 };
            }
        }
    }
    return { player1: null, player2: null };
}

function findWinner(lines: string[], players: string[]): string | null {
    const regex = /Game Result:.*? (Ai\(\d+\)-.*? \(AI: .*?\)) has won!/;
    for (const line of lines.slice().reverse()) {
        const match = line.match(regex);
        if (match && match[1] && players.includes(match[1].trim())) {
            return match[1].trim();
        }
    }
    return null;
}

function findCardOnBattlefield(state: GameState, cardId: string): Card | null {
    for(const pName in state.players) {
        const card = state.players[pName].battlefield.find(c => c.id === cardId);
        if(card) return card;
    }
    return null;
}

function findTempCardOnBattlefield(state: GameState, cardName: string): Card | undefined {
    for (const playerName in state.players) {
        const card = state.players[playerName].battlefield.find((c) => c.name === cardName && c.id.startsWith('temp-'));
        if (card) return card;
    }
    return undefined;
}

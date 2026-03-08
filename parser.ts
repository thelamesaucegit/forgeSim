// src/forgesim/parser.ts

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
export function postProcessLog(
    rawLog: string, 
    validTeamIds: string[], 
    deck1Content: string, 
    deck2Content: string
): { gameStates: GameState[], winner: string | null } {

    const lines = rawLog.split('\n').filter(line => line.trim() !== '');

    // --- PASS 1: Pre-computation and setup ---
    const { player1, player2 } = findPlayerNames(lines, validTeamIds);
    if (!player1 || !player2) {
        console.error("[PARSER_FATAL] Could not identify both players in the log.");
        return { gameStates: [], winner: null };
    }

    const cardIdMap = buildCardIdMap(lines);

    const initialState = getInitialState(player1, player2, deck1Content, deck2Content);
    let currentState = JSON.parse(JSON.stringify(initialState));
    const allGameStates: GameState[] = [JSON.parse(JSON.stringify(initialState))];
    
    // --- PASS 2: Iterate and build game states ---
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
        updateState(parseAttack(line, currentState));
        
        if (stateChanged) {
            allGameStates.push(JSON.parse(JSON.stringify(currentState)));
        }
    }
    
    const winner = findWinner(lines, [player1, player2]);
    if (winner) {
        // Ensure the final state reflects the winner
        if(allGameStates.length > 0) {
           allGameStates[allGameStates.length - 1].winner = winner;
        }
    }

    return { gameStates: allGameStates, winner };
}

// --- Sub-Parsers for each event type ---

function parseTurn(line: string, state: GameState): GameState | null {
    const match = line.match(/Turn: Turn (?<turnNum>\d+) \((?<player>.+)\)/);
    if (!match?.groups) return null;
    const player = match.groups.player.trim();
    state.turn = parseInt(match.groups.turnNum, 10);
    state.activePlayer = player;
    if(state.turn > 1 && state.players[player]) {
        state.players[player].librarySize--;
        state.players[player].handSize++;
    }
    return state;
}

function parsePhase(line: string, state: GameState): GameState | null {
    const match = line.match(/^Phase: (.*)/);
    if (!match || !match[1]) return null;
    state.phase = match[1].trim();
    return state;
}

function parsePlayerDamage(line: string, state: GameState): GameState | null {
    const match = line.match(/Damage: .* deals (?<damage>\d+) .*damage to (?<targetPlayer>Ai\(\d+\)-.*? \(AI: .*?\))/);
    if (!match?.groups) return null;
    const { damage, targetPlayer } = match.groups;
    if (state.players[targetPlayer]) {
        state.players[targetPlayer].life -= parseInt(damage, 10);
    }
    return state;
}

function parseCast(line: string, state: GameState): GameState | null {
    const match = line.match(/Add To Stack: (?<player>.+) cast (?<cardName>.+)/i);
    if (!match?.groups) return null;
    const { player } = match.groups;
    if (state.players[player]) {
        state.players[player].handSize--;
    }
    return state;
}

function parseResolve(line: string, state: GameState, cardIdMap: Map<string, string>): GameState | null {
    const match = line.match(/Resolve Stack: (?<cardName>.+?) -/);
    if (!match?.groups) return null;
    
    const { cardName } = match.groups;
    const cardId = cardIdMap.get(cardName.trim());
    const isCreature = line.includes(" - Creature");

    if (isCreature && cardId) {
        if(state.activePlayer && state.players[state.activePlayer]) {
            state.players[state.activePlayer].battlefield.push({ id: cardId, name: cardName });
        }
    } else if (!isCreature && !line.includes(" - Land")) {
        // It's likely an instant or sorcery, move to graveyard.
        if (state.activePlayer && state.players[state.activePlayer]) {
            const tempId = `spell-${cardName.trim()}-${Date.now()}`;
            state.players[state.activePlayer].graveyard.push({ id: tempId, name: cardName.trim() });
        }
    }
    return state;
}

function parseZoneChange(line: string, state: GameState): GameState | null {
    const match = line.match(/Zone Change: (?<cardName>.+?) \((?<cardId>\d+)\) was put into (?<to>\w+) from (?<from>\w+)/);
    if (!match?.groups) return null;
    
    const { cardName, cardId, to } = match.groups;
    let ownerName: string | null = null;

    for(const pName in state.players) {
        const cardIndex = state.players[pName].battlefield.findIndex(c => c.id === cardId);
        if(cardIndex > -1) {
            ownerName = pName;
            const card = state.players[pName].battlefield.splice(cardIndex, 1)[0];
            if(to.toLowerCase() === 'graveyard') state.players[ownerName].graveyard.push(card);
            else if (to.toLowerCase() === 'exile') state.players[ownerName].exile.push(card);
            break;
        }
    }
    return state;
}

function parseAttack(line: string, state: GameState): GameState | null {
    const match = line.match(/Combat: .* assigned .* \((?<cardId>\d+)\) to attack/);
    if (!match?.groups) return null;
    const card = findCardOnBattlefield(state, match.groups.cardId);
    if(card) card.isAttacking = true;
    return state;
}


// --- Utility and Setup Functions ---

function getInitialState(p1Name: string, p2Name: string, d1Content: string, d2Content: string): GameState {
    const deck1Size = d1Content.split('\n').filter(line => line.trim() && !line.startsWith('[')).length;
    const deck2Size = d2Content.split('\n').filter(line => line.trim() && !line.startsWith('[')).length;
    
    const state: GameState = {
        turn: 0, activePlayer: "", stack: [], phase: "Setup", players: {}
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
            return { player1: match[1].trim(), player2: match[2].trim() };
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

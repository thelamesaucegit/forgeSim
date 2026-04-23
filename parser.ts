// /src/parser.ts
import { GameState, Card, PlayerState, JsonEvent, CardLocation } from './types.js';
import { parseZoneString, findPlayerNamesFromRawLog, findWinner } from './utils.js';

export async function postProcessLog(
    rawLog: string, 
    team1Name: string,
    team2Name: string,
    deck1Content: string, 
    deck2Content: string,
    cardDictionary: Map<string, string>
): Promise<{ gameStates: GameState[], winner: string | null }> {
    const lines = rawLog.split('\n');
    const { player1: rawP1Name, player2: rawP2Name } = findPlayerNamesFromRawLog(rawLog);

    if (!rawP1Name || !rawP2Name) {
        console.error("[PARSER] Could not identify players from log.");
        return { gameStates: [], winner: null };
    }

    const initialState = getInitialState(team1Name, team2Name, deck1Content, deck2Content);
    const gameStates: GameState[] = [initialState];
    
    for (const line of lines) {
        if (line.startsWith("JSON_EVENT:")) {
            try {
                const event: JsonEvent = JSON.parse(line.substring(11));
                const newState = applyJsonEvent(gameStates[gameStates.length - 1], event, cardDictionary, rawP1Name, rawP2Name, team1Name, team2Name);
                gameStates.push(newState);
                if (Object.values(newState.players).some(p => p.life <= 0)) break;
            } catch (e) {
                // console.error("Error parsing event:", e, "on line:", line);
            }
        }
    }
    
    const rawWinner = findWinner(lines, [rawP1Name, rawP2Name]);
    const finalWinner = rawWinner === rawP1Name ? team1Name : rawWinner === rawP2Name ? team2Name : null;

    if (finalWinner && gameStates.length > 0) {
        gameStates[gameStates.length - 1].winner = finalWinner;
    }
    return { gameStates, winner: finalWinner };
}

const findCardAndZone = (state: GameState, cardId: string): CardLocation | null => {
    for (const player of Object.values(state.players)) {
        for (const zoneName of ['battlefield', 'graveyard', 'exile', 'hand']) {
            const zone = (player as any)[zoneName] as Card[];
            const cardIndex = zone.findIndex((c: Card) => c.id === cardId);
            if (cardIndex !== -1) {
                return { player, zoneName, card: zone[cardIndex], index: cardIndex };
            }
        }
    }
    const stackIndex = state.stack.findIndex(c => c.id === cardId);
    if (stackIndex !== -1) {
        return { player: null, zoneName: 'stack', card: state.stack[stackIndex], index: stackIndex };
    }
    return null;
};

function applyJsonEvent(
    prevState: GameState, 
    event: JsonEvent, 
    cardDictionary: Map<string, string>, 
    rawP1Name: string, 
    rawP2Name: string, 
    team1Name: string, 
    team2Name: string
): GameState {
    const state: GameState = JSON.parse(JSON.stringify(prevState));

    const replaceName = (name: string | undefined | null): string | null => {
        if (name === rawP1Name) return team1Name;
        if (name === rawP2Name) return team2Name;
        return name || null;
    };

    switch (event.type) {
        case "TURN_BEGAN":
            if (event.turnOwner?.name) {
                state.turn = event.turnNumber!;
                const newActivePlayerName = replaceName(event.turnOwner.name);
                state.activePlayer = newActivePlayerName || state.activePlayer;
            }
            break;
        
        case "PLAYER_DAMAGED":
           if (event.player?.name && typeof event.amount === 'number') {
                const correctName = replaceName(event.player.name);
                if (correctName && state.players[correctName]) {
                    state.players[correctName].life -= event.amount;
                }
            }
            break;
      
        case "ZONE_CHANGE":
            if (event.card && event.from && event.to) {
                const from = parseZoneString(event.from);
                const to = parseZoneString(event.to);
                if (!from || !to) break;

                const fromPlayerName = replaceName(from.player);
                const toPlayerName = replaceName(to.player);
                
                const cardId = String(event.card.id);
                const cardType = cardDictionary.get(event.card.name) || 'Unknown';
                
                let cardToMove: Card | undefined;
                const location = findCardAndZone(state, cardId);

                if (location) {
                    const sourceZone = location.zoneName === 'stack' ? state.stack : (location.player as any)?.[location.zoneName];
                    if (sourceZone && location.index !== -1) {
                        [cardToMove] = sourceZone.splice(location.index, 1);
                    }
                } else {
                    if (from.zone === 'library' && fromPlayerName && state.players[fromPlayerName]) {
                        state.players[fromPlayerName].librarySize = Math.max(0, state.players[fromPlayerName].librarySize - 1);
                    }
                    cardToMove = { id: cardId, name: event.card.name, cardType };
                }

                if (cardToMove) {
                    cardToMove.cardType = cardType;
                    if (to.zone === 'stack') {
                        state.stack.push(cardToMove);
                    } else if (toPlayerName && state.players[toPlayerName]) {
                        const destPlayerState = state.players[toPlayerName];
                        const destZoneKey = to.zone.toLowerCase();
                        if (destZoneKey === 'library') {
                            destPlayerState.librarySize++;
                        } else {
                            const destZone = (destPlayerState as any)[destZoneKey];
                            if (Array.isArray(destZone)) {
                                destZone.push(cardToMove);
                            }
                        }
                    }
                }
            }
            break;

        case "CARD_TAPPED_CHANGE":
        case "ATTACKERS_DECLARED":
        case "BLOCKERS_DECLARED":
            // No changes needed here as they don't rely on player name lookups
            // (Your existing logic is correct)
            break;
    }
    return state;
}

function getInitialState(p1Name: string, p2Name: string, d1Content: string, d2Content: string): GameState {
    const countCards = (content: string): number => {
        return content.split('\n').reduce((count, line) => {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('[') || trimmed.toLowerCase().startsWith('name=')) return count;
            const match = trimmed.match(/^(\d+)\s/);
            return count + (match ? parseInt(match[1], 10) : 1);
        }, 0);
    };

    return {
        turn: 0, 
        activePlayer: "", 
        stack: [],
        players: {
            [p1Name]: { name: p1Name, life: 20, hand: [], librarySize: countCards(d1Content), battlefield: [], graveyard: [], exile: [] },
            [p2Name]: { name: p2Name, life: 20, hand: [], librarySize: countCards(d2Content), battlefield: [], graveyard: [], exile: [] }
        }
    };
}

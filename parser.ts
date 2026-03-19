import { GameState, Card, PlayerState, JsonEvent, CardLocation } from './types.js';
import { parseZoneString, findPlayerNamesFromRawLog, findWinner } from './utils.js';

export async function postProcessLog(
    rawLog: string, 
    deck1Content: string, 
    deck2Content: string,
    cardDictionary: Map<string, string>
): Promise<{ gameStates: GameState[], winner: string | null }> {
    const lines = rawLog.split('\n');
    const { player1, player2 } = findPlayerNamesFromRawLog(rawLog);
    if (!player1 || !player2) {
        console.error("[PARSER] Could not identify players from log.");
        return { gameStates: [], winner: null };
    }

    const initialState = getInitialState(player1, player2, deck1Content, deck2Content);
    const gameStates: GameState[] = [initialState];
    
    for (const line of lines) {
        if (line.startsWith("JSON_EVENT:")) {
            try {
                const event: JsonEvent = JSON.parse(line.substring(11));
                // Apply the event to the last known state to produce the next state.
                const newState = applyJsonEvent(gameStates[gameStates.length - 1], event, cardDictionary);
                gameStates.push(newState);
            } catch (e) {
                // Ignore malformed JSON lines.
            }
        }
    }
    
    const winner = findWinner(lines, [player1, player2]);
    if (winner && gameStates.length > 0) {
        gameStates[gameStates.length - 1].winner = winner;
    }
    return { gameStates, winner };
}

const findCardAndZone = (state: GameState, cardId: string): CardLocation | null => {
    // Search all player zones
    for (const player of Object.values(state.players)) {
        for (const zoneName of ['battlefield', 'graveyard', 'exile', 'hand']) {
            const zone = (player as any)[zoneName] as Card[];
            const cardIndex = zone.findIndex((c: Card) => c.id === cardId);
            if (cardIndex !== -1) {
                return { player, zoneName, card: zone[cardIndex], index: cardIndex };
            }
        }
    }
    // Also check the global stack
    const stackIndex = state.stack.findIndex(c => c.id === cardId);
    if (stackIndex !== -1) {
        return { player: null, zoneName: 'stack', card: state.stack[stackIndex], index: stackIndex };
    }
    return null;
};

function applyJsonEvent(prevState: GameState, event: JsonEvent, cardDictionary: Map<string, string>): GameState {
    const state: GameState = JSON.parse(JSON.stringify(prevState));

    switch (event.type) {
        case "TURN_BEGAN":
            if (event.turnOwner?.name) {
                state.turn = event.turnNumber!;
                state.activePlayer = event.turnOwner.name;
                const activePlayerState = state.players[state.activePlayer];
                if (activePlayerState) {
                    activePlayerState.battlefield.forEach((c: Card) => { c.isTapped = false; });
                }
                Object.values(state.players).forEach((p: PlayerState) => p.battlefield.forEach((c: Card) => { 
                    c.isAttacking = false; 
                    c.isBlocking = false; 
                }));
            }
            break;
        
        case "PLAYER_DAMAGED":
            if (event.player?.name && event.amount && state.players[event.player.name]) {
                state.players[event.player.name].life -= event.amount;
            }
            break;

      

        case "ZONE_CHANGE":
            if (event.card && event.from && event.to) {
                const from = parseZoneString(event.from);
                const to = parseZoneString(event.to);
                if (!from || !to) break;

                const cardId = String(event.card.id);
                const cardType = cardDictionary.get(event.card.name) || 'Unknown';
                
                let cardToMove: Card | undefined;
                const location = findCardAndZone(state, cardId);

                if (location) {
                    if (location.zoneName === 'stack') {
                        cardToMove = state.stack.splice(location.index, 1)[0];
                    } else if (location.player) {
                        const zone = (location.player as any)[location.zoneName] as Card[];
                        [cardToMove] = zone.splice(location.index, 1);
                    }
                } else {
                    if (from.zone === 'library' && from.player && state.players[from.player]) {
                        state.players[from.player].librarySize--;
                    }
                    cardToMove = { id: cardId, name: event.card.name, cardType };
                }

                if (cardToMove) {
    cardToMove.cardType = cardType;

    if (to.zone === 'stack') {
        // Stack is a global zone with no player — handle explicitly
        state.stack.push(cardToMove);
    } else if (to.player && state.players[to.player]) {
        const destZoneKey = to.zone.toLowerCase();
        if (destZoneKey === 'library') {
            state.players[to.player].librarySize++;
        } else {
            const destZone = (state.players[to.player] as any)[destZoneKey];
            if (Array.isArray(destZone)) {
                destZone.push(cardToMove);
            }
        }
    }
}
            }
            break;

        case "CARD_TAPPED_CHANGE":
            if (event.card && typeof event.isTapped === 'boolean') {
                const loc = findCardAndZone(state, String(event.card.id));
                if (loc) loc.card.isTapped = event.isTapped;
            }
            break;

        case "ATTACKERS_DECLARED":
            if (event.attackers) {
                Object.keys(event.attackers).forEach(attackerId => {
                    const loc = findCardAndZone(state, attackerId);
                    if (loc) loc.card.isAttacking = true;
                });
            }
            break;
            
        case "BLOCKERS_DECLARED":
             if (event.blocks) {
                Object.values(event.blocks).flat().forEach((blockerDto: any) => {
                    const loc = findCardAndZone(state, String(blockerDto.id));
                    if(loc) loc.card.isBlocking = true;
                });
            }
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
        turn: 0, activePlayer: "", stack: [],
        players: {
            [p1Name]: { name: p1Name, life: 20, hand: [], librarySize: countCards(d1Content), battlefield: [], graveyard: [], exile: [] },
            [p2Name]: { name: p2Name, life: 20, hand: [], librarySize: countCards(d2Content), battlefield: [], graveyard: [], exile: [] }
        }
    };
}

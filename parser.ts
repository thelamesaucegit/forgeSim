import { GameState, Card, PlayerState, JsonEvent } from './types';
import { parseZoneString, findPlayerNamesFromRawLog, findWinner } from './utils';

export async function postProcessLog(
    rawLog: string, 
    deck1Content: string, 
    deck2Content: string,
    cardDictionary: Map<string, string>
): Promise<{ gameStates: GameState[], winner: string | null }> {
    const lines = rawLog.split('\n');
    const { player1, player2 } = findPlayerNamesFromRawLog(rawLog);
    if (!player1 || !player2) return { gameStates: [], winner: null };

    const initialState = getInitialState(player1, player2, deck1Content, deck2Content);
    const gameStates: GameState[] = [initialState];
    
    for (const line of lines) {
        if (line.startsWith("JSON_EVENT:")) {
            try {
                const event: JsonEvent = JSON.parse(line.substring(11));
                const newState = applyJsonEvent(gameStates[gameStates.length - 1], event, cardDictionary);
                gameStates.push(newState);
            } catch (e) {}
        }
    }
    
    const winner = findWinner(lines, [player1, player2]);
    if (winner) gameStates[gameStates.length - 1].winner = winner;
    return { gameStates, winner };
}

const findCardAndZone = (state: GameState, cardId: string): { card: Card; player: PlayerState; zoneName: string; } | null => {
    for (const player of Object.values(state.players)) {
        for (const zoneName of ['battlefield', 'graveyard', 'exile', 'hand']) {
            const zone = (player as any)[zoneName];
            const card = zone.find((c: Card) => c.id === cardId);
            if (card) return { card, player, zoneName };
        }
    }
    return null;
}

function applyJsonEvent(prevState: GameState, event: JsonEvent, cardDictionary: Map<string, string>): GameState {
    const state: GameState = JSON.parse(JSON.stringify(prevState));

    if (event.type === "TURN_BEGAN" && event.turnOwner?.name) {
        state.turn = event.turnNumber!;
        state.activePlayer = event.turnOwner.name;
        state.players[state.activePlayer]?.battlefield.forEach(c => c.isTapped = false);
        Object.values(state.players).forEach(p => p.battlefield.forEach(c => { c.isAttacking = false; c.isBlocking = false; }));
    }

    if (event.type === "SPELL_CAST" && event.card) {
        const cardType = cardDictionary.get(event.card.name) || 'Unknown';
        if (cardType === 'Instant' || cardType === 'Sorcery') {
            state.stack.push({ id: String(event.card.id), name: event.card.name, cardType });
        }
    }

    if (event.type === "ZONE_CHANGE" && event.card) {
        const from = parseZoneString(event.from!);
        const to = parseZoneString(event.to!);
        if (!from || !to) return state;

        const cardId = String(event.card.id);
        const cardType = cardDictionary.get(event.card.name) || 'Unknown';
        
        const cardLocation = findCardAndZone(state, cardId);
        let cardToMove: Card;

        if (cardLocation) {
            const { player, zoneName } = cardLocation;
            const zone = (player as any)[zoneName] as Card[];
            const cardIndex = zone.findIndex(c => c.id === cardId);
            [cardToMove] = zone.splice(cardIndex, 1);
        } else {
            cardToMove = { id: cardId, name: event.card.name, cardType };
        }

        if (from.zone === 'library' && from.player && state.players[from.player]) {
            state.players[from.player].librarySize--;
        }
        
        if (to.player && state.players[to.player]) {
            const destZone = (state.players[to.player] as any)[to.zone];
            if (Array.isArray(destZone)) destZone.push(cardToMove);
        }
        
        // Clear stack after a spell moves from it
        if (from.zone === 'stack') {
            state.stack = state.stack.filter(c => c.id !== cardId);
        }
    }

    if (event.type === "CARD_TAPPED_CHANGE" && event.card) {
        const card = findCardAndZone(state, String(event.card.id))?.card;
        if (card) card.isTapped = event.isTapped;
    }

    if (event.type === "ATTACKERS_DECLARED" && event.attackers) {
        Object.keys(event.attackers).forEach(attackerId => {
            const card = findCardAndZone(state, attackerId)?.card;
            if (card) card.isAttacking = true;
        });
    }

    if (event.type === "BLOCKERS_DECLARED" && event.blocks) {
        Object.values(event.blocks).flat().forEach(blockerDto => {
            const card = findCardAndZone(state, String(blockerDto.id))?.card;
            if(card) card.isBlocking = true;
        });
    }

    return state;
}

function getInitialState(p1Name: string, p2Name: string, d1Content: string, d2Content: string): GameState {
    const countCards = (content: string): number => {
        return content.split('\n').reduce((count, line) => {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('[') || trimmed.toLowerCase().includes('name=')) return count;
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

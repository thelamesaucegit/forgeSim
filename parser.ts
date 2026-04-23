// parser.ts

import { GameState, Card, PlayerState, JsonEvent, CardLocation } from './types.js';
import { parseZoneString, findPlayerNamesFromRawLog, findWinner } from './utils.js';

export async function postProcessLog(
    rawLog: string, 
    team1Name: string, // Add explicit string type
    team2Name: string, // Add explicit string type
    deck1Content: string, 
    deck2Content: string,
    cardDictionary: Map<string, string>
): Promise<{ gameStates: GameState[], winner: string | null }> {
    const lines = rawLog.split('\n');
    
    // These are the raw forge names, e.g., "Ai(1)-..."
    const { player1: rawP1Name, player2: rawP2Name } = findPlayerNamesFromRawLog(rawLog);

    if (!rawP1Name || !rawP2Name) {
        console.error("[PARSER] Could not identify players from log.");
        return { gameStates: [], winner: null };
    }

    // Initial state uses the correct team names from the start
    const initialState = getInitialState(team1Name, team2Name, deck1Content, deck2Content);
    const gameStates: GameState[] = [initialState];
    
    for (const line of lines) {
        if (line.startsWith("JSON_EVENT:")) {
            try {
                const event: JsonEvent = JSON.parse(line.substring(11));
                // Apply the event to the last known state to produce the next state.
                // Pass all necessary names for mapping
                const newState = applyJsonEvent(gameStates[gameStates.length - 1], event, cardDictionary, rawP1Name, rawP2Name, team1Name, team2Name);
                gameStates.push(newState);
                // Stop processing if a player has lost to avoid unnecessary work
                if (Object.values(newState.players).some(p => p.life <= 0)) break;
            } catch (e) {
                // Ignore malformed JSON lines
            }
        }
    }
    
    // Find the winner using raw names, then map to the correct team name
    const rawWinner = findWinner(lines, [rawP1Name, rawP2Name]);
    const finalWinner = rawWinner === rawP1Name ? team1Name : rawWinner === rawP2Name ? team2Name : null;

    if (finalWinner && gameStates.length > 0) {
        gameStates[gameStates.length - 1].winner = finalWinner;
    }

    return { gameStates, winner: finalWinner };
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

    const replaceName = (name: string | undefined): string => {
        if (name === rawP1Name) return team1Name;
        if (name === rawP2Name) return team2Name;
        return name || '';
    };

    switch (event.type) {
        case "TURN_BEGAN":
            if (event.turnOwner?.name) {
                state.turn = event.turnNumber!;
                state.activePlayer = replaceName(event.turnOwner.name);
                
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
           if (event.player?.name && typeof event.amount === 'number') {
                const correctName = replaceName(event.player.name);
                const playerState = Object.values(state.players).find(p => p.name === correctName);
                if (playerState) {
                    playerState.life -= event.amount;
                }
            }
            break;
      
        case "ZONE_CHANGE":
            if (event.card && event.from && event.to) {
                const from = parseZoneString(event.from);
                const to = parseZoneString(event.to);
                if (!from || !to) break;

                // Replace names in the parsed zone objects
                from.player = replaceName(from.player);
                to.player = replaceName(to.player);
                
                const cardId = String(event.card.id);
                const cardType = cardDictionary.get(event.card.name) || 'Unknown';
                
                let cardToMove: Card | undefined;
                const location = findCardAndZone(state, cardId);

                if (location) {
                    const sourcePlayer = Object.values(state.players).find(p => p === location.player);
                    const sourceZoneKey = location.zoneName.toLowerCase();
                    const sourceZone = sourceZoneKey === 'stack' ? state.stack : (sourcePlayer as any)?.[sourceZoneKey];

                    if (sourceZone && location.index !== -1) {
                        [cardToMove] = sourceZone.splice(location.index, 1);
                    }
                } else {
                    if (from.zone === 'library' && from.player) {
                         const sourcePlayerState = Object.values(state.players).find(p => p.name === from.player);
                         if (sourcePlayerState) {
                            sourcePlayerState.librarySize = Math.max(0, sourcePlayerState.librarySize - 1);
                         }
                    }
                    cardToMove = { id: cardId, name: event.card.name, cardType };
                }

                if (cardToMove) {
                    cardToMove.cardType = cardType;
                    if (to.zone === 'stack') {
                        state.stack.push(cardToMove);
                    } else if (to.player) {
                        const destPlayerState = Object.values(state.players).find(p => p.name === to.player);
                        if (destPlayerState) {
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

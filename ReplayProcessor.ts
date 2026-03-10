import { GameState, PlayerState, Card } from './types.js';

export function processReplay(rawGameStates: GameState[]): GameState[] {
    if (!rawGameStates || rawGameStates.length === 0) return [];

    const significantStates: GameState[] = [rawGameStates[0]];
    for (let i = 1; i < rawGameStates.length; i++) {
        const curr = rawGameStates[i];
        const prev = significantStates[significantStates.length - 1];
        if (isVisuallyDifferent(prev, curr)) {
            significantStates.push(curr);
        } else {
            prev.phase = curr.phase;
        }
    }

    const finalPacedReplay: GameState[] = [];
    if (significantStates.length > 0) {
        finalPacedReplay.push(significantStates[0]);
    }
    for (let i = 1; i < significantStates.length; i++) {
        finalPacedReplay.push(significantStates[i]);
        if (hasSignificantEvent(significantStates[i-1], significantStates[i])) {
            finalPacedReplay.push(JSON.parse(JSON.stringify(significantStates[i])));
        }
    }
    return finalPacedReplay;
}

function isVisuallyDifferent(prevState: GameState, currState: GameState): boolean {
    return JSON.stringify(prevState.players) !== JSON.stringify(currState.players) || JSON.stringify(prevState.stack) !== JSON.stringify(currState.stack);
}

function hasSignificantEvent(prevState: GameState | null, currState: GameState): boolean {
    if (!prevState) return true;
    if (currState.stack.length > prevState.stack.length) return true;
    for (const pName in currState.players) {
        const p1 = prevState.players[pName] as PlayerState;
        const p2 = currState.players[pName] as PlayerState;
        if (p1.life !== p2.life || p1.battlefield.length !== p2.battlefield.length || p1.graveyard.length !== p2.graveyard.length) return true;
        // Check for new attackers
        const newAttackers = p2.battlefield.some((c: Card) => c.isAttacking && !p1.battlefield.find((pc: Card) => pc.id === c.id)?.isAttacking);
        if (newAttackers) return true;
    }
    return false;
}

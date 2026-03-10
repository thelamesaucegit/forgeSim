import { GameState } from './types';

export function processReplay(rawGameStates: GameState[]): GameState[] {
    if (!rawGameStates || rawGameStates.length === 0) return [];

    const significantStates: GameState[] = [rawGameStates[0]];
    for (let i = 1; i < rawGameStates.length; i++) {
        const curr = rawGameStates[i];
        const prev = significantStates[significantStates.length - 1];
        if (isVisuallyDifferent(prev, curr)) {
            significantStates.push(curr);
        } else {
            prev.phase = curr.phase; // Update phase without adding a new frame
        }
    }

    const finalPacedReplay: GameState[] = [];
    for (let i = 0; i < significantStates.length; i++) {
        finalPacedReplay.push(significantStates[i]);
        if (hasSignificantEvent(i > 0 ? significantStates[i-1] : null, significantStates[i])) {
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
    if (currState.stack.length > prevState.stack.length) return true; // Spell cast
    for (const pName in currState.players) {
        const p1 = prevState.players[pName];
        const p2 = currState.players[pName];
        if (p1.life !== p2.life) return true;
        if (p1.battlefield.length !== p2.battlefield.length) return true;
        if (p1.graveyard.length !== p2.graveyard.length) return true;
        if (p1.battlefield.some(c => c.isAttacking) && !p1.battlefield.every(c => c.isAttacking)) return true;
    }
    return false;
}

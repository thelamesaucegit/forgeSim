//ReplayProcessor.ts

import { GameState, PlayerState, Card } from './types.js';

export function processReplay(rawGameStates: GameState[]): GameState[] {
    if (!rawGameStates || rawGameStates.length === 0) {
        return [];
    }

    // 1. Debounce to get only visually significant state changes
    const significantStates: GameState[] = [rawGameStates[0]];
    for (let i = 1; i < rawGameStates.length; i++) {
        const curr = rawGameStates[i];
        const prev = significantStates[significantStates.length - 1];
        if (isVisuallyDifferent(prev, curr)) {
            significantStates.push(curr);
        } else {
            // If nothing visual changed, at least update the phase on the last frame
            // This prevents the phase from looking "stuck"
            prev.phase = curr.phase;
        }
    }

    // 2. Add "hold" frames for pacing after significant events
    const finalPacedReplay: GameState[] = [];
    if (significantStates.length > 0) {
        finalPacedReplay.push(significantStates[0]);
    }
    for (let i = 1; i < significantStates.length; i++) {
        finalPacedReplay.push(significantStates[i]);
        // Add a duplicate frame to "hold" on screen if a significant event just happened
        if (hasSignificantEvent(significantStates[i - 1], significantStates[i])) {
            finalPacedReplay.push(JSON.parse(JSON.stringify(significantStates[i])));
        }
    }
    return finalPacedReplay;
}

// A change is "visual" if a card changes zone, a player's life changes, or a spell is cast to the stack.
function isVisuallyDifferent(prevState: GameState, currState: GameState): boolean {
    return JSON.stringify(prevState.players) !== JSON.stringify(currState.players) || 
           JSON.stringify(prevState.stack) !== JSON.stringify(currState.stack);
}

// An event is "significant" (and deserves a pause) if a player takes damage, a creature attacks,
// a creature enters/leaves the battlefield, or a spell is cast.
function hasSignificantEvent(prevState: GameState | null, currState: GameState): boolean {
    if (!prevState) return true; // The first state is always significant

    // A spell was cast to the stack
    if (currState.stack.length > prevState.stack.length) return true; 
    
    for (const pName in currState.players) {
        const p1 = prevState.players[pName];
        const p2 = currState.players[pName];
        if (!p1 || !p2) continue;

        if (p1.life !== p2.life) return true;
        if (p1.battlefield.length !== p2.battlefield.length) return true;
        if (p1.graveyard.length !== p2.graveyard.length) return true;

        // An attacker was declared
        const newAttacker = p2.battlefield.find((c: Card) => c.isAttacking && !p1.battlefield.find((pc: Card) => pc.id === c.id)?.isAttacking);
        if (newAttacker) return true;
    }
    return false;
}

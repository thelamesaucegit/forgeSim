import { GameState } from './parser';

/**
 * This is the final step in processing the game log. It takes the raw array of every
 * single game state change and refines it into a clean, paced, and visually appealing
 * replay log that is ready to be consumed by the front-end.
 */
export function processReplay(rawGameStates: GameState[]): GameState[] {
    if (!rawGameStates || rawGameStates.length === 0) {
        return [];
    }

    const significantStates: GameState[] = [];
    let lastState = rawGameStates[0];
    significantStates.push(JSON.parse(JSON.stringify(lastState)));

    // Debounce: Filter for only visually significant changes
    for (let i = 1; i < rawGameStates.length; i++) {
        const currentState = rawGameStates[i];
        if (isVisuallyDifferent(lastState, currentState)) {
            significantStates.push(JSON.parse(JSON.stringify(currentState)));
            lastState = currentState;
        } else {
            // If not different, just update the phase on the last significant state
            if(significantStates.length > 0) {
                significantStates[significantStates.length - 1].phase = currentState.phase;
            }
        }
    }

    // Pacing: Add holds for important events
    const finalPacedReplay: GameState[] = [];
    for (let i = 0; i < significantStates.length; i++) {
        const current = significantStates[i];
        const prev = i > 0 ? significantStates[i - 1] : null;

        // Always add the current state
        finalPacedReplay.push(current);

        // Add a "hold" frame if a significant event occurred
        if (hasSignificantEvent(prev, current)) {
            // Duplicate the frame 2 times to make it hold for a total of 3 frames (e.g., ~1.5 seconds)
            finalPacedReplay.push(JSON.parse(JSON.stringify(current)));
            finalPacedReplay.push(JSON.parse(JSON.stringify(current)));
        }
    }

    return finalPacedReplay;
}

/**
 * Compares two game states to see if a visually significant change has occurred.
 * This is used to "debounce" the raw event stream.
 */
function isVisuallyDifferent(prevState: GameState, currState: GameState): boolean {
    // Simple string comparison is fast and effective for this purpose.
    // We only care about the player data, which contains all the visual zones.
    return JSON.stringify(prevState.players) !== JSON.stringify(currState.players);
}

/**
 * Compares the current state to the previous state to determine if a
 * "major" event happened that warrants a pause in the replay.
 */
function hasSignificantEvent(prevState: GameState | null, currState: GameState): boolean {
    if (!prevState) return true; // The very first state is always significant

    // Check for life total changes
    for (const playerName in currState.players) {
        if (currState.players[playerName].life !== prevState.players[playerName].life) {
            return true;
        }
    }

    // Check for creatures/permanents entering or leaving the battlefield
    for (const playerName in currState.players) {
        const prevBattlefield = prevState.players[playerName].battlefield;
        const currBattlefield = currState.players[playerName].battlefield;
        if (prevBattlefield.length !== currBattlefield.length) {
            return true;
        }
        // This could be made more robust by checking card IDs, but length is a good proxy for now.
    }

    return false;
}

export function parseZoneString(zoneStr: string): { player: string | null, zone: string } | null {
    // This regex handles the two formats we've seen: ZoneView[player=... and ZoneView[player\u003d...
    const match = zoneStr.match(/ZoneView\[player(?:\\u003d|=)([^,]+), zoneType(?:\\u003d|=)([^\]]+)\]/);
    if (match && match[1] && match[2]) {
        // Normalize the zone name to lowercase to match our GameState properties (e.g., 'Battlefield' -> 'battlefield')
        return { player: match[1] === 'null' ? null : match[1], zone: match[2].toLowerCase() };
    }
    return null;
}
 // Fallback: raw Zone.toString() for the stack → "Stack"
    if (zoneStr === 'Stack') {
        return { player: null, zone: 'stack' };
    }

    // Fallback: raw PlayerZone.toString() → "PlayerName's Graveyard"
    const possessiveMatch = zoneStr.match(/^(.+)'s (.+)$/);
    if (possessiveMatch) {
        return { player: possessiveMatch[1], zone: possessiveMatch[2].toLowerCase() };
    }

    return null;
}
export function findPlayerNamesFromRawLog(rawLog: string): { player1: string | null, player2: string | null } {
    // This regex finds the line "PlayerName1 vs PlayerName2 - one game of Constructed"
    const regex = /^(Ai\(1\)-.*? \(AI: .*?\)) vs (Ai\(2\)-.*? \(AI: .*?\))/m;
    const match = rawLog.match(regex);
    if (match && match[1] && match[2]) {
        return { player1: match[1].trim(), player2: match[2].trim() };
    }
    return { player1: null, player2: null };
}

export function findWinner(lines: string[], players: string[]): string | null {
    for (const line of lines) {
        // The winner log can be split across multiple lines, so we need to find the start and parse from there.
        if (line.includes("JSON_GAME_RESULT:")) {
            try {
                const jsonStr = line.substring(line.indexOf('{'));
                const result = JSON.parse(jsonStr);
                // Ensure the winner is one of the players we identified.
                if (result.winner && players.includes(result.winner)) {
                    return result.winner;
                }
            } catch(e) {
                // Incomplete JSON on this line, the winner info might continue on the next.
            }
        }
    }
    return null;
}

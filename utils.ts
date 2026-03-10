
export function parseZoneString(zoneStr: string): { player: string | null, zone: string } | null {
    const match = zoneStr.match(/ZoneView\[player(?:\\u003d|=)([^,]+), zoneType(?:\\u003d|=)([^\]]+)\]/);
    if (match && match[1] && match[2]) {
        return { player: match[1] === 'null' ? null : match[1], zone: match[2].toLowerCase() };
    }
    return null;
}

export function findPlayerNamesFromRawLog(rawLog: string): { player1: string | null, player2: string | null } {
    const regex = /^(Ai\(1\)-.*? \(AI: .*?\)) vs (Ai\(2\)-.*? \(AI: .*?\))/m;
    const match = rawLog.match(regex);
    if (match && match[1] && match[2]) {
        return { player1: match[1].trim(), player2: match[2].trim() };
    }
    return { player1: null, player2: null };
}

export function findWinner(lines: string[], players: string[]): string | null {
    for (const line of lines) {
        if (line.startsWith("JSON_GAME_RESULT:")) {
            try {
                const jsonStr = line.substring(17).replace(/\r?\n|\r/g, '');
                const result = JSON.parse(jsonStr);
                if (result.winner && players.includes(result.winner)) return result.winner;
            } catch(e) {}
        }
    }
    return null;
}

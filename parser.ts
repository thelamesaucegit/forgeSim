// src/forgesim/parser.ts

export interface Card {
  id: string;
  name: string;
  isTapped?: boolean;
  isAttacking?: boolean;
  isBlocked?: boolean;
}

export interface PlayerState {
  name: string;
  life: number;
  battlefield: Card[];
  handSize: number;
}

export interface GameState {
  turn: number;
  activePlayer: string;
  players: Record<string, PlayerState>;
  winner?: string;
  phase?: string;
}

export function getInitialState(): GameState {
  return {
    turn: 0,
    activePlayer: "",
    players: {},
    phase: "Setup",
  };
}

// --- Regex Definitions ---

// ---
// FIX: The regexPlayerSetup now captures the FULL player string, including the (AI: ...) part.
// It looks for two of these groups separated by " vs ".
// ---
const regexPlayerSetup = /^(Ai\(\d+\)-.*? \(AI: .*?\)) vs (Ai\(\d+\)-.*? \(AI: .*?\))/;

const regexTurn = /Turn: Turn (?<turnNum>\d+) \((?<player>.+)\)/;
const regexLand = /Land: (?<player>.+) played (?<cardName>.+) \((?<cardId>\d+)\)/;
const regexCast = /Add To Stack: (?<player>.+) cast (?<cardName>.+)/i;
const regexDamage = /Damage: .* deals (?<damage>\d+) .*damage to (?<targetPlayer>.+)\./;
const regexZoneChange = /Zone Change: (?<cardName>.+) \((?<cardId>\d+)\) was put into graveyard from battlefield/;
const regexAttack = /Combat: (?<player>.+) assigned (?<cardName>.+) \((?<cardId>\d+)\) to attack .*/;
const regexBlock = /Combat: .* assigned (?<blockerName>.+) \((?<blockerId>\d+)\) to block (?<attackerName>.+) \((?<attackerId>\d+)\)/;
const regexMulligan = /Mulligan: (?<player>.+) has kept a hand of (?<handSize>\d+) cards/;
const regexPhase = /^Phase: (.*)/;

// ---
// FIX: The regex for the game end now correctly and robustly captures the full winner name.
// ---
const regexGameEnd = /Game Result:.*? (Ai\(\d+\)-.*? \(AI: .*?\)) has won!/;


export function parseLogLine(line: string, currentState: GameState, validTeamIds: string[]): GameState | null {
  const state = JSON.parse(JSON.stringify(currentState)) as GameState;
  let match: RegExpMatchArray | null;

  match = line.match(regexGameEnd);
  if (match && match[1]) {
    const winnerName = match[1].trim();
    // Validate that the captured winner is one of the players we've already identified.
    if (Object.keys(state.players).includes(winnerName)) {
        state.winner = winnerName;
        console.log(`[PARSER_SUCCESS] Winner captured and validated: ${state.winner}`);
        return state;
    }
  }
  
  // ---
  // FIX: This logic no longer needs to validate against the DB. It uses a single, robust
  // regex to capture both full player names directly from the "vs" line.
  // ---
  if (Object.keys(state.players).length === 0 && line.includes("vs")) {
    match = line.match(regexPlayerSetup);
    
    if (match && match[1] && match[2]) {
        const p1LogName = match[1].trim();
        const p2LogName = match[2].trim();

        state.players[p1LogName] = { name: p1LogName, life: 20, battlefield: [], handSize: 7 };
        state.players[p2LogName] = { name: p2LogName, life: 20, battlefield: [], handSize: 7 };
        console.log(`[PARSER_SUCCESS] Set up players: ${p1LogName} and ${p2LogName}`);
        return state;
    }
  }
  
  match = line.match(regexPhase);
  if (match && match[1]) {
    state.phase = match[1].trim();
    return state;
  }
  match = line.match(regexMulligan);
  if (match?.groups) {
    const { player, handSize } = match.groups;
    if (state.players[player]) {
        state.players[player].handSize = parseInt(handSize, 10);
    }
    return state;
  }
  match = line.match(regexTurn);
  if (match?.groups) {
    state.turn = parseInt(match.groups.turnNum, 10);
    state.activePlayer = match.groups.player.trim();
    for (const playerName in state.players) {
        state.players[playerName].battlefield.forEach((card: Card) => {
            card.isAttacking = false;
            card.isBlocked = false;
        });
    }
    return state;
  }
  match = line.match(regexLand);
  if (match?.groups) {
    const { player, cardName, cardId } = match.groups;
    addCardToBattlefield(state, player, cardId, cardName);
    return state;
  }
  match = line.match(regexAttack);
  if (match?.groups) {
    const { player, cardId, cardName } = match.groups;
    const card = addCardToBattlefield(state, player, cardId, cardName);
    if (card) {
        card.isAttacking = true;
    }
    return state;
  }
  match = line.match(regexBlock);
  if (match?.groups) {
    const { blockerId, blockerName, attackerId } = match.groups;
    const attacker = findCardInBattlefield(state, attackerId);
    const blockerOwner = (Object.values(state.players) as PlayerState[]).find((p) => p.battlefield.some((c) => c.id === blockerId));
    if (blockerOwner) {
        const blocker = addCardToBattlefield(state, blockerOwner.name, blockerId, blockerName);
        if (blocker && attacker) {
            attacker.isBlocked = true;
        }
    }
    return state;
  }
  match = line.match(regexDamage);
  if (match?.groups) {
    const { damage, targetPlayer } = match.groups;
    const trimmedTarget = targetPlayer.trim();
    if (state.players[trimmedTarget]) {
      state.players[trimmedTarget].life -= parseInt(damage, 10);
    }
    return state;
  }
  match = line.match(regexZoneChange);
  if (match?.groups) {
    removeCardFromBattlefield(state, match.groups.cardId);
    return state;
  }
  return null;
}

function removeCardFromBattlefield(state: GameState, cardId: string) {
  for (const playerName in state.players) {
    state.players[playerName].battlefield = state.players[playerName].battlefield.filter(
      (card: Card) => card.id !== cardId
    );
  }
}

function findCardInBattlefield(state: GameState, cardId: string): Card | undefined {
    for (const playerName in state.players) {
        const card = state.players[playerName].battlefield.find((c: Card) => c.id === cardId);
        if (card) return card;
    }
    return undefined;
}

function addCardToBattlefield(state: GameState, playerName: string, cardId: string, cardName: string): Card | undefined {
    const trimmedPlayerName = playerName.trim();
    let actualPlayerKey = Object.keys(state.players).find(key => key.trim() === trimmedPlayerName);
    if (!actualPlayerKey) {
        // This can happen if the log line for a card action appears before the player setup line is parsed.
        // We can't do anything, so we just ignore it.
        return undefined;
    }
    
    let card = findCardInBattlefield(state, cardId);
    if (!card) {
        card = { id: cardId, name: cardName };
        state.players[actualPlayerKey].battlefield.push(card);
    }
    return card;
}

// --- Interfaces ---
export interface Card {
  id: string;
  name: string;
  isTapped?: boolean;
}

export interface PlayerState {
  name: string;
  life: number;
  battlefield: Card[];
}

export interface GameState {
  turn: number;
  activePlayer: string;
  players: Record<string, PlayerState>;
}

// --- Initial State ---
export function getInitialState(): GameState {
  return {
    turn: 0,
    activePlayer: "",
    players: {},
  };
}

// --- Regex Definitions with Named Capture Groups ---

// FIX: Updated to correctly parse player names with deck extensions and AI profiles.
const regexPlayerSetup = /(?<player>Ai\(\d+\)-[\w.-]+(?: \(AI: [\w.]+\))?)/g;

const regexTurn = /Turn: Turn (?<turnNum>\d+) \((?<player>.+)\)/;
const regexLand = /Land: (?<player>.+) played (?<cardName>.+) \((?<cardId>\d+)\)/;

// FIX: Updated to be robust against complex player names.
const regexCast = /Add to stack: (?<player>.+) cast (?<cardName>.+) \((?<cardId>\d+)\)/;

const regexDestroy = /Destroy (?<cardName>.+) \((?<cardId>\d+)\)\./;
const regexZoneChange = /\[Zone Changer: (?<cardName>.+) \((?<cardId>\d+)\)\]/;

// FIX: Updated to be robust against complex player names.
const regexDamage = /Damage: .* deals (?<damage>\d+) .*damage to (?<targetPlayer>.+)\./;
// FIX: Updated to be robust against complex player names.
const regexLifeGain = /(?<player>.+) gains (?<amount>\d+) life\./;
// FIX: Updated to be robust against complex player names.
const regexCombatDamage = /Damage: (?<cardName>.+) \((?<cardId>\d+)\) deals \d+ combat damage to (?<targetPlayer>.+)\./;

// --- Main Parser Function ---
export function parseLogLine(line: string, currentState: GameState): GameState | null {
  const state = JSON.parse(JSON.stringify(currentState));

  if (Object.keys(state.players).length === 0 && line.includes("vs")) {
    const matches = [...line.matchAll(regexPlayerSetup)];
    if (matches.length >= 2) {
      const p1 = matches[0].groups!.player;
      const p2 = matches[1].groups!.player;
      state.players[p1] = { name: p1, life: 20, battlefield: [] };
      state.players[p2] = { name: p2, life: 20, battlefield: [] };
      console.log(`Players initialized: ${p1} vs ${p2}`);
      return state;
    }
  }

  let match: RegExpMatchArray | null;

  match = line.match(regexTurn);
  if (match?.groups) {
    state.turn = parseInt(match.groups.turnNum, 10);
    state.activePlayer = match.groups.player;
    return state;
  }

  match = line.match(regexLand);
  if (match?.groups) {
    const { player, cardName, cardId } = match.groups;
    if (state.players[player]) {
      state.players[player].battlefield.push({ id: cardId, name: cardName });
    }
    return state;
  }

  match = line.match(regexCast);
  if (match?.groups) {
    const { player, cardName, cardId } = match.groups;
    if (state.players[player]) {
      state.players[player].battlefield.push({ id: cardId, name: cardName });
    }
    return state;
  }

  match = line.match(regexDamage);
  if (match?.groups) {
    const { damage, targetPlayer } = match.groups;
    if (state.players[targetPlayer]) {
      state.players[targetPlayer].life -= parseInt(damage, 10);
    }
    return state;
  }

  match = line.match(regexLifeGain);
  if (match?.groups) {
    const { player, amount } = match.groups;
    if (state.players[player]) {
      state.players[player].life += parseInt(amount, 10);
    }
    return state;
  }

  match = line.match(regexDestroy);
  if (match?.groups) {
    removeCardFromBattlefield(state, match.groups.cardId);
    return state;
  }

  match = line.match(regexZoneChange);
  if (match?.groups) {
    removeCardFromBattlefield(state, match.groups.cardId);
    return state;
  }

  match = line.match(regexCombatDamage);
  if (match?.groups) {
    const { cardName, cardId, targetPlayer } = match.groups;
    const controller = Object.keys(state.players).find(p => p !== targetPlayer);
    if (controller && state.players[controller]) {
      const exists = state.players[controller].battlefield.some((c: Card) => c.id === cardId);
      if (!exists) {
        state.players[controller].battlefield.push({ id: cardId, name: cardName });
      }
    }
    return state;
  }

  return null;
}

// --- Helper Function ---
function removeCardFromBattlefield(state: GameState, cardId: string) {
  for (const playerName in state.players) {
    state.players[playerName].battlefield = state.players[playerName].battlefield.filter(
      (card: Card) => card.id !== cardId
    );
  }
}

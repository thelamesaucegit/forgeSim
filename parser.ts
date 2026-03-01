// --- Interfaces ---
export interface Card {
  id: string;
  name: string;
  isTapped?: boolean;
  isAttacking?: boolean; // New: To track combat status
  isBlocked?: boolean;   // New: To track combat status
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
const regexPlayerSetup = /(?<player>Ai\(\d+\)-[\w.-]+(?: \(AI: [\w.]+\))?)/g;
const regexTurn = /Turn: Turn (?<turnNum>\d+) \((?<player>.+)\)/;
const regexLand = /Land: (?<player>.+) played (?<cardName>.+) \((?<cardId>\d+)\)/;

// FIX: Corrected case "Add To Stack" and made it case-insensitive with /i flag
const regexCast = /Add To Stack: (?<player>.+) cast (?<cardName>.+) \((?<cardId>\d+)\)/i;

const regexDestroy = /Destroy (?<cardName>.+) \((?<cardId>\d+)\)\./;
const regexZoneChange = /\[Zone Changer: (?<cardName>.+) \((?<cardId>\d+)\)\]/;
const regexDamage = /Damage: .* deals (?<damage>\d+) .*damage to (?<targetPlayer>.+)\./;
const regexLifeGain = /(?<player>.+) gains (?<amount>\d+) life\./;

// NEW: Regex to capture combat declarations
const regexAttack = /Combat: (?<player>.+) assigned (?<cardName>.+) \((?<cardId>\d+)\) to attack .*/;
const regexBlock = /Combat: .* assigned (?<blockerName>.+) \((?<blockerId>\d+)\) to block (?<attackerName>.+) \((?<attackerId>\d+)\)/;


// --- Main Parser Function ---
export function parseLogLine(line: string, currentState: GameState): GameState | null {
  const state = JSON.parse(JSON.stringify(currentState));
  let match: RegExpMatchArray | null;

  // Initial player setup
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

  // Turn changes
  match = line.match(regexTurn);
  if (match?.groups) {
    state.turn = parseInt(match.groups.turnNum, 10);
    state.activePlayer = match.groups.player;
    // Clear combat states at the start of a new turn
    for (const playerName in state.players) {
        state.players[playerName].battlefield.forEach(card => {
            card.isAttacking = false;
            card.isBlocked = false;
        });
    }
    return state;
  }

  // Lands entering battlefield
  match = line.match(regexLand);
  if (match?.groups) {
    const { player, cardName, cardId } = match.groups;
    if (state.players[player]) {
      state.players[player].battlefield.push({ id: cardId, name: cardName });
    }
    return state;
  }

  // Spells being cast (creatures entering battlefield)
  match = line.match(regexCast);
  if (match?.groups) {
    const { player, cardName, cardId } = match.groups;
    if (state.players[player]) {
      state.players[player].battlefield.push({ id: cardId, name: cardName });
    }
    return state;
  }
  
  // NEW: Handle creature attacks
  match = line.match(regexAttack);
  if (match?.groups) {
    const card = findCardInBattlefield(state, match.groups.cardId);
    if (card) {
        card.isAttacking = true;
    }
    return state;
  }
  
  // NEW: Handle creature blocks
  match = line.match(regexBlock);
  if (match?.groups) {
    const attacker = findCardInBattlefield(state, match.groups.attackerId);
    if (attacker) {
        attacker.isBlocked = true;
    }
    return state;
  }

  // Damage to players
  match = line.match(regexDamage);
  if (match?.groups) {
    const { damage, targetPlayer } = match.groups;
    if (state.players[targetPlayer]) {
      state.players[targetPlayer].life -= parseInt(damage, 10);
    }
    return state;
  }

  // Life gain
  match = line.match(regexLifeGain);
  if (match?.groups) {
    const { player, amount } = match.groups;
    if (state.players[player]) {
      state.players[player].life += parseInt(amount, 10);
    }
    return state;
  }

  // Cards being destroyed
  match = line.match(regexDestroy);
  if (match?.groups) {
    removeCardFromBattlefield(state, match.groups.cardId);
    return state;
  }
  
  // Generic zone changes that remove cards
  match = line.match(regexZoneChange);
  if (match?.groups) {
    removeCardFromBattlefield(state, match.groups.cardId);
    return state;
  }

  return null;
}

// --- Helper Functions ---
function removeCardFromBattlefield(state: GameState, cardId: string) {
  for (const playerName in state.players) {
    state.players[playerName].battlefield = state.players[playerName].battlefield.filter(
      (card: Card) => card.id !== cardId
    );
  }
}

function findCardInBattlefield(state: GameState, cardId: string): Card | undefined {
    for (const playerName in state.players) {
        const card = state.players[playerName].battlefield.find(c => c.id === cardId);
        if (card) return card;
    }
    return undefined;
}

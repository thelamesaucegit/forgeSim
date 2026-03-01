// src/parser.ts

// --- Interfaces ---
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
  handSize: number; // To track mulligans
}

export interface GameState {
  turn: number;
  activePlayer: string;
  players: Record<string, PlayerState>;
  winner?: string; // To declare a winner
}

// --- Initial State ---
export function getInitialState(): GameState {
  return {
    turn: 0,
    activePlayer: "",
    players: {},
  };
}

// --- Regex Definitions ---
const regexPlayerSetup = /(?<player>Ai\(\d+\)-[\w.-]+(?: \(AI: [\w.]+\))?)/g;
const regexTurn = /Turn: Turn (?<turnNum>\d+) \((?<player>.+)\)/;
const regexLand = /Land: (?<player>.+) played (?<cardName>.+) \((?<cardId>\d+)\)/;
const regexCast = /Add To Stack: (?<player>.+) cast (?<cardName>.+)/i;
const regexDamage = /Damage: .* deals (?<damage>\d+) .*damage to (?<targetPlayer>.+)\./;
const regexZoneChange = /Zone Change: (?<cardName>.+) \((?<cardId>\d+)\) was put into graveyard from battlefield/;
const regexAttack = /Combat: (?<player>.+) assigned (?<cardName>.+) \((?<cardId>\d+)\) to attack .*/;
const regexBlock = /Combat: .* assigned (?<blockerName>.+) \((?<blockerId>\d+)\) to block (?<attackerName>.+) \((?<attackerId>\d+)\)/;
const regexMulligan = /Mulligan: (?<player>.+) has kept a hand of (?<handSize>\d+) cards/;
const regexGameEnd = /Game Result: .* has won!/;

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
      state.players[p1] = { name: p1, life: 20, battlefield: [], handSize: 7 };
      state.players[p2] = { name: p2, life: 20, battlefield: [], handSize: 7 };
      return state;
    }
  }

  // Mulligan
  match = line.match(regexMulligan);
  if (match?.groups) {
    const { player, handSize } = match.groups;
    if (state.players[player]) {
        state.players[player].handSize = parseInt(handSize, 10);
    }
    return state;
  }

  // Turn changes
  match = line.match(regexTurn);
  if (match?.groups) {
    state.turn = parseInt(match.groups.turnNum, 10);
    state.activePlayer = match.groups.player;
    for (const playerName in state.players) {
        // FIX: Added explicit type annotation for 'card'
        state.players[playerName].battlefield.forEach((card: Card) => {
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
    addCardToBattlefield(state, player, cardId, cardName);
    return state;
  }

  // Creature attacks (Workaround: add card if not present)
  match = line.match(regexAttack);
  if (match?.groups) {
    const { player, cardId, cardName } = match.groups;
    const card = addCardToBattlefield(state, player, cardId, cardName);
    if (card) {
        card.isAttacking = true;
    }
    return state;
  }

  // Creature blocks (Workaround: add card if not present)
  match = line.match(regexBlock);
  if (match?.groups) {
    const { blockerId, blockerName, attackerId } = match.groups;
    const attacker = findCardInBattlefield(state, attackerId);
    // FIX: Added explicit type annotations for 'p' and 'c'
    const blockerOwner = Object.values(state.players).find((p: PlayerState) => p.battlefield.some((c: Card) => c.id === blockerId));
    if (blockerOwner) {
        const blocker = addCardToBattlefield(state, blockerOwner.name, blockerId, blockerName);
        if (blocker && attacker) {
            attacker.isBlocked = true;
        }
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

  // Cards being removed from battlefield
  match = line.match(regexZoneChange);
  if (match?.groups) {
    removeCardFromBattlefield(state, match.groups.cardId);
    return state;
  }

  // Game End
  match = line.match(regexGameEnd);
  if (match) {
    // FIX: Added explicit type annotation for 'p'
    const winner = Object.values(state.players).find((p: PlayerState) => p.life > 0);
    if (winner) {
        state.winner = winner.name;
    }
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
        const card = state.players[playerName].battlefield.find((c: Card) => c.id === cardId);
        if (card) return card;
    }
    return undefined;
}

function addCardToBattlefield(state: GameState, playerName: string, cardId: string, cardName: string): Card | undefined {
    if (!state.players[playerName]) return undefined;
    let card = findCardInBattlefield(state, cardId);
    if (!card) {
        card = { id: cardId, name: cardName };
        state.players[playerName].battlefield.push(card);
    }
    return card;
}

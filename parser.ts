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
const regexPlayerSetup = /(?<player>Ai\(\d+\)-[\w\s.-]+(?: \(AI: [\w\s.-]+\))?)/g;
const regexTurn = /Turn: Turn (?<turnNum>\d+) \((?<player>.+)\)/;
const regexLand = /Land: (?<player>.+) played (?<cardName>.+) \((?<cardId>\d+)\)/;
const regexCast = /Add To Stack: (?<player>.+) cast (?<cardName>.+)/i;
const regexDamage = /Damage: .* deals (?<damage>\d+) .*damage to (?<targetPlayer>.+)\./;
const regexZoneChange = /Zone Change: (?<cardName>.+) \((?<cardId>\d+)\) was put into graveyard from battlefield/;
const regexAttack = /Combat: (?<player>.+) assigned (?<cardName>.+) \((?<cardId>\d+)\) to attack .*/;
const regexBlock = /Combat: .* assigned (?<blockerName>.+) \((?<blockerId>\d+)\) to block (?<attackerName>.+) \((?<attackerId>\d+)\)/;
const regexMulligan = /Mulligan: (?<player>.+) has kept a hand of (?<handSize>\d+) cards/;
// --- FIX: The regex now correctly uses a capturing group for the winner's name. ---
const regexGameEnd = /Game Result:.*?\. (.*) has won!/;
const regexPhase = /^Phase: (.*)/;

export function parseLogLine(line: string, currentState: GameState): GameState | null {
  const state = JSON.parse(JSON.stringify(currentState)) as GameState;
  let match: RegExpMatchArray | null;

  // --- FIX: Logic now directly uses the captured name from the regex. ---
  match = line.match(regexGameEnd);
  if (match && match[1]) {
    state.winner = match[1].trim();
    console.log(`[PARSER_SUCCESS] Winner captured via regex: ${state.winner}`);
    return state;
  }
  
  if (Object.keys(state.players).length === 0 && line.includes("vs")) {
    const matches = [...line.matchAll(regexPlayerSetup)];
    if (matches.length >= 2) {
      const p1 = matches[0].groups!.player.trim();
      const p2 = matches[1].groups!.player.trim();
      state.players[p1] = { name: p1, life: 20, battlefield: [], handSize: 7 };
      state.players[p2] = { name: p2, life: 20, battlefield: [], handSize: 7 };
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
        return undefined;
    }
    
    let card = findCardInBattlefield(state, cardId);
    if (!card) {
        card = { id: cardId, name: cardName };
        state.players[actualPlayerKey].battlefield.push(card);
    }
    return card;
}

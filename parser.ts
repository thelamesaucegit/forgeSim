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
  handSize: number;
  librarySize: number;
  battlefield: Card[];
  graveyard: Card[];
  exile: Card[];
}

export interface GameState {
  turn: number;
  activePlayer: string;
  players: Record<string, PlayerState>;
  winner?: string;
  phase?: string;
  stack: Card[];
}

export function getInitialState(): GameState {
  return {
    turn: 0,
    activePlayer: "",
    players: {},
    stack: [],
    phase: "Setup",
  };
}

// --- Regex Definitions ---
const regexPlayerSetup = /^(Ai\(\d+\)-.*? \(AI: .*?\)) vs (Ai\(\d+\)-.*? \(AI: .*?\))/;
const regexTurn = /Turn: Turn (?<turnNum>\d+) \((?<player>.+)\)/;
const regexPhase = /^Phase: (.*)/;
const regexMulligan = /Mulligan: (?<player>.+) has kept a hand of (?<handSize>\d+) cards/;
const regexGameEnd = /Game Result:.*? (Ai\(\d+\)-.*? \(AI: .*?\)) has won!/;

// --- NEW/IMPROVED REGEX ---
const regexLand = /Land: (?<player>.+) played (?<cardName>.+) \((?<cardId>\d+)\)/;
const regexCast = /Add To Stack: (?<player>.+) cast (?<cardName>.+)/i;
const regexResolve = /Resolve Stack: (?<cardName>.+) - .*?((?<cardId>\d+))?/;
const regexPlayerDamage = /Damage: .* deals \d+ .*damage to (?<targetPlayer>Ai\(\d+\)-.*? \(AI: .*?\))\./;
const regexZoneChange = /Zone Change: (?<cardName>.+?) \((?<cardId>\d+)\) was put into (?<to>\w+) from (?<from>\w+)/;
const regexAttack = /Combat: (?<player>.+) assigned (?<cardName>.+) \((?<cardId>\d+)\) to attack .*/;


export function parseLogLine(line: string, currentState: GameState): GameState | null {
  const state = JSON.parse(JSON.stringify(currentState)) as GameState;
  let match: RegExpMatchArray | null;

  // --- Player Setup ---
  if (Object.keys(state.players).length === 0 && line.includes("vs")) {
    match = line.match(regexPlayerSetup);
    if (match && match[1] && match[2]) {
        const p1LogName = match[1].trim();
        const p2LogName = match[2].trim();
        const initialDeckSize = 60; // Assuming standard 60-card decks
        state.players[p1LogName] = { name: p1LogName, life: 20, handSize: 7, librarySize: initialDeckSize - 7, battlefield: [], graveyard: [], exile: [] };
        state.players[p2LogName] = { name: p2LogName, life: 20, handSize: 7, librarySize: initialDeckSize - 7, battlefield: [], graveyard: [], exile: [] };
        console.log(`[PARSER_SUCCESS] Set up players: ${p1LogName} and ${p2LogName}`);
        return state;
    }
  }

  // --- Turn & Phase Tracking ---
  match = line.match(regexTurn);
  if (match?.groups) {
    state.turn = parseInt(match.groups.turnNum, 10);
    state.activePlayer = match.groups.player.trim();
    // Untap all cards and reset attack status at the start of a turn
    for (const playerName in state.players) {
        state.players[playerName].battlefield.forEach((card: Card) => {
            card.isTapped = false;
            card.isAttacking = false;
            card.isBlocked = false;
        });
    }
    // Decrement library size for the active player's draw step
    if(state.turn > 1) {
        state.players[state.activePlayer].librarySize--;
    }
    return state;
  }

  match = line.match(regexPhase);
  if (match && match[1]) {
    state.phase = match[1].trim();
    return state;
  }

  // --- Card Movement & Actions ---
  match = line.match(regexLand);
  if (match?.groups) {
    const { player, cardName, cardId } = match.groups;
    addCardToBattlefield(state, player, cardId, cardName);
    return state;
  }
  
  match = line.match(regexCast);
  if (match?.groups) {
      const { cardName } = match.groups;
      // Temporarily add to stack; we need an ID but the log doesn't provide one here.
      // We'll reconcile it during the Resolve Stack event.
      state.stack.push({ id: 'stack-card', name: cardName });
      return state;
  }

  match = line.match(regexResolve);
  if (match?.groups) {
      const { cardName, cardId } = match.groups;
      state.stack = state.stack.filter(c => c.name !== cardName);
      // If the resolving card has an ID, it's a permanent entering the battlefield.
      if (cardId) {
          const owner = findCardOwner(state, cardName, "Stack");
          if(owner) addCardToBattlefield(state, owner, cardId, cardName);
      }
      return state;
  }

  match = line.match(regexZoneChange);
  if (match?.groups) {
      const { cardName, cardId, to, from } = match.groups;
      const card = { id: cardId, name: cardName };
      // Remove from old zone
      for (const pName in state.players) {
          if(from === 'Battlefield') state.players[pName].battlefield = state.players[pName].battlefield.filter(c => c.id !== cardId);
      }
      // Add to new zone
      const owner = findCardOwner(state, cardName, from, cardId);
      if(owner) {
          if (to === 'Graveyard') state.players[owner].graveyard.push(card);
          else if (to === 'Exile') state.players[owner].exile.push(card);
      }
      return state;
  }

  // --- Combat and Damage ---
  match = line.match(regexAttack);
  if (match?.groups) {
    const { player, cardId, cardName } = match.groups;
    const card = findCardInBattlefield(state, cardId);
    if (card) {
        card.isAttacking = true;
    }
    return state;
  }
  
  match = line.match(regexPlayerDamage);
  if (match?.groups) {
      const { targetPlayer } = match.groups;
      const damageMatch = line.match(/deals (?<damage>\d+)/);
      if(damageMatch?.groups) {
          const lifeLoss = parseInt(damageMatch.groups.damage, 10);
          if (state.players[targetPlayer]) {
              state.players[targetPlayer].life -= lifeLoss;
          }
      }
      return state;
  }

  // --- Game End ---
  match = line.match(regexGameEnd);
  if (match && match[1]) {
    const winnerName = match[1].trim();
    if (Object.keys(state.players).includes(winnerName)) {
        state.winner = winnerName;
        console.log(`[PARSER_SUCCESS] Winner captured and validated: ${state.winner}`);
        return state;
    }
  }

  return null;
}

// --- UTILITY FUNCTIONS ---

function findCardOwner(state: GameState, cardName: string, fromZone: string, cardId?: string): string | null {
    // This is a heuristic; for now, we assume the active player is the owner.
    // A more robust solution might need more detailed logs from Forge.
    return state.activePlayer;
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
    const actualPlayerKey = Object.keys(state.players).find(key => key.trim() === trimmedPlayerName);
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

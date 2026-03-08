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

// Add a temporary state to GameState for deck sizes
export interface GameState {
  turn: number;
  activePlayer: string;
  players: Record<string, PlayerState>;
  winner?: string;
  phase?: string;
  stack: any[]; // Using 'any' for stack objects for simplicity
  _tempDeck1Size?: number;
  _tempDeck2Size?: number;
}


export function getInitialState(deck1Size: number, deck2Size: number): GameState {
  return {
    turn: 0,
    activePlayer: "",
    players: {},
    stack: [],
    phase: "Setup",
    _tempDeck1Size: deck1Size,
    _tempDeck2Size: deck2Size,
  };
}

// --- Regex Definitions ---
const regexPlayerSetup = /^(Ai\(\d+\)-.*? \(AI: .*?\)) vs (Ai\(\d+\)-.*? \(AI: .*?\))/;
const regexTurn = /Turn: Turn (?<turnNum>\d+) \((?<player>.*)\)/;
const regexPhase = /^Phase: (.*)/;
const regexMulligan = /Mulligan: (?<player>.+) has kept a hand of (?<handSize>\d+) cards/;
const regexGameEnd = /Game Result:.*? (Ai\(\d+\)-.*? \(AI: .*?\)) has won!/;

const regexLand = /Land: (?<player>.+) played (?<cardName>.+) \((?<cardId>\d+)\)/;
const regexCast = /Add To Stack: (?<player>.+) cast (?<cardName>.+)/i;
const regexResolve = /Resolve Stack: (?<cardName>.+?) - .*?(?:\((?<cardId>\d+)\))?/;
const regexPlayerDamage = /Damage: .* deals (?<damage>\d+) .*damage to (?<targetPlayer>Ai\(\d+\)-.*? \(AI: .*?\))/;
const regexZoneChange = /Zone Change: (?<cardName>.+?) \((?<cardId>\d+)\) was put into (?<to>\w+) from (?<from>\w+)/;
const regexAttack = /Combat: (?<player>.+) assigned (?<cardName>.+) \((?<cardId>\d+)\) to attack .*/;


export function parseLogLine(line: string, currentState: GameState, validTeamIds: string[]): GameState | null {
  const state = JSON.parse(JSON.stringify(currentState)) as GameState;
  let match: RegExpMatchArray | null;

  // --- Player Setup ---
  if (Object.keys(state.players).length === 0 && line.includes("vs")) {
    match = line.match(regexPlayerSetup);
    if (match && match[1] && match[2]) {
        const p1LogName = match[1].trim();
        const p2LogName = match[2].trim();
        
        const p1IsValid = validTeamIds.some(id => p1LogName.toLowerCase().includes(id.toLowerCase()));
        const p2IsValid = validTeamIds.some(id => p2LogName.toLowerCase().includes(id.toLowerCase()));

        if (p1IsValid && p2IsValid) {
            const p1DeckSize = state._tempDeck1Size || 60;
            const p2DeckSize = state._tempDeck2Size || 60;
            state.players[p1LogName] = { name: p1LogName, life: 20, handSize: 7, librarySize: p1DeckSize - 7, battlefield: [], graveyard: [], exile: [] };
            state.players[p2LogName] = { name: p2LogName, life: 20, handSize: 7, librarySize: p2DeckSize - 7, battlefield: [], graveyard: [], exile: [] };
            delete state._tempDeck1Size;
            delete state._tempDeck2Size;
            console.log(`[PARSER_SUCCESS] Validated and set up players: ${p1LogName} and ${p2LogName}`);
            return state;
        }
    }
  }

  // --- Turn & Phase Tracking ---
  match = line.match(regexTurn);
  if (match?.groups) {
    state.turn = parseInt(match.groups.turnNum, 10);
    state.activePlayer = match.groups.player.trim();
    for (const playerName in state.players) {
        state.players[playerName].battlefield.forEach((card: Card) => {
            card.isTapped = false;
            card.isAttacking = false;
            card.isBlocked = false;
        });
    }
    if(state.turn > 1 && state.players[state.activePlayer]) {
        const activePlayer = state.players[state.activePlayer];
        activePlayer.librarySize--;
        activePlayer.handSize++;
    }
    return state;
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

  // --- Card Movement & Actions ---
  match = line.match(regexLand);
  if (match?.groups) {
    const { player, cardName, cardId } = match.groups;
    addCardToBattlefield(state, player, cardId, cardName);
    return state;
  }
  
  match = line.match(regexCast);
  if (match?.groups) {
      const { player, cardName } = match.groups;
      state.stack.push({ name: cardName, player });
      if (state.players[player]) state.players[player].handSize--;
      return state;
  }

  match = line.match(regexResolve);
    if (match?.groups) {
        const { cardName } = match.groups;
        const castIndex = state.stack.findIndex(c => c.name === cardName);
        if (castIndex > -1) {
            const castSpell = state.stack.splice(castIndex, 1)[0];
            const cardIdMatch = line.match(/\((\d+)\)/); // Find any ID on the line
            if (cardIdMatch) {
                // It's a permanent, add to battlefield
                addCardToBattlefield(state, castSpell.player, cardIdMatch[1], cardName);
            } else {
                // It's an instant/sorcery, move to graveyard
                if (state.players[castSpell.player]) {
                    const tempId = `spell-${cardName}-${Date.now()}`;
                    state.players[castSpell.player].graveyard.push({ id: tempId, name: cardName });
                }
            }
        }
        return state;
    }

  match = line.match(regexZoneChange);
  if (match?.groups) {
      const { cardName, cardId, to, from } = match.groups;
      const card = { id: cardId, name: cardName };
      
      let ownerName: string | null = null;
      for (const pName in state.players) {
          const player = state.players[pName];
          const cardIndex = player.battlefield.findIndex(c => c.id === cardId);
          if (cardIndex > -1) {
              ownerName = pName;
              player.battlefield.splice(cardIndex, 1);
              break;
          }
      }

      if (ownerName) {
          if (to.toLowerCase() === 'graveyard') {
              state.players[ownerName].graveyard.push(card);
          } else if (to.toLowerCase() === 'exile') {
              state.players[ownerName].exile.push(card);
          }
      }
      return state;
  }

  // --- Combat and Damage ---
  match = line.match(regexAttack);
  if (match?.groups) {
    const { cardId } = match.groups;
    const card = findCardInBattlefield(state, cardId);
    if (card) {
        card.isAttacking = true;
    }
    return state;
  }
  
  match = line.match(regexPlayerDamage);
  if (match?.groups) {
      const { damage, targetPlayer } = match.groups;
      if (state.players[targetPlayer]) {
          state.players[targetPlayer].life -= parseInt(damage, 10);
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

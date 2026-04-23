//types.ts 
// Defines the structure for a single card in any zone.
export interface Card {
  id: string;
  name: string;
  cardType: string;
  isTapped?: boolean;
  isAttacking?: boolean;
  isBlocking?: boolean;
}

// Defines the state of a single player.
export interface PlayerState {
  name: string;
  life: number;
  hand: Card[];
  librarySize: number;
  battlefield: Card[];
  graveyard: Card[];
  exile: Card[];
}

// Defines the entire state of the game at a single point in time.
export interface GameState {
  turn: number;
  activePlayer: string;
  players: Record<string, PlayerState>;
  winner?: string;
  phase?: string;
  stack: Card[];
}

// A helper interface for locating a card within the game state.
export interface CardLocation {
    card: Card;
    player: PlayerState | null; // Player can be null if card is on the global stack.
    zoneName: string;
    index: number;
}

// Defines the structure of the JSON events parsed from the raw log.
export interface JsonEvent {
    type: string;
    turnNumber?: number;
    turnOwner?: { name: string };
    card?: { id: number; name: string };
    isTapped?: boolean;
    attackers?: { [key: string]: number };
    blocks?: { [key: string]: { id: number; name: string }[] };
    from?: string;
    to?: string;
    player?: { name: string };
    amount?: number;
    phase?: string;
}

export interface Card {
  id: string;
  name: string;
  cardType: string;
  isTapped?: boolean;
  isAttacking?: boolean;
  isBlocking?: boolean;
}

export interface PlayerState {
  name: string;
  life: number;
  hand: Card[];
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
    // FIX: Add the missing 'amount' property for PLAYER_DAMAGED events
    amount?: number; 
    phase?: string;
}

export interface CardLocation {
    card: Card;
    player: PlayerState;
    zoneName: string;
    index: number;
}

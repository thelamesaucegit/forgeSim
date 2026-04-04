// src/main/java/forge/argentum/data/ArgentumData.java
package forge.argentum.data;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

// Using static nested classes keeps all our data models in one file.
public class ArgentumData {

    public static class TargetInfo {
        public String entityId;
        public String type; // Will be "Card", "Player", etc.
    }

    public static class CombatState {
        public List<CombatGroup> groups = new ArrayList<>();
        public List<String> attackers = new ArrayList<>();
    }

    public static class CombatGroup {
        public String attackerId;
        public List<String> blockers = new ArrayList<>();
    }

    public static class SpectatorStateUpdate {
        public String gameSessionId;
        public ClientGameState gameState;
        public String player1Id;
        public String player2Id;
        public String player1Name;
        public String player2Name;
        public String currentPhase;
        public String activePlayerId;
        public String priorityPlayerId;
        public boolean isReplay = true;
        public CombatState combat = null;
    }

    public static class ClientGameState {
        public Map<String, ClientCard> cards;
        public List<ClientZone> zones;
        public List<ClientPlayer> players;
        public String currentPhase;
        public String currentStep;
        public String activePlayerId;
        public String priorityPlayerId;
        public int turnNumber;
        public boolean isGameOver;
        public String winnerId;
        public CombatState combat = null;
        public List<String> gameLog;
    }

    public static class ClientCard {
        public String entityId;
        public String name;
        public String imageUri;
        public List<String> cardTypes;
        public boolean isTapped;
        public boolean isAttacking = false;
        public boolean isBlocking = false;
        public Integer power;
        public Integer toughness;
        public int damage;
        public String attachedTo = null;
        public List<TargetInfo> targets;
    }

    public static class ClientZone {
        public String zoneId;
        public String type;
        public String ownerId;
        public List<String> cardIds;
    }

    public static class ClientPlayer {
        public String playerId;
        public String name;
        public int life;
    }
}

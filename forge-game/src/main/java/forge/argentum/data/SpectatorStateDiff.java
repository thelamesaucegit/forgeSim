// /usr/src/app/forge-game/src/main/java/forge/argentum/data/SpectatorStateDiff.java
package forge.argentum.data;

import java.util.List;
import java.util.Map;

// This class represents the *changes* from a blueprint state, not a full state.
public class SpectatorStateDiff {
    // A flag for the frontend to identify this as a diff object
    public final boolean isDiff = true;

    // Fields for properties that can change at the top level of a snapshot.
    // If a field is null, it means it hasn't changed from the blueprint.
    public String currentPhase;
    public String activePlayerId;
    public String priorityPlayerId;
    public ArgentumData.CombatState combat;

    // --- Nested GameState Diffs ---
    // We create a nested structure to keep the data organized like the original.
    public GameStateDiff gameState;

    public static class GameStateDiff {
        // Maps are used to store only the objects that have changed.
        // Key is the entity ID (e.g., card ID, player ID).
        public Map<String, ArgentumData.ClientCard> cards;
        public Map<String, ArgentumData.ClientZone> zones;
        public Map<String, ArgentumData.ClientPlayer> players;

        // Top-level gameState properties that can change
        public String currentPhase;
        public String currentStep;
        public String activePlayerId;
        public String priorityPlayerId;
        public Integer turnNumber; // Use Integer to allow null if unchanged
        public Boolean isGameOver; // Use Boolean to allow null
        public String winnerId;
        public ArgentumData.CombatState combat;

        // The gameLog will ALWAYS be a complete list of events that occurred
        // since the last snapshot (the blueprint or the previous diff).
        public List<Map<String, Object>> gameLog;
    }
}

// src/main/java/forge/argentum/ArgentumStateLogger.java
package forge.argentum;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import forge.argentum.data.ArgentumData.*; // Import all our nested data classes
import forge.game.Game;
import forge.game.card.Card;
import forge.game.player.Player;
import forge.game.zone.Zone;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;

public class ArgentumStateLogger {

    // Reuse the same Gson instance logic from JsonGameListener
    private static final Gson gson = new GsonBuilder().setLenient().create();

    // Configuration
    private static final String DB_URL = "jdbc:postgresql://your-supabase-project-ref.db.supabase.co:5432/postgres";
    private static final String DB_USER = "postgres";
    private static final String DB_PASSWORD = "your-supabase-db-password";
    private static final String INSERT_SQL = "INSERT INTO your_match_logs_table (match_id, argentum_game_states) VALUES (?, ?::jsonb) ON CONFLICT (match_id) DO UPDATE SET argentum_game_states = your_match_logs_table.argentum_game_states || ?::jsonb;";


    /**
     * The main hook method. It creates a full snapshot of the game state.
     */
    public static void logState(Game game, String currentStep) {
        try {
            SpectatorStateUpdate snapshot = createSnapshotFromGame(game, currentStep);
            String jsonSnapshot = gson.toJson(snapshot);
            
            // To avoid conflicts and ensure states are appended, we'll send a JSON array
            String jsonToInsert = "[" + jsonSnapshot + "]";

            saveToDatabase(game.getMatch().getMatchId(), jsonToInsert);
        } catch (Exception e) {
            System.err.println("ArgentumStateLogger Error: Failed to log state.");
            e.printStackTrace();
        }
    }

    private static SpectatorStateUpdate createSnapshotFromGame(Game game, String currentStep) {
        SpectatorStateUpdate snapshot = new SpectatorStateUpdate();
        ClientGameState gameState = new ClientGameState();
        
        List<Player> players = game.getPlayers();
        Player player1 = players.get(0);
        Player player2 = players.get(1);

        // 1. Populate top-level snapshot info
        snapshot.gameSessionId = game.getMatch().getMatchId();
        snapshot.player1Id = player1.getId().toString();
        snapshot.player2Id = player2.getId().toString();
        snapshot.player1Name = player1.getName();
        snapshot.player2Name = player2.getName();
        snapshot.currentPhase = game.getPhaseHandler().getPhase().name();
        snapshot.activePlayerId = game.getPhaseHandler().getPlayerTurn().getId().toString();
        snapshot.priorityPlayerId = game.getPhaseHandler().getPriorityPlayer() != null ? game.getPhaseHandler().getPriorityPlayer().getId().toString() : null;

        // 2. Populate ClientGameState
        // 2a. All Cards
        gameState.cards = new HashMap<>();
        for (Card card : game.getCardsInGame()) {
            gameState.cards.put(String.valueOf(card.getId()), createClientCard(card));
        }

        // 2b. All Zones
        gameState.zones = new ArrayList<>();
        for (Zone zone : game.getZones()) {
            gameState.zones.add(createClientZone(zone));
        }
        
        // 2c. All Players
        gameState.players = new ArrayList<>();
        for(Player p : players) {
            gameState.players.add(createClientPlayer(p));
        }

        // 2d. Scalar Game State Values
        gameState.currentPhase = snapshot.currentPhase;
        gameState.currentStep = currentStep;
        gameState.activePlayerId = snapshot.activePlayerId;
        gameState.priorityPlayerId = snapshot.priorityPlayerId;
        gameState.turnNumber = game.getPhaseHandler().getTurn();
        gameState.isGameOver = game.isGameOver();
        gameState.winnerId = game.getWinner() != null ? game.getWinner().getWinningPlayer().getId().toString() : null;
        gameState.gameLog = Collections.singletonList("> Turn " + gameState.turnNumber + ": " + currentStep);

        snapshot.gameState = gameState;
        return snapshot;
    }

    // Helper methods to transform Forge objects into our Argentum data models
    private static ClientCard createClientCard(Card card) {
        ClientCard cc = new ClientCard();
        cc.entityId = String.valueOf(card.getId());
        cc.name = card.getName();
        cc.imageUri = card.getImageUrl();
        cc.cardTypes = new ArrayList<>(card.getCurrentCardTypes());
        cc.isTapped = card.isTapped();
        cc.power = card.hasPower() ? card.getNetPower() : null;
        cc.toughness = card.hasToughness() ? card.getNetToughness() : null;
        cc.damage = card.getDamage();
        cc.targets = new ArrayList<>(); // To be populated later
        return cc;
    }

    private static ClientZone createClientZone(Zone zone) {
        ClientZone cz = new ClientZone();
        cz.type = zone.getZoneType().name();
        cz.ownerId = zone.getOwner() != null ? String.valueOf(zone.getOwner().getId()) : "game";
        cz.zoneId = cz.type + "_" + cz.ownerId;

        cz.cardIds = new ArrayList<>();
        for (Card card : zone.getCards()) {
            cz.cardIds.add(String.valueOf(card.getId()));
        }
        return cz;
    }

    private static ClientPlayer createClientPlayer(Player player) {
        ClientPlayer cp = new ClientPlayer();
        cp.playerId = String.valueOf(player.getId());
        cp.name = player.getName();
        cp.life = player.getLife();
        return cp;
    }

    private static void saveToDatabase(String matchId, String jsonStateArray) throws Exception {
        // Using an UPSERT to append to the JSONB array if the row already exists
        try (Connection conn = DriverManager.getConnection(DB_URL, DB_USER, DB_PASSWORD);
             PreparedStatement pstmt = conn.prepareStatement(INSERT_SQL)) {
            
            pstmt.setString(1, matchId);
            pstmt.setString(2, jsonStateArray); // For the INSERT case
            pstmt.setString(3, jsonStateArray); // For the UPDATE case
            pstmt.executeUpdate();
        }
    }
}

// src/main/java/forge/argentum/ArgentumStateLogger.java
package forge.argentum;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import forge.argentum.data.ArgentumData.*;
import forge.game.Game;
import forge.game.card.Card;
import forge.game.player.Player;
import forge.game.zone.Zone;
import forge.game.combat.Combat; 
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;

public class ArgentumStateLogger {

    private static final Gson gson = new GsonBuilder().setLenient().create();
    private static final HttpClient httpClient = HttpClient.newHttpClient();
 private static CombatState createCombatState(Combat combat) {
        if (combat == null) {
            return null;
        }
        CombatState cs = new CombatState();
        for (Card attacker : combat.getAttackers()) {
            cs.attackers.add(String.valueOf(attacker.getId()));
            
            CombatGroup group = new CombatGroup();
            group.attackerId = String.valueOf(attacker.getId());
            
            for (Card blocker : combat.getBlockers(attacker)) {
                group.blockers.add(String.valueOf(blocker.getId()));
            }
            cs.groups.add(group);
        }
        return cs;
    }

    // The URL for our new Next.js API route
    private static final String LOG_ENDPOINT_URL = "http://localhost:3000/api/log-state"; // Default Next.js port

    public static void logState(Game game, String currentStep) {
        try {
            SpectatorStateUpdate snapshot = createSnapshotFromGame(game, currentStep);
            String jsonSnapshot = gson.toJson(snapshot);
            sendStateToLogServer(game.getMatch().getMatchId(), jsonSnapshot);
        } catch (Exception e) {
            System.err.println("ArgentumStateLogger Error: Failed to log state for step: " + currentStep);
            e.printStackTrace();
        }
    }

    private static void sendStateToLogServer(String matchId, String jsonState) {
        // We create a simple JSON payload to send to our Next.js API route.
        String requestBody = "{\"matchId\": \"" + matchId + "\", \"state\": " + jsonState + "}";

        HttpRequest request = HttpRequest.newBuilder()
                .uri(URI.create(LOG_ENDPOINT_URL))
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(requestBody))
                .build();

        // Send the request asynchronously. We don't need to wait for the response.
        httpClient.sendAsync(request, HttpResponse.BodyHandlers.ofString())
                .thenApply(HttpResponse::body)
                .thenAccept(System.out::println)
                .exceptionally(e -> {
                    System.err.println("ArgentumStateLogger: Failed to send log to server: " + e.getMessage());
                    return null;
                });
    }
    
    // The createSnapshotFromGame and helper methods remain UNCHANGED from the previous step.
    // They are included here for completeness.
    
    private static SpectatorStateUpdate createSnapshotFromGame(Game game, String currentStep) {
        SpectatorStateUpdate snapshot = new SpectatorStateUpdate();
        ClientGameState gameState = new ClientGameState();
        
        List<Player> players = game.getPlayers();
        if (players.size() < 2) {
            throw new IllegalStateException("Game must have at least two players to log.");
        }
        Player player1 = players.get(0);
        Player player2 = players.get(1);

        snapshot.gameSessionId = game.getMatch().getMatchId();
        snapshot.player1Id = String.valueOf(player1.getId());
        snapshot.player2Id = String.valueOf(player2.getId());
        snapshot.player1Name = player1.getName();
        snapshot.player2Name = player2.getName();
        snapshot.currentPhase = game.getPhaseHandler().getPhase().name();
        snapshot.activePlayerId = String.valueOf(game.getPhaseHandler().getPlayerTurn().getId());
        snapshot.priorityPlayerId = game.getPhaseHandler().getPriorityPlayer() != null ? String.valueOf(game.getPhaseHandler().getPriorityPlayer().getId()) : null;

        gameState.cards = new HashMap<>();
        for (Card card : game.getCardsInGame()) {
            gameState.cards.put(String.valueOf(card.getId()), createClientCard(card, currentCombat));
        }

        gameState.zones = new ArrayList<>();
        for (Zone zone : game.getZones()) {
            gameState.zones.add(createClientZone(zone));
        }
        
        gameState.players = new ArrayList<>();
        for(Player p : players) {
            gameState.players.add(createClientPlayer(p));
        }
 Combat currentCombat = game.getPhaseHandler().getCombat();
        snapshot.combat = createCombatState(currentCombat);
        gameState.combat = createCombatState(currentCombat);
        gameState.currentPhase = snapshot.currentPhase;
        gameState.currentStep = currentStep;
        gameState.activePlayerId = snapshot.activePlayerId;
        gameState.priorityPlayerId = snapshot.priorityPlayerId;
        gameState.turnNumber = game.getPhaseHandler().getTurn();
        gameState.isGameOver = game.isGameOver();
        gameState.winnerId = game.getWinner() != null ? String.valueOf(game.getWinner().getWinningPlayer().getId()) : null;
        gameState.gameLog = Collections.singletonList("> Turn " + gameState.turnNumber + ": " + currentStep.replace("_", " "));

        snapshot.gameState = gameState;
        return snapshot;
    }

    private static ClientCard createClientCard(Card card, Combat combat) {
        ClientCard cc = new ClientCard();
        cc.entityId = String.valueOf(card.getId());
        cc.name = card.getName();
        cc.imageUri = card.getImageUrl();
        cc.cardTypes = new ArrayList<>(card.getCurrentCardTypes());
        cc.isTapped = card.isTapped();
        if (combat != null) {
            cc.isAttacking = combat.isAttacking(card);
            cc.isBlocking = combat.isBlocking(card);
        } else {
            cc.isAttacking = false;
            cc.isBlocking = false;
        }
        cc.power = card.hasPower() ? card.getNetPower() : null;
        cc.toughness = card.hasToughness() ? card.getNetToughness() : null;
        cc.damage = card.getDamage();
         if (card.isAttached()) {
        cc.attachedTo = String.valueOf(card.getAttachedTo().getId());
    }
        cc.targets = new ArrayList<>();
        return cc;
    }

    private static ClientZone createClientZone(Zone zone) {
        ClientZone cz = new ClientZone();
        cz.type = zone.getZoneType().name();
        String ownerId = zone.getOwner() != null ? String.valueOf(zone.getOwner().getId()) : "game";
        cz.ownerId = ownerId;
        cz.zoneId = cz.type + "_" + ownerId;

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
}

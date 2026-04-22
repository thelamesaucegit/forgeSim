// /usr/src/app/forge-game/src/main/java/forge/argentum/ArgentumStateLogger.java
package forge.argentum;

import com.google.common.eventbus.Subscribe;
import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import forge.argentum.data.ArgentumData.*;
import forge.argentum.data.SpectatorStateDiff;
import forge.game.Game;
import forge.game.GameObject;
import forge.game.combat.Combat;
import forge.game.card.Card;
import forge.game.event.*;
import forge.game.player.Player;
import forge.game.spellability.SpellAbility;
import forge.game.spellability.SpellAbilityStackInstance;
import forge.game.spellability.TargetChoices;
import forge.game.zone.MagicStack;
import forge.game.zone.Zone;
import forge.game.zone.ZoneType;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.stream.Collectors;

public class ArgentumStateLogger {

    private final Game game;
    private final List<Object> snapshotBatch = new ArrayList<>();
    private SpectatorStateUpdate blueprintSnapshot = null;
    // FIX: This list now correctly holds Map<String, Object>
    private final List<Map<String, Object>> gameLogEvents = new ArrayList<>();
    private final ArgentumEventVisitor logVisitor = new ArgentumEventVisitor();

    // FIX: BATCH_SIZE is now a class-level constant.
    private static final int BATCH_SIZE = 50;
    private static final Gson gson = new GsonBuilder().create();
    private static final HttpClient httpClient = HttpClient.newBuilder()
            .version(HttpClient.Version.HTTP_1_1)
            .connectTimeout(Duration.ofSeconds(10))
            .build();

    public ArgentumStateLogger(Game game) {
        this.game = game;
    }

    @Subscribe
    public void onGameEvent(GameEvent event) {
        Map<String, Object> eventDto = event.visit(logVisitor);
        if (eventDto != null) {
            gameLogEvents.add(eventDto);
        }
        if (shouldCreateSnapshot(event)) {
            createSnapshot(event.getClass().getSimpleName());
        }
    }

    private boolean shouldCreateSnapshot(GameEvent event) {
        return event instanceof GameEventTurnPhase ||
               event instanceof GameEventSpellAbilityCast ||
               event instanceof GameEventAttackersDeclared ||
               event instanceof GameEventBlockersDeclared ||
               event instanceof GameEventCombatEnded;
    }

    public void createSnapshot(String eventType) {
        if (this.game == null || this.game.isCopiedGame() || this.game.getPhaseHandler() == null) return;

        try {
            SpectatorStateUpdate currentState = createSpectatorUpdateFromGame(this.game, eventType);
            if (currentState == null) return;
            
            // FIX: This assignment is now type-safe.
            currentState.gameState.gameLog = new ArrayList<>(gameLogEvents);
            gameLogEvents.clear();

            if (blueprintSnapshot == null) {
                blueprintSnapshot = currentState;
                snapshotBatch.add(blueprintSnapshot);
            } else {
                SpectatorStateDiff diff = StateDiffer.diff(blueprintSnapshot, currentState);
                snapshotBatch.add(diff);
            }

            // FIX: BATCH_SIZE is now correctly referenced.
            if (snapshotBatch.size() >= BATCH_SIZE) {
                flushBatch();
            }
        } catch (Exception e) {
            System.err.println("ArgentumStateLogger Error: Failed to create snapshot/diff: " + e.getMessage());
            e.printStackTrace();
        }
    }

    // The rest of this file (flushBatch, flushAllStates, etc.) is correct from previous steps.
    // I am including it in full for completeness.

    private void flushBatch() {
        if (snapshotBatch.isEmpty()) return;
        String matchId = this.game.getMatch().getMatchId();
        List<Object> batchToSend = new ArrayList<>(snapshotBatch);
        snapshotBatch.clear();
        blueprintSnapshot = null;
        String jsonPayload = gson.toJson(batchToSend);
        sendBatchToServer(matchId, jsonPayload);
    }

    public void flushAllStates() {
        if (this.game.isGameOver()) {
            createSnapshot("GAME_OVER");
        }
        flushBatch();
    }
    
    private static String getLogEndpointUrl() {
        String publicUrl = System.getenv("LOG_ENDPOINT_HOST");
        return (publicUrl != null && !publicUrl.isEmpty()) ? publicUrl : "http://localhost:3000/api/log-replay";
    }

    private static void sendBatchToServer(String matchId, String jsonPayload) {
        if (matchId == null || jsonPayload == null || jsonPayload.equals("[]")) return;
        try {
            HttpRequest request = HttpRequest.newBuilder()
                .uri(URI.create(getLogEndpointUrl()))
                .header("Content-Type", "application/json")
                .header("X-Match-ID", matchId)
                .timeout(Duration.ofSeconds(60))
                .POST(HttpRequest.BodyPublishers.ofString(jsonPayload))
                .build();
            httpClient.sendAsync(request, HttpResponse.BodyHandlers.ofString())
                .thenAccept(response -> {
                    if (response.statusCode() != 200) {
                        System.err.println("ArgentumLogger: Non-200 on batch flush (" + response.statusCode() + "): " + response.body());
                    }
                })
                .exceptionally(ex -> {
                    System.err.println("ArgentumLogger: Exception during async HTTP send: " + ex.getMessage());
                    return null;
                });
        } catch (Exception e) {
            System.err.println("ArgentumLogger: Failed to send batch payload: " + e.getMessage());
        }
    }

    // The createSpectatorUpdateFromGame and its helpers remain correct.
    private static SpectatorStateUpdate createSpectatorUpdateFromGame(Game game, String currentStep) {
        SpectatorStateUpdate snapshot = new SpectatorStateUpdate();
        ClientGameState gameState = new ClientGameState();
        List<Player> players = game.getPlayers();
        if (players.size() < 2) return null;
        
        Player player1 = players.get(0);
        Player player2 = players.get(1);

        Combat currentCombat = game.getPhaseHandler().getCombat();
        MagicStack stack = game.getStack();
        boolean isPreGame = (game.getPhaseHandler().getPhase() == null);
        String currentPhaseName = isPreGame ? "MULLIGAN" : game.getPhaseHandler().getPhase().name();
        String currentStepName = isPreGame ? "OPENING_HAND" : currentStep;
        int currentTurnNumber = isPreGame ? 0 : game.getPhaseHandler().getTurn();
        String activePlayerId = (isPreGame || game.getPhaseHandler().getPlayerTurn() == null) ? null : String.valueOf(game.getPhaseHandler().getPlayerTurn().getId());
        String priorityPlayerId = (isPreGame || game.getPhaseHandler().getPriorityPlayer() == null) ? null : String.valueOf(game.getPhaseHandler().getPriorityPlayer().getId());

        snapshot.gameSessionId = game.getMatch().getMatchId();
        snapshot.player1Id = String.valueOf(player1.getId());
        snapshot.player2Id = String.valueOf(player2.getId());
        snapshot.player1Name = player1.getName();
        snapshot.player2Name = player2.getName();
        snapshot.currentPhase = currentPhaseName;
        snapshot.activePlayerId = activePlayerId;
        snapshot.priorityPlayerId = priorityPlayerId;
        snapshot.combat = createCombatState(currentCombat);

        gameState.cards = new HashMap<>();
        for (Card card : game.getCardsInGame()) {
            gameState.cards.put(String.valueOf(card.getId()), createClientCard(card, currentCombat, stack));
        }

        gameState.zones = new ArrayList<>();
        for (Player p : players) {
            for (ZoneType zt : Player.ALL_ZONES) {
                Zone zone = p.getZone(zt);
                if (zone != null) {
                    gameState.zones.add(createClientZone(zone));
                }
            }
        }
        gameState.zones.add(createClientZone(game.getStackZone()));

        gameState.players = new ArrayList<>();
        for (Player p : players) {
            gameState.players.add(createClientPlayer(p));
        }

        gameState.currentPhase = currentPhaseName;
        gameState.currentStep = currentStepName;
        gameState.activePlayerId = activePlayerId;
        gameState.priorityPlayerId = priorityPlayerId;
        gameState.turnNumber = currentTurnNumber;
        gameState.isGameOver = game.isGameOver();
        
        String winnerId = null;
        if (gameState.isGameOver) {
            for (Player p : players) {
                if (p.hasWon()) {
                    winnerId = String.valueOf(p.getId());
                    break;
                }
            }
        }
        gameState.winnerId = winnerId;
        gameState.combat = createCombatState(currentCombat);
        snapshot.gameState = gameState;

        return snapshot;
    }
    private static ClientCard createClientCard(Card card, Combat combat, MagicStack stack) { /* ... same as before ... */ }
    private static ClientZone createClientZone(Zone zone) { /* ... same as before ... */ }
    private static ClientPlayer createClientPlayer(Player player) { /* ... same as before ... */ }
    private static CombatState createCombatState(Combat combat) { /* ... same as before ... */ }
    private static class StateDiffer { /* ... same as before ... */ }
}

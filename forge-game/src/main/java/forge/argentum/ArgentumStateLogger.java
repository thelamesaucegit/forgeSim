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

import java.io.IOException;
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
    private final List<Map<String, Object>> gameLogEvents = new ArrayList<>();
    private final ArgentumEventVisitor logVisitor = new ArgentumEventVisitor();

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
       if (game.isGameOver()) return;
        Map<String, Object> eventDto = event.visit(logVisitor);
        if (eventDto != null) {
            gameLogEvents.add(eventDto);
        }
        if (shouldCreateSnapshot(event)) {
            createSnapshot(event.getClass().getSimpleName());
        }
    }

    public void forceFinalSnapshotAndFlush() {
        System.out.println("forceFinalSnapshotAndFlush called.");
        // 1. Create one last snapshot representing the game-ending state.
        createSnapshot("GAME_OVER_FORCED");
        
        // 2. Immediately flush whatever is in the batch.
        if (snapshotBatch.isEmpty()) {
            System.out.println("Final batch is empty. Nothing to flush.");
            return;
        }
        
        String matchId = this.game.getMatch().getMatchId();
        List<Object> finalBatch = new ArrayList<>(snapshotBatch);
        snapshotBatch.clear();
        String jsonPayload = gson.toJson(finalBatch);
        
        System.out.println("Flushing final batch of size " + finalBatch.size() + " for match " + matchId);
        // 3. Use the blocking send method to guarantee delivery before the app exits.
        sendBatchToServerBlocking(matchId, jsonPayload);
    }
     @Subscribe
    public void onGameOver(GameEventGameOutcome event) {
        // When the game outcome is determined, force one final snapshot.
        // This will capture the state that led to the game ending.
        createSnapshot("GAME_OVER");
    }
 public void forceFinalSnapshot(String eventType) {
        System.out.println("forceFinalSnapshot called with event: " + eventType);
        createSnapshot(eventType);
        flushBatch(); // Immediately flush the final batch synchronously.
    }
     private boolean shouldCreateSnapshot(GameEvent event) {
        // Prevent Java from even snapshotting blockers/end combat if no attackers exist
        if (event instanceof GameEventBlockersDeclared || event instanceof GameEventCombatEnded) {
            Combat combat = game.getPhaseHandler().getCombat();
            if (combat != null && combat.getAttackers().isEmpty()) {
                return false; 
            }
        }

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
            
            currentState.gameState.gameLog = new ArrayList<>(gameLogEvents);
            gameLogEvents.clear();

            if (blueprintSnapshot == null) {
                blueprintSnapshot = currentState;
                snapshotBatch.add(blueprintSnapshot);
            } else {
                SpectatorStateDiff diff = StateDiffer.diff(blueprintSnapshot, currentState);
                snapshotBatch.add(diff);
            }

            if (snapshotBatch.size() >= BATCH_SIZE) {
                flushBatch();
            }
        } catch (Exception e) {
            System.err.println("ArgentumStateLogger Error: Failed to create snapshot/diff: " + e.getMessage());
            e.printStackTrace();
        }
    }

       private void flushBatch() {
        if (snapshotBatch.isEmpty()) return;
        String matchId = this.game.getMatch().getMatchId();
        List<Object> batchToSend = new ArrayList<>(snapshotBatch);
        snapshotBatch.clear();
        blueprintSnapshot = null;
        String jsonPayload = gson.toJson(batchToSend);
        sendBatchToServerBlocking(matchId, jsonPayload); // Using blocking for all batches for simplicity and reliability
    }

   public void flushAllStates() {
        System.out.println("flushAllStates called from SimulateMatch. Flushing any remaining items.");
        flushBatch(); // flush any stragglers, though there shouldn't be any.
    }
    
    private static String getLogEndpointUrl() {
        String publicUrl = System.getenv("LOG_ENDPOINT_HOST");
        return (publicUrl != null && !publicUrl.isEmpty()) ? publicUrl : "http://localhost:3000/api/log-replay";
    }

    private static void sendBatchToServerAsync(String matchId, String jsonPayload) {
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
                        System.err.println("ArgentumLogger (Async): Non-200 on batch flush (" + response.statusCode() + "): " + response.body());
                    }
                })
                .exceptionally(ex -> {
                    System.err.println("ArgentumLogger (Async): Exception during HTTP send: " + ex.getMessage());
                    return null;
                });
        } catch (Exception e) {
            System.err.println("ArgentumLogger (Async): Failed to send batch payload: " + e.getMessage());
        }
    }

   private static void sendBatchToServerBlocking(String matchId, String jsonPayload) {
        if (matchId == null || jsonPayload == null || jsonPayload.equals("[]")) return;
        try {
            HttpRequest request = HttpRequest.newBuilder()
                .uri(URI.create(getLogEndpointUrl()))
                .header("Content-Type", "application/json")
                .header("X-Match-ID", matchId)
                .timeout(Duration.ofSeconds(60))
                .POST(HttpRequest.BodyPublishers.ofString(jsonPayload))
                .build();
            
            HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());
            
            if (response.statusCode() != 200) {
                System.err.println("ArgentumLogger (Blocking): Non-200 on flush (" + response.statusCode() + "): " + response.body());
            } else {
                 System.out.println("ArgentumLogger (Blocking): Batch flushed successfully.");
            }
        } catch (IOException | InterruptedException e) {
            System.err.println("ArgentumLogger (Blocking): Failed to send batch payload: " + e.getMessage());
            Thread.currentThread().interrupt();
        }
    }

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
    
    // --- THIS IS THE FIX: Implementing the missing methods ---

    private static ClientCard createClientCard(Card card, Combat combat, MagicStack stack) {
        ClientCard cc = new ClientCard();
        cc.entityId = String.valueOf(card.getId());
        cc.name = card.getName();
        cc.cardTypes = card.getType().getCoreTypes().stream().map(Object::toString).collect(Collectors.toList());
        cc.isTapped = card.isTapped();
        cc.isAttacking = combat != null && combat.isAttacking(card);
        cc.isBlocking = combat != null && combat.isBlocking(card);
        cc.power = card.isCreature() ? card.getNetPower() : null;
        cc.toughness = card.isCreature() ? card.getNetToughness() : null;
        cc.damage = card.getDamage();
        cc.attachedTo = card.isAttachedToEntity() ? String.valueOf(card.getAttachedTo().getId()) : null;
        cc.targets = new ArrayList<>();
        if (card.getZone() != null && card.getZone().getZoneType() == ZoneType.Stack) {
            for (SpellAbilityStackInstance si : stack) {
                if (si.getSourceCard().equals(card)) {
                    SpellAbility sa = si.getSpellAbility();
                    if (sa.usesTargeting()) {
                        TargetChoices targets = sa.getTargets();
                        if (targets != null) {
                            for (GameObject target : targets) {
                                TargetInfo ti = new TargetInfo();
                                if (target instanceof Card) {
                                    ti.entityId = String.valueOf(((Card) target).getId());
                                    ti.type = "Card";
                                } else if (target instanceof Player) {
                                    ti.entityId = String.valueOf(((Player) target).getId());
                                    ti.type = "Player";
                                }
                                cc.targets.add(ti);
                            }
                        }
                    }
                    break;
                }
            }
        }
        return cc;
    }

    private static ClientZone createClientZone(Zone zone) {
        ClientZone cz = new ClientZone();
        ZoneId zoneIdObject = new ZoneId();
        zoneIdObject.zoneType = zone.getZoneType().name();
        String ownerId = zone.getPlayer() != null ? String.valueOf(zone.getPlayer().getId()) : "game";
        zoneIdObject.ownerId = ownerId;
        cz.zoneId = zoneIdObject;
        cz.cardIds = new ArrayList<>();
        for (Card card : zone.getCards()) {
            cz.cardIds.add(String.valueOf(card.getId()));
        }
        cz.size = cz.cardIds.size();
        cz.isVisible = true;
        return cz;
    }

    private static ClientPlayer createClientPlayer(Player player) {
        ClientPlayer cp = new ClientPlayer();
        cp.playerId = String.valueOf(player.getId());
        cp.name = player.getName();
        cp.life = player.getLife();
        return cp;
    }

    private static CombatState createCombatState(Combat combat) {
        if (combat == null) { return null; }
        CombatState cs = new CombatState();
        cs.attackers = new ArrayList<>();
        cs.groups = new ArrayList<>();
        for (Card attacker : combat.getAttackers()) {
            cs.attackers.add(String.valueOf(attacker.getId()));
            CombatGroup group = new CombatGroup();
            group.attackerId = String.valueOf(attacker.getId());
            group.blockers = new ArrayList<>();
            for (Card blocker : combat.getBlockers(attacker)) {
                group.blockers.add(String.valueOf(blocker.getId()));
            }
            cs.groups.add(group);
        }
        return cs;
    }

    private static class StateDiffer {
        public static SpectatorStateDiff diff(SpectatorStateUpdate blueprint, SpectatorStateUpdate current) {
            SpectatorStateDiff diff = new SpectatorStateDiff();
            diff.gameState = new SpectatorStateDiff.GameStateDiff();

            if (!Objects.equals(blueprint.currentPhase, current.currentPhase)) diff.currentPhase = current.currentPhase;
            if (!Objects.equals(blueprint.activePlayerId, current.activePlayerId)) diff.activePlayerId = current.activePlayerId;
            if (!Objects.equals(blueprint.priorityPlayerId, current.priorityPlayerId)) diff.priorityPlayerId = current.priorityPlayerId;
            if (!gson.toJson(blueprint.combat).equals(gson.toJson(current.combat))) diff.combat = current.combat;

            SpectatorStateDiff.GameStateDiff gsd = diff.gameState;
            if (!Objects.equals(blueprint.gameState.currentPhase, current.gameState.currentPhase)) gsd.currentPhase = current.gameState.currentPhase;
            if (!Objects.equals(blueprint.gameState.currentStep, current.gameState.currentStep)) gsd.currentStep = current.gameState.currentStep;
            if (!Objects.equals(blueprint.gameState.activePlayerId, current.gameState.activePlayerId)) gsd.activePlayerId = current.gameState.activePlayerId;
            if (!Objects.equals(blueprint.gameState.priorityPlayerId, current.gameState.priorityPlayerId)) gsd.priorityPlayerId = current.gameState.priorityPlayerId;
            if (blueprint.gameState.turnNumber != current.gameState.turnNumber) gsd.turnNumber = current.gameState.turnNumber;
            if (blueprint.gameState.isGameOver != current.gameState.isGameOver) gsd.isGameOver = current.gameState.isGameOver;
            if (!Objects.equals(blueprint.gameState.winnerId, current.gameState.winnerId)) gsd.winnerId = current.gameState.winnerId;
            if (!gson.toJson(blueprint.gameState.combat).equals(gson.toJson(current.gameState.combat))) gsd.combat = current.gameState.combat;
            
            gsd.gameLog = current.gameState.gameLog;
            gsd.cards = new HashMap<>();
            for (Map.Entry<String, ClientCard> currentEntry : current.gameState.cards.entrySet()) {
                String cardId = currentEntry.getKey();
                ClientCard currentCard = currentEntry.getValue();
                ClientCard blueprintCard = blueprint.gameState.cards.get(cardId);
                if (blueprintCard == null || !gson.toJson(blueprintCard).equals(gson.toJson(currentCard))) {
                    gsd.cards.put(cardId, currentCard);
                }
            }

            gsd.zones = new HashMap<>();
            for (ClientZone currentZone : current.gameState.zones) {
                String zoneIdentifier = getZoneIdentifier(currentZone.zoneId);
                ClientZone blueprintZone = findZone(blueprint.gameState.zones, currentZone.zoneId);
                if (blueprintZone == null || !Objects.equals(blueprintZone.cardIds, currentZone.cardIds)) {
                    gsd.zones.put(zoneIdentifier, currentZone);
                }
            }
            
            gsd.players = new HashMap<>();
            for (ClientPlayer currentPlayer : current.gameState.players) {
                String playerId = currentPlayer.playerId;
                ClientPlayer blueprintPlayer = findPlayer(blueprint.gameState.players, playerId);
                if (blueprintPlayer == null || !gson.toJson(blueprintPlayer).equals(gson.toJson(currentPlayer))) {
                    gsd.players.put(playerId, currentPlayer);
                }
            }
            return diff;
        }

        private static String getZoneIdentifier(ZoneId zoneId) {
            return zoneId.ownerId + "_" + zoneId.zoneType;
        }

        private static ClientZone findZone(List<ClientZone> zones, ZoneId zoneId) {
            for (ClientZone z : zones) {
                if (z.zoneId.ownerId.equals(zoneId.ownerId) && z.zoneId.zoneType.equals(zoneId.zoneType)) {
                    return z;
                }
            }
            return null;
        }

        private static ClientPlayer findPlayer(List<ClientPlayer> players, String playerId) {
            for (ClientPlayer p : players) {
                if (p.playerId.equals(playerId)) {
                    return p;
                }
            }
            return null;
        }
    }
}

// src/main/java/forge/argentum/ArgentumStateLogger.java

package forge.argentum;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import forge.argentum.data.ArgentumData.*;
import forge.game.Game;
import forge.game.GameSnapshot;
import forge.game.GameObject;
import forge.game.card.Card;
import forge.game.combat.Combat;
import forge.game.player.Player;
import forge.game.spellability.SpellAbility;
import forge.game.spellability.SpellAbilityStackInstance;
import forge.game.zone.MagicStack;
import forge.game.zone.Zone;
import forge.game.zone.ZoneType;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.HttpRequest.BodyPublishers;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.concurrent.ConcurrentLinkedQueue;

public class ArgentumStateLogger {

    private static final Gson gson = new GsonBuilder().setLenient().create();
    private static final HttpClient httpClient = HttpClient.newHttpClient();
    private static final int BATCH_SIZE = 20;
    private static final ConcurrentLinkedQueue<String> eventQueue = new ConcurrentLinkedQueue<>();
    private static String currentMatchId;

    private static String getLogEndpointUrl() {
        String publicUrl = System.getenv("LOG_ENDPOINT_HOST");
        if (publicUrl != null && !publicUrl.isEmpty()) {
            return publicUrl;
        }
        return "http://localhost:3000/api/log-state";
    }

    public static void logState(Game game, String currentStep) {
        if (game == null || game.getPhaseHandler() == null) {
            return;
        }
        try {
            GameSnapshot snapshotter = new GameSnapshot(game);
            Game gameCopy = snapshotter.makeCopy();
            SpectatorStateUpdate snapshot = createSpectatorUpdateFromGame(gameCopy, currentStep);

            String jsonSnapshot = gson.toJson(snapshot);
            eventQueue.add(jsonSnapshot);
            
            currentMatchId = game.getMatch().getMatchId();

            if (eventQueue.size() >= BATCH_SIZE) {
                flushQueue();
            }
        } catch (Exception e) {
            System.err.println("ArgentumStateLogger Error: Failed to create and queue state for step: " + currentStep);
            e.printStackTrace();
        }
    }

    public static void flushQueue() {
        if (eventQueue.isEmpty() || currentMatchId == null) {
            return;
        }

        // v-v-v-v- THIS IS THE FIX v-v-v-v-
        // The correct way to drain a ConcurrentLinkedQueue is to poll it in a loop.
        List<String> statesToSend = new ArrayList<>();
        String state;
        while ((state = eventQueue.poll()) != null) {
            statesToSend.add(state);
        }
        // ^-^-^-^-^-^-^-^-^-^-^-^-^-^-^-^-^-

        if (statesToSend.isEmpty()) {
            return;
        }
        
        System.out.println("ArgentumLogger: Flushing queue with " + statesToSend.size() + " states for match " + currentMatchId);
        String jsonBatch = "[" + String.join(",", statesToSend) + "]";
        sendBatchToLogServer(currentMatchId, jsonBatch);
    }

    private static void sendBatchToLogServer(String matchId, String jsonBatch) {
        try {
            String endpointUrl = getLogEndpointUrl();
            System.out.println("ArgentumLogger: Sending batch of " + (jsonBatch.length() / 1024) + "KB to " + endpointUrl);
    
            HttpRequest request = HttpRequest.newBuilder()
                    .uri(URI.create(endpointUrl))
                    .header("Content-Type", "application/json")
                    .header("X-Match-ID", matchId) 
                    .timeout(Duration.ofSeconds(30))
                    .POST(BodyPublishers.ofString(jsonBatch))
                    .build();
    
            httpClient.sendAsync(request, HttpResponse.BodyHandlers.ofString())
                .thenAccept(response -> {
                    if (response.statusCode() != 200) {
                         System.err.println("ArgentumLogger: Received non-200 response for batch: " + response.body());
                    }
                })
                .exceptionally(e -> {
                    System.err.println("ArgentumStateLogger: Batch HTTP request failed: " + e.getMessage());
                    return null;
                });
        } catch (Exception e) {
            System.err.println("ArgentumStateLogger: Catastrophic failure in sendBatchToLogServer.");
            e.printStackTrace();
        }
    }

    private static SpectatorStateUpdate createSpectatorUpdateFromGame(Game game, String currentStep) {
        SpectatorStateUpdate snapshot = new SpectatorStateUpdate();
        ClientGameState gameState = new ClientGameState();
        
        List<Player> players = game.getPlayers();
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
        for(Player p : players) {
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
        
        gameState.gameLog = Collections.singletonList(isPreGame ? "> Drawing opening hands..." : "> Turn " + gameState.turnNumber + ": " + currentStep.replace("_", " "));
        gameState.combat = createCombatState(currentCombat);
        snapshot.gameState = gameState;
        return snapshot;
    }

    private static ClientCard createClientCard(Card card, Combat combat, MagicStack stack) {
        ClientCard cc = new ClientCard();
        cc.entityId = String.valueOf(card.getId());
        cc.name = card.getName();
        cc.imageUri = card.getImageKey();
        cc.cardTypes = new ArrayList<>();
        for (String token : card.getType().toString().split("\\s+")) {
            if (!token.isEmpty() && !token.equals("—")) {
                cc.cardTypes.add(token);
            }
        }
        cc.isTapped = card.isTapped();
        if (combat != null) {
            cc.isAttacking = combat.isAttacking(card);
            cc.isBlocking = combat.isBlocking(card);
        } else {
            cc.isAttacking = false;
            cc.isBlocking = false;
        }
        cc.power = card.isCreature() ? card.getNetPower() : null;
        cc.toughness = card.isCreature() ? card.getNetToughness() : null;
        cc.damage = card.getDamage();
        if (card.isAttachedToEntity()) {
            cc.attachedTo = String.valueOf(card.getAttachedTo().getId());
        }
        cc.targets = new ArrayList<>();
        if (card.getZone() != null && card.getZone().getZoneType() == ZoneType.Stack) {
            for (SpellAbilityStackInstance si : stack) {
                if (si.getSourceCard().equals(card)) {
                    SpellAbility sa = si.getSpellAbility();
                    if (sa.usesTargeting()) {
                        for (GameObject target : sa.getTargets()) {
                            TargetInfo ti = new TargetInfo();
                            if (target instanceof Card) {
                                ti.entityId = String.valueOf(((Card) target).getId());
                                ti.type = "Card";
                            } else if (target instanceof Player) {
                                ti.entityId = String.valueOf(((Player) target).getId());
                                ti.type = "Player";
                            } else {
                                ti.entityId = target.toString();
                                ti.type = "Other";
                            }
                            cc.targets.add(ti);
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
        cz.type = zone.getZoneType().name();
        String ownerId = zone.getPlayer() != null ? String.valueOf(zone.getPlayer().getId()) : "game";
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

    private static CombatState createCombatState(Combat combat) {
        if (combat == null) {
            return null;
        }
        CombatState cs = new CombatState();
        cs.attackers = new ArrayList<>(); // Initialize the list
        cs.groups = new ArrayList<>();    // Initialize the list
        for (Card attacker : combat.getAttackers()) {
            cs.attackers.add(String.valueOf(attacker.getId()));
            CombatGroup group = new CombatGroup();
            group.attackerId = String.valueOf(attacker.getId());
            group.blockers = new ArrayList<>(); // Initialize the list
            for (Card blocker : combat.getBlockers(attacker)) {
                group.blockers.add(String.valueOf(blocker.getId()));
            }
            cs.groups.add(group);
        }
        return cs;
    }
}

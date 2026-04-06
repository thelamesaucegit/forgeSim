// src/main/java/forge/argentum/ArgentumStateLogger.java
package forge.argentum;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import forge.argentum.data.ArgentumData.*;
import forge.game.Game;
import forge.game.GameObject;
import forge.game.card.Card;
import forge.game.combat.Combat;
import forge.game.player.Player;
import forge.game.spellability.SpellAbility;
import forge.game.spellability.SpellAbilityStackInstance;
import forge.game.zone.MagicStack;
import forge.game.zone.ZoneType;
import forge.game.GameOutcome;
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
  // In forge/argentum/ArgentumStateLogger.java

private static String getLogEndpointUrl() {
    // Read the service name from an environment variable.
    String serviceHost = System.getenv("LOG_ENDPOINT_HOST");
    
    // If the variable isn't set, we are in local development.
    if (serviceHost == null || serviceHost.isEmpty()) {
        return "http://localhost:3000/api/log-state";
    }
    
    // If the variable IS set (on DigitalOcean), construct a proper HTTPS URL.
    // The platform automatically routes traffic on port 443 to your service's exposed port.
    return "https://" + serviceHost + "/api/log-state";
}

    private static final List<ZoneType> PLAYER_ZONE_TYPES = Arrays.asList(
            ZoneType.Hand, ZoneType.Library, ZoneType.Graveyard,
            ZoneType.Battlefield, ZoneType.Exile, ZoneType.Command);

    public static void logState(Game game, String currentStep) {

        try {
            SpectatorStateUpdate snapshot = createSnapshotFromGame(game, currentStep);
            String jsonSnapshot = gson.toJson(snapshot);
            sendStateToLogServer(String.valueOf(game.getId()), jsonSnapshot);
        } catch (Exception e) {
            System.err.println("ArgentumStateLogger Error: Failed to log state for step: " + currentStep);
            e.printStackTrace();
        }
    }

 private static void sendStateToLogServer(String matchId, String jsonState) {
        String requestBody = "{\"matchId\": \"" + matchId + "\", \"state\": " + jsonState + "}";

        HttpRequest request = HttpRequest.newBuilder()
                .uri(URI.create(getLogEndpointUrl())) // Use the dynamic URL
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(requestBody))
                .build();

        httpClient.sendAsync(request, HttpResponse.BodyHandlers.ofString())
                .exceptionally(e -> {
                    System.err.println("ArgentumStateLogger: Failed to send log to server at " + getLogEndpointUrl() + ": " + e.getMessage());
                    return null;
                });
    }
    

private static SpectatorStateUpdate createSnapshotFromGame(Game game, String currentStep) {
    SpectatorStateUpdate snapshot = new SpectatorStateUpdate();
    ClientGameState gameState = new ClientGameState();
    
    List<Player> players = game.getPlayers();
    if (players.size() < 2) {
        throw new IllegalStateException("Game must have at least two players to log.");
    }
    Player player1 = players.get(0);
    Player player2 = players.get(1);

    Combat currentCombat = game.getPhaseHandler().getCombat();
    MagicStack stack = game.getStack();

    // v-v-v-v- THIS IS THE NEW, ROBUST LOGIC v-v-v-v-
    boolean isPreGame = (game.getPhaseHandler() == null || game.getPhaseHandler().getPhase() == null);
    
    String currentPhaseName = isPreGame ? "MULLIGAN" : game.getPhaseHandler().getPhase().name();
    String currentStepName = isPreGame ? "OPENING_HAND" : currentStep;
    int currentTurnNumber = isPreGame ? 0 : game.getPhaseHandler().getTurn();
    String activePlayerId = isPreGame ? null : String.valueOf(game.getPhaseHandler().getPlayerTurn().getId());
    String priorityPlayerId = (isPreGame || game.getPhaseHandler().getPriorityPlayer() == null) ? null : String.valueOf(game.getPhaseHandler().getPriorityPlayer().getId());
    // ^-^-^-^-^-^-^-^-^-^-^-^-^-^-^-^-^-^-^-^-^-^-^-^-^-^-^-

    // 1. Populate top-level snapshot info
    snapshot.gameSessionId = game.getMatch().getMatchId();
    snapshot.player1Id = String.valueOf(player1.getId());
    snapshot.player2Id = String.valueOf(player2.getId());
    snapshot.player1Name = player1.getName();
    snapshot.player2Name = player2.getName();
    snapshot.currentPhase = currentPhaseName;
    snapshot.activePlayerId = activePlayerId;
    snapshot.priorityPlayerId = priorityPlayerId;
    snapshot.combat = createCombatState(currentCombat);

    // 2. Populate ClientGameState
    gameState.cards = new HashMap<>();
    for (Card card : game.getCardsInGame()) {
        gameState.cards.put(String.valueOf(card.getId()), createClientCard(card, currentCombat, stack));
    }

    // ... (zones, players) ...
    gameState.zones = new ArrayList<>();
    for (Zone zone : game.getZones()) {
        gameState.zones.add(createClientZone(zone));
    }
    gameState.players = new ArrayList<>();
    for(Player p : players) {
        gameState.players.add(createClientPlayer(p));
    }

    // 2d. Scalar Game State Values
    gameState.currentPhase = currentPhaseName;
    gameState.currentStep = currentStepName;
    gameState.activePlayerId = activePlayerId;
    gameState.priorityPlayerId = priorityPlayerId;
    gameState.turnNumber = currentTurnNumber;
    gameState.isGameOver = game.isGameOver();
// In createSnapshotFromGame method...

// Explicitly declare a variable of type GameOutcome
GameOutcome winnerOutcome = game.getWinner();

// Now, use this new variable for the null check and to get the winner's ID
gameState.winnerId = winnerOutcome != null ? String.valueOf(winnerOutcome.getWinningPlayer().getId()) : null;
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

        // v-v-v-v- TARGETING LOGIC v-v-v-v-
        cc.targets = new ArrayList<>();
        if (card.getZone() != null && card.getZone().getZoneType() == ZoneType.Stack) {
            // Find the spell ability instance on the stack that corresponds to this card
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
                    break; // Found the matching spell on the stack, no need to continue loop
                }
            }
        }
        // ^-^-^-^- END TARGETING LOGIC ^-^-^-^-

        return cc;
    }

    private static ClientZone createClientZone(forge.game.zone.Zone zone) {
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
}

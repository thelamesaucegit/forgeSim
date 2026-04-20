// /usr/src/app/forge-game/src/main/java/forge/argentum/ArgentumStateLogger.java
package forge.argentum;

import com.google.common.eventbus.Subscribe;
import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import forge.argentum.data.ArgentumData.*;
import forge.game.Game;
import forge.game.GameObject;
import forge.game.Match;
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
import java.net.http.HttpRequest.BodyPublishers;
import java.net.http.HttpResponse.BodyHandlers;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

public class ArgentumStateLogger {
    private final Game game;
    private final List<SpectatorStateUpdate> snapshots = new ArrayList<>();
    private final List<Map<String, Object>> gameLogEvents = new ArrayList<>();
    private final ArgentumEventVisitor logVisitor = new ArgentumEventVisitor();
    private static final Gson gson = new GsonBuilder().create();
    private static final HttpClient httpClient = HttpClient.newHttpClient();

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
               event instanceof GameEventCombatResult;
    }

    public void createSnapshot(String eventType) {
        if (this.game == null || this.game.isCopiedGame() || this.game.getPhaseHandler() == null) {
            return;
        }
        try {
            SpectatorStateUpdate snapshot = createSpectatorUpdateFromGame(this.game, eventType);
            if (snapshot != null) {
                snapshot.gameState.gameLog = new ArrayList<>(gameLogEvents);
                snapshots.add(snapshot);
                gameLogEvents.clear();
            }
        } catch (Exception e) {
            System.err.println("ArgentumStateLogger Error: Failed to create snapshot for event " + eventType + ". Error: " + e.getMessage());
            e.printStackTrace();
        }
    }

    public void flushAllStates() {
        if (this.game.isGameOver()) {
             createSnapshot("GAME_OVER");
        }
        if (snapshots.isEmpty()) {
            return;
        }
        
        String matchId = this.game.getMatch().getMatchId();
        String jsonPayload = gson.toJson(snapshots);
        sendFinalPayloadToServer(matchId, jsonPayload);
    }
    
    private static void sendFinalPayloadToServer(String matchId, String jsonPayload) {
        try {
            HttpRequest request = HttpRequest.newBuilder()
                    .uri(URI.create(getLogEndpointUrl()))
                    .header("Content-Type", "application/json")
                    .header("X-Match-ID", matchId) 
                    .timeout(Duration.ofSeconds(90))
                    .POST(BodyPublishers.ofString(jsonPayload))
                    .build();
    
            HttpResponse<String> response = httpClient.send(request, BodyHandlers.ofString());
            if (response.statusCode() != 200) {
                 System.err.println("ArgentumLogger (FINAL): Received non-200 response: " + response.statusCode() + " " + response.body());
            } else {
                 System.out.println("ArgentumLogger (FINAL): Successfully sent " + jsonPayload.length() + " bytes for match " + matchId);
            }
        } catch (Exception e) {
            System.err.println("ArgentumStateLogger: Final payload request failed: " + e.getMessage());
        }
    }

    private static String getLogEndpointUrl() {
        String publicUrl = System.getenv("LOG_ENDPOINT_HOST");
        return (publicUrl != null && !publicUrl.isEmpty()) ? publicUrl : "http://localhost:3000/api/log-replay";
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
        gameState.combat = createCombatState(currentCombat);
        snapshot.gameState = gameState;
        return snapshot;
    }

    private static ClientCard createClientCard(Card card, Combat combat, MagicStack stack) {
        ClientCard cc = new ClientCard();
        cc.entityId = String.valueOf(card.getId());
        cc.name = card.getName();
        cc.imageUri = null;
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
                            for (GameObject target : targets) { // Direct iteration
                                TargetInfo ti = new TargetInfo();
                                if (target instanceof Card) {
                                    ti.entityId = String.valueOf(((Card) target).getId());
                                    ti.type = "Card";
                                } else if (target instanceof Player) {
                                    ti.entityId = String.valueOf(((Player) target).getId());
                                    ti.type = "Player";
                                } else {
                                    continue;
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
}

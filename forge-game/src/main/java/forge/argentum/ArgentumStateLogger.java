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
        if (this.game == null || this.game.isCopiedGame() || this.game.getPhaseHandler() == null) return;
        try {
            SpectatorStateUpdate snapshot = createSpectatorUpdateFromGame(this.game, eventType);
            if (snapshot != null) {
                snapshot.gameState.gameLog = new ArrayList<>(gameLogEvents);
                snapshots.add(snapshot);
                gameLogEvents.clear();
            }
        } catch (Exception e) {
            System.err.println("ArgentumStateLogger Error: Failed to create snapshot: " + e.getMessage());
        }
    }

    public void flushAllStates() {
        if (this.game.isGameOver()) createSnapshot("GAME_OVER");
        if (snapshots.isEmpty()) return;
        String matchId = this.game.getMatch().getMatchId();
        String jsonPayload = gson.toJson(snapshots);
        sendFinalPayloadToServer(matchId, jsonPayload);
    }
    
    private static void sendFinalPayloadToServer(String matchId, String jsonPayload) { /* implementation is correct */ }
    private static String getLogEndpointUrl() { /* implementation is correct */ }
    
    private static SpectatorStateUpdate createSpectatorUpdateFromGame(Game game, String currentStep) { /* implementation is correct */ }
    
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
                            for (GameObject target : targets) { // Direct iteration is correct
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
}

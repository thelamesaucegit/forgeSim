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
import java.time.Duration;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.stream.Collectors;

// --- FIX: Implement the IGameEventVisitor interface ---
public class ArgentumStateLogger implements IGameEventVisitor<Void> {

    private static final Gson gson = new GsonBuilder().setLenient().create();
    private static final HttpClient httpClient = HttpClient.newHttpClient();
    private static final int BATCH_SIZE = 20;
    private static final ConcurrentLinkedQueue<String> eventQueue = new ConcurrentLinkedQueue<>();
    private static String currentMatchId;

    // --- FIX: The subscribe method now correctly calls the visit method ---
    @Subscribe
    public void onGameEvent(GameEvent event) {
        // The event dispatches to the correct visit method below.
        event.visit(this);
    }
    
    // --- FIX: Implement visit methods for specific, visually significant events ---
    @Override
    public Void visit(GameEventTurnPhase event) {
        queueState(event.getGame(), "TURN_PHASE");
        return null;
    }

    @Override
    public Void visit(GameEventSpellResolved event) {
        queueState(event.spell().getGame(), "SPELL_RESOLVED");
        return null;
    }

    @Override
    public Void visit(GameEventSpellAbilityCast event) {
        queueState(event.getSa().getGame(), "SPELL_CAST");
        return null;
    }

    @Override
    public Void visit(GameEventPlayerDamaged event) {
        queueState(event.player.getGame(), "PLAYER_DAMAGED");
        return null;
    }

    @Override
    public Void visit(GameEventBlockersDeclared event) {
        queueState(event.getAttackingPlayer().getGame(), "BLOCKERS_DECLARED");
        return null;
    }

    // --- All other visit methods are not implemented, so they do nothing ---
    // (This is implicitly handled by not overriding them)

    private static void queueState(Game game, String eventType) {
        if (game == null || game.isGameOver() || game.isCopiedGame() || game.getPhaseHandler() == null) {
            return;
        }
        
        try {
            SpectatorStateUpdate snapshot = createSpectatorUpdateFromGame(game, eventType);
            if (snapshot == null) return; // Don't queue null snapshots
            String jsonSnapshot = gson.toJson(snapshot);
            eventQueue.add(jsonSnapshot);
            currentMatchId = game.getMatch().getMatchId();
            if (eventQueue.size() >= BATCH_SIZE) {
                flushQueue();
            }
        } catch (Exception e) {
            System.err.println("ArgentumStateLogger Error: Failed to queue state for event " + eventType);
            e.printStackTrace();
        }
    }

    public static void logOnGameOver(Game game) {
        queueState(game, "GAME_OVER");
        flushQueue();
    }
    
    // ... The rest of the file (flushQueue, sendBatchToLogServer, and all create... methods) remains unchanged ...
}

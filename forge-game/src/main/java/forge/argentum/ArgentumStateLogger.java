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

// --- FIX 1: Extend the Base visitor to implement all methods by default ---
public class ArgentumStateLogger extends IGameEventVisitor.Base<Void> {

    // --- FIX 2: Make methods non-static to manage state per instance ---
    private final ConcurrentLinkedQueue<String> eventQueue = new ConcurrentLinkedQueue<>();
    private String currentMatchId;

    private static final Gson gson = new GsonBuilder().setLenient().create();
    private static final HttpClient httpClient = HttpClient.newHttpClient();
    private static final int BATCH_SIZE = 20;

    @Subscribe
    public void onGameEvent(GameEvent event) {
        event.visit(this);
    }
    
    // --- FIX 3: Correctly implement the visit methods with proper data access ---
    @Override
    public Void visit(GameEventTurnPhase event) {
        // GameEventTurnPhase has a public 'game' field.
        queueState(event.game, "TURN_PHASE");
        return null;
    }

    @Override
    public Void visit(GameEventSpellResolved event) {
        // The SpellAbilityView has a public 'game' field.
        queueState(event.spell().getGame(), "SPELL_RESOLVED");
        return null;
    }

    @Override
    public Void visit(GameEventSpellAbilityCast event) {
        // The SpellAbility object has a getGame() method.
        queueState(event.sa.getGame(), "SPELL_CAST");
        return null;
    }

    @Override
    public Void visit(GameEventPlayerDamaged event) {
        // The Player object has a getGame() method.
        queueState(event.player.getGame(), "PLAYER_DAMAGED");
        return null;
    }

    @Override
    public Void visit(GameEventBlockersDeclared event) {
        // The Player object has a getGame() method.
        queueState(event.player.getGame(), "BLOCKERS_DECLARED");
        return null;
    }

    private void queueState(Game game, String eventType) {
        if (game == null || game.isGameOver() || game.isCopiedGame() || game.getPhaseHandler() == null) {
            return;
        }
        
        try {
            SpectatorStateUpdate snapshot = createSpectatorUpdateFromGame(game, eventType);
            if (snapshot == null) return;
            String jsonSnapshot = gson.toJson(snapshot);
            this.eventQueue.add(jsonSnapshot); // Use instance queue
            this.currentMatchId = game.getMatch().getMatchId(); // Use instance matchId
            if (this.eventQueue.size() >= BATCH_SIZE) {
                this.flushQueue();
            }
        } catch (Exception e) {
            System.err.println("ArgentumStateLogger Error: Failed to queue state for event " + eventType);
            e.printStackTrace();
        }
    }

    // --- FIX 4: Make flushQueue and logOnGameOver instance methods ---
    public void logOnGameOver(Game game) {
        queueState(game, "GAME_OVER");
        flushQueue();
    }
    
    public void flushQueue() {
        if (this.eventQueue.isEmpty() || this.currentMatchId == null) {
            return;
        }
        List<String> statesToSend = new ArrayList<>();
        String state;
        while ((state = this.eventQueue.poll()) != null) {
            statesToSend.add(state);
        }
        if (statesToSend.isEmpty()) {
            return;
        }
        String jsonBatch = "[" + String.join(",", statesToSend) + "]";
        sendBatchToLogServer(this.currentMatchId, jsonBatch);
    }

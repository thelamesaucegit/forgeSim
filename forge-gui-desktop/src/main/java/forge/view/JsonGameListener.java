// /usr/src/app/forge-gui-desktop/src/main/java/forge/view/JsonGameListener.java
package forge.view;

import com.google.common.collect.Multimap;
import com.google.common.eventbus.Subscribe;
import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import forge.game.GameEntityView;
import forge.game.card.CardView;
import forge.game.event.*;
import forge.game.player.PlayerView;
import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

public class JsonGameListener {
    private final Gson gson = new GsonBuilder().setLenient().create();
    private final List<Map<String, Object>> logBuffer;
    private final boolean directPrint;

    // Original constructor for old functionality
    public JsonGameListener() {
        this.logBuffer = null;
        this.directPrint = true;
    }

    // New constructor for ArgentumStateLogger
    public JsonGameListener(List<Map<String, Object>> buffer) {
        this.logBuffer = buffer;
        this.directPrint = false;
    }

    @Subscribe
    public void recordEvent(GameEvent event) {
        Map<String, Object> dto = event.visit(new JsonEventVisitor());
        if (dto != null) {
            if (directPrint) {
                System.out.println("JSON_EVENT:" + gson.toJson(dto));
            } else if (logBuffer != null) {
                logBuffer.add(dto);
            }
        }
    }
    
    // This inner class is now public so ArgentumStateLogger can access it.
    public static class JsonEventVisitor extends IGameEventVisitor.Base<Map<String, Object>> {
        private Map<String, Object> getCardDto(CardView card) {
            if (card == null) return null;
            Map<String, Object> cardDto = new LinkedHashMap<>();
            cardDto.put("id", card.getId());
            cardDto.put("name", card.getName());
            return cardDto;
        }

        private Map<String, Object> getPlayerDto(PlayerView player) {
            if (player == null) return null;
            Map<String, Object> playerDto = new LinkedHashMap<>();
            playerDto.put("name", player.getName());
            return playerDto;
        }

        @Override
        public Map<String, Object> visit(GameEventCardTapped event) {
            Map<String, Object> dto = new LinkedHashMap<>();
            dto.put("type", "CARD_TAPPED_CHANGE");
            dto.put("card", getCardDto(event.card()));
            dto.put("isTapped", event.tapped());
            return dto;
        }

        @Override
        public Map<String, Object> visit(GameEventBlockersDeclared event) {
            Map<String, Object> dto = new LinkedHashMap<>();
            dto.put("type", "BLOCKERS_DECLARED");
            dto.put("description", event.defendingPlayer().getName() + " declares blockers.");
            return dto;
        }
        
        @Override
        public Map<String, Object> visit(GameEventSpellAbilityCast event) {
            Map<String, Object> dto = new LinkedHashMap<>();
            dto.put("type", "SPELL_CAST");
            dto.put("card", getCardDto(event.sa().getHostCard()));
            dto.put("description", event.sa().getHostCard().getController().getName() + " casts " + event.sa().getHostCard().getName());
            return dto;
        }

        @Override
        public Map<String, Object> visit(GameEventAttackersDeclared event) {
            Map<String, Object> dto = new LinkedHashMap<>();
            dto.put("type", "ATTACKERS_DECLARED");
            dto.put("description", event.getAttackingPlayer().getName() + " declares attackers.");
            return dto;
        }

        @Override
        public Map<String, Object> visit(GameEventCardChangeZone event) {
            Map<String, Object> dto = new LinkedHashMap<>();
            dto.put("type", "ZONE_CHANGE");
            String fromStr = event.from() != null ? event.from().zoneType().toString() : "Nowhere";
            String toStr = event.to() != null ? event.to().zoneType().toString() : "Oblivion";
            dto.put("description", event.card().getName() + " moves from " + fromStr + " to " + toStr);
            return dto;
        }
        
        @Override
        public Map<String, Object> visit(GameEventTurnBegan event) {
            Map<String, Object> dto = new LinkedHashMap<>();
            dto.put("type", "TURN_BEGAN");
            dto.put("description", "Turn " + event.turnNumber() + " (" + event.turnOwner().getName() + ")");
            return dto;
        }
        
        @Override
        public Map<String, Object> visit(GameEventPlayerDamaged event) {
            Map<String, Object> dto = new LinkedHashMap<>();
            dto.put("type", "PLAYER_DAMAGED");
            dto.put("description", event.target().getName() + " takes " + event.amount() + " damage.");
            return dto;
        }
    }
}

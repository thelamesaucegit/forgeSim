package forge.view;

import java.util.ArrayList; // FIX: Added missing import
import java.util.LinkedHashMap;
import java.util.List; // FIX: Added missing import
import java.util.Map;

import com.google.common.eventbus.Subscribe;
import com.google.gson.Gson;
import com.google.gson.GsonBuilder;

import forge.game.GameEntityView;
import forge.game.card.CardView; // FIX: Added missing import
import forge.game.event.*;

public class JsonGameListener {
    private final Gson gson = new GsonBuilder().create();

    @Subscribe
    public void recordEvent(GameEvent event) {
        Map<String, Object> dto = event.visit(new JsonEventVisitor());
        
        if (dto != null) {
            System.out.println("JSON_EVENT:" + gson.toJson(dto));
        }
    }

    private static class JsonEventVisitor extends IGameEventVisitor.Base<Map<String, Object>> {

        private Map<String, Object> getCardDto(GameEntityView card) {
            if (card == null) { return null; }
            Map<String, Object> cardDto = new LinkedHashMap<>();
            cardDto.put("id", card.getId());
            cardDto.put("name", card.getName());
            return cardDto;
        }
        
        private Map<String, Object> getPlayerDto(GameEntityView player) {
            if (player == null) { return null; }
            Map<String, Object> playerDto = new LinkedHashMap<>();
            playerDto.put("name", player.getName());
            return playerDto;
        }

        @Override
        public Map<String, Object> visit(GameEventTurnBegan event) {
            Map<String, Object> dto = new LinkedHashMap<>();
            dto.put("type", "TURN_BEGAN");
            dto.put("turnNumber", event.turnNumber());
            dto.put("turnOwner", getPlayerDto(event.turnOwner()));
            return dto;
        }

        @Override
        public Map<String, Object> visit(GameEventTurnPhase event) {
            Map<String, Object> dto = new LinkedHashMap<>();
            dto.put("type", "PHASE_CHANGED");
            dto.put("player", getPlayerDto(event.playerTurn()));
            dto.put("phase", event.phase().toString());
            return dto;
        }

        @Override
        public Map<String, Object> visit(GameEventCardChangeZone event) {
            Map<String, Object> dto = new LinkedHashMap<>();
            dto.put("type", "ZONE_CHANGE");
            dto.put("card", getCardDto(event.card()));
            dto.put("from", event.from() != null ? event.from().toString() : null);
            dto.put("to", event.to() != null ? event.to().toString() : null);
            return dto;
        }

        @Override
        public Map<String, Object> visit(GameEventPlayerDamaged event) {
            Map<String, Object> dto = new LinkedHashMap<>();
            dto.put("type", "PLAYER_DAMAGED");
            dto.put("player", getPlayerDto(event.target()));
            dto.put("amount", event.amount());
            dto.put("isCombat", event.combat());
            return dto;
        }
        
        @Override
        public Map<String, Object> visit(GameEventCardDamaged event) {
            Map<String, Object> dto = new LinkedHashMap<>();
            dto.put("type", "CARD_DAMAGED");
            dto.put("card", getCardDto(event.card()));
            dto.put("damage", event.amount());
            dto.put("source", getCardDto(event.source()));
            return dto;
        }
        
        @Override
        public Map<String, Object> visit(GameEventSpellAbilityCast event) {
            Map<String, Object> dto = new LinkedHashMap<>();
            dto.put("type", "SPELL_CAST");
            dto.put("player", getPlayerDto(event.si().getActivatingPlayer()));
            dto.put("card", getCardDto(event.sa().getHostCard()));
            return dto;
        }

        @Override
        public Map<String, Object> visit(GameEventSpellResolved event) {
            Map<String, Object> dto = new LinkedHashMap<>();
            dto.put("type", "SPELL_RESOLVED");
            dto.put("card", getCardDto(event.spell().getHostCard()));
            return dto;
        }
        
        @Override
        public Map<String, Object> visit(GameEventLandPlayed event) {
            Map<String, Object> dto = new LinkedHashMap<>();
            dto.put("type", "LAND_PLAYED");
            dto.put("player", getPlayerDto(event.player()));
            dto.put("land", getCardDto(event.land()));
            return dto;
        }
        
        @Override
        public Map<String, Object> visit(GameEventAttackersDeclared event) {
            Map<String, Object> dto = new LinkedHashMap<>();
            dto.put("type", "ATTACKERS_DECLARED");
            dto.put("player", getPlayerDto(event.player()));
            
            Map<String, List<Map<String, Object>>> attacks = new LinkedHashMap<>();
            for (Map.Entry<GameEntityView, java.util.Collection<CardView>> entry : event.attackersMap().asMap().entrySet()) {
                List<Map<String, Object>> attackerList = new ArrayList<>();
                for (CardView attacker : entry.getValue()) {
                    attackerList.add(getCardDto(attacker));
                }
                attacks.put(entry.getKey().getName(), attackerList);
            }
            dto.put("attacks", attacks);
            return dto;
        }
    }
}

package forge.view;


import com.google.common.eventbus.Subscribe;
import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import forge.game.GameEntityView;
import forge.game.card.Card;
import forge.game.card.CardView;
import forge.game.combat.AttackingBand;
import forge.game.event.*;

import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

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
            if (card == null) return null;
            Map<String, Object> cardDto = new LinkedHashMap<>();
            cardDto.put("id", card.getId());
            cardDto.put("name", card.getName());
            return cardDto;
        }

        // --- NEW EVENT HANDLERS ---
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
            Map<String, List<Map<String, Object>>> blocks = new LinkedHashMap<>();
            for (Map.Entry<AttackingBand, Card> entry : event.blockers().entries()) {
                Card blocker = entry.getValue();
                for (Card attacker : entry.getKey().getAttackers()) {
                    String attackerId = String.valueOf(attacker.getId());
                    blocks.computeIfAbsent(attackerId, k -> new ArrayList<>()).add(getCardDto(CardView.get(blocker)));
                }
            }
            dto.put("blocks", blocks);
            return dto;
        }

        // --- REFINED EVENT HANDLERS ---
        @Override
        public Map<String, Object> visit(GameEventSpellAbilityCast event) {
            Map<String, Object> dto = new LinkedHashMap<>();
            dto.put("type", "SPELL_CAST");
            dto.put("card", getCardDto(event.sa().getHostCard()));
            return dto;
        }

        @Override
        public Map<String, Object> visit(GameEventAttackersDeclared event) {
            Map<String, Object> dto = new LinkedHashMap<>();
            dto.put("type", "ATTACKERS_DECLARED");
            Map<String, Integer> attackers = new LinkedHashMap<>();
            for (Collection<CardView> band : event.attackersMap().asMap().values()) {
                for (CardView attacker : band) {
                    attackers.put(String.valueOf(attacker.getId()), 1);
                }
            }
            dto.put("attackers", attackers);
            return dto;
        }

        @Override
        public Map<String, Object> visit(GameEventZone event) {
            Map<String, Object> dto = new LinkedHashMap<>();
            dto.put("type", "ZONE_CHANGE");
            dto.put("card", getCardDto(event.card()));
            dto.put("from", event.zoneType() != null ? event.zoneType().toString() : null);
            dto.put("to", event.mode().toString()); // Using mode for destination for simplicity
            dto.put("player", getPlayerDto(event.player()));
            return dto;
        }
        
        // -- Unchanged but still necessary --
        @Override
        public Map<String, Object> visit(GameEventTurnBegan event) {
            Map<String, Object> dto = new LinkedHashMap<>();
            dto.put("type", "TURN_BEGAN");
            dto.put("turnNumber", event.turnNumber());
            dto.put("turnOwner", getPlayerDto(event.turnOwner()));
            return dto;
        }
        @Override
        public Map<String, Object> visit(GameEventPlayerDamaged event) {
            Map<String, Object> dto = new LinkedHashMap<>();
            dto.put("type", "PLAYER_DAMAGED");
            dto.put("player", getPlayerDto(event.target()));
            dto.put("amount", event.amount());
            return dto;
        }

        // -- Ignored Events --
        @Override public Map<String, Object> visit(GameEventTurnPhase e) { return null; }
        @Override public Map<String, Object> visit(GameEventCardChangeZone e) { return null; }
        @Override public Map<String, Object> visit(GameEventSpellResolved e) { return null; }
        @Override public Map<String, Object> visit(GameEventLandPlayed e) { return null; }
    }
}

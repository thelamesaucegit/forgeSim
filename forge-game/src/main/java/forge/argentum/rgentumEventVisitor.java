// /usr/src/app/forge-game/src/main/java/forge/argentum/ArgentumEventVisitor.java
package forge.argentum;

import forge.game.GameEntity;
import forge.game.card.Card;
import forge.game.event.*;
import forge.game.player.Player;
import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

public class ArgentumEventVisitor extends IGameEventVisitor.Base<Map<String, Object>> {

    private Map<String, Object> getCardDto(Card card) {
        if (card == null) return null;
        Map<String, Object> cardDto = new LinkedHashMap<>();
        cardDto.put("id", String.valueOf(card.getId()));
        cardDto.put("name", card.getName());
        return cardDto;
    }

    private Map<String, Object> getPlayerDto(Player player) {
        if (player == null) return null;
        Map<String, Object> playerDto = new LinkedHashMap<>();
        playerDto.put("name", player.getName());
        // You can add more player details here if needed in the log
        return playerDto;
    }
    
    // Add visit methods for all events we want to log
    // We can add more later as needed

    @Override
    public Map<String, Object> visit(GameEventTurnBegan event) {
        Map<String, Object> dto = new LinkedHashMap<>();
        dto.put("type", "TURN_BEGAN");
        dto.put("description", "Turn " + event.turnNumber + " (" + event.turnOwner.getName() + ")");
        return dto;
    }
    
    @Override
    public Map<String, Object> visit(GameEventTurnPhase event) {
        Map<String, Object> dto = new LinkedHashMap<>();
        dto.put("type", "PHASE_CHANGED");
        dto.put("description", event.phase.toString() + " Step");
        return dto;
    }

    @Override
    public Map<String, Object> visit(GameEventSpellAbilityCast event) {
        Map<String, Object> dto = new LinkedHashMap<>();
        dto.put("type", "SPELL_CAST");
        String casterName = event.sa.getActivatingPlayer().getName();
        String spellName = event.sa.getHostCard().getName();
        dto.put("description", casterName + " casts " + spellName);
        return dto;
    }

    @Override
    public Map<String, Object> visit(GameEventPlayerDamaged event) {
        Map<String, Object> dto = new LinkedHashMap<>();
        dto.put("type", "PLAYER_DAMAGED");
        dto.put("description", event.target.getName() + " takes " + event.amount + " damage.");
        return dto;
    }

    @Override
    public Map<String, Object> visit(GameEventCardChangeZone event) {
        Map<String, Object> dto = new LinkedHashMap<>();
        dto.put("type", "ZONE_CHANGE");
        String fromZone = event.from != null ? event.from.getZoneType().name() : "Nowhere";
        String toZone = event.to != null ? event.to.getZoneType().name() : "Oblivion";
        dto.put("description", event.card.getName() + " moves from " + fromZone + " to " + toZone);
        return dto;
    }
}

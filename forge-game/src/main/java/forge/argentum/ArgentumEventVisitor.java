// /usr/src/app/forge-game/src/main/java/forge/argentum/ArgentumEventVisitor.java
package forge.argentum;

import forge.game.card.CardView;
import forge.game.event.*;
import forge.game.player.PlayerView;
import forge.game.spellability.SpellAbilityView;
import forge.game.zone.ZoneView;
import java.util.Map;
import java.util.LinkedHashMap;

public class ArgentumEventVisitor extends IGameEventVisitor.Base<Map<String, Object>> {

    // Private helper methods are fine
    private Map<String, Object> getCardDto(CardView card) {
        if (card == null) return null;
        Map<String, Object> dto = new LinkedHashMap<>();
        dto.put("id", String.valueOf(card.getId()));
        dto.put("name", card.getName());
        return dto;
    }

    private Map<String, Object> getPlayerDto(PlayerView player) {
        if (player == null) return null;
        Map<String, Object> dto = new LinkedHashMap<>();
        dto.put("name", player.getName());
        return dto;
    }

    // All visit methods MUST use @Override and public accessors like event.turnNumber()
    @Override
    public Map<String, Object> visit(GameEventTurnBegan event) {
        Map<String, Object> dto = new LinkedHashMap<>();
        dto.put("type", "TURN_BEGAN");
        dto.put("description", "Turn " + event.turnNumber() + " (" + event.turnOwner().getName() + ")");
        return dto;
    }
    
    @Override
    public Map<String, Object> visit(GameEventTurnPhase event) {
        Map<String, Object> dto = new LinkedHashMap<>();
        dto.put("type", "PHASE_CHANGED");
        dto.put("description", event.phase().toString() + " Step");
        return dto;
    }

    @Override
    public Map<String, Object> visit(GameEventSpellAbilityCast event) {
        Map<String, Object> dto = new LinkedHashMap<>();
        dto.put("type", "SPELL_CAST");
        SpellAbilityView sa = event.sa();
        String casterName = sa.getHostCard().getController().getName();
        String spellName = sa.getHostCard().getName();
        dto.put("description", casterName + " casts " + spellName);
        return dto;
    }

    @Override
    public Map<String, Object> visit(GameEventPlayerDamaged event) {
        Map<String, Object> dto = new LinkedHashMap<>();
        dto.put("type", "PLAYER_DAMAGED");
        dto.put("description", event.target().getName() + " takes " + event.amount() + " damage.");
        return dto;
    }

    @Override
    public Map<String, Object> visit(GameEventCardChangeZone event) {
        Map<String, Object> dto = new LinkedHashMap<>();
        dto.put("type", "ZONE_CHANGE");
        ZoneView fromZone = event.from();
        ZoneView toZone = event.to();
        String fromStr = fromZone != null ? fromZone.zoneType().name() : "Nowhere";
        String toStr = toZone != null ? toZone.zoneType().name() : "Oblivion";
        dto.put("description", event.card().getName() + " moves from " + fromStr + " to " + toStr);
        return dto;
    }
    
    @Override
    public Map<String, Object> visit(GameEventAttackersDeclared event) {
        Map<String, Object> dto = new LinkedHashMap<>();
        dto.put("type", "ATTACKERS_DECLARED");
        dto.put("description", event.attackingPlayer().getName() + " declares attackers.");
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
    public Map<String, Object> visit(GameEventCombatResult event) {
        Map<String, Object> dto = new LinkedHashMap<>();
        dto.put("type", "COMBAT_RESULT");
        dto.put("description", "Combat damage is dealt.");
        return dto;
    }
}

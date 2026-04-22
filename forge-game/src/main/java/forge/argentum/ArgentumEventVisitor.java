// /usr/src/app/forge-game/src/main/java/forge/argentum/ArgentumEventVisitor.java
package forge.argentum;

import forge.game.event.*;
import forge.game.player.PlayerView;
import forge.game.spellability.SpellAbilityView;

import java.util.LinkedHashMap;
import java.util.Map;

public class ArgentumEventVisitor extends IGameEventVisitor.Base<Map<String, Object>> {

    @Override
    public Map<String, Object> visit(GameEventTurnBegan event) {
        Map<String, Object> dto = new LinkedHashMap<>();
        dto.put("type", "turnChanged");
        dto.put("turnNumber", event.turnNumber());
        dto.put("activePlayerId", String.valueOf(event.turnOwner().getId()));
        dto.put("description", "Turn " + event.turnNumber() + " (" + event.turnOwner().getName() + ")");
        return dto;
    }

    @Override
    public Map<String, Object> visit(GameEventSpellAbilityCast event) {
        SpellAbilityView sa = event.sa();
        Map<String, Object> dto = new LinkedHashMap<>();

        if (sa.isAbility()) {
            dto.put("type", "abilityActivated");
            dto.put("sourceId", String.valueOf(sa.getHostCard().getId()));
            dto.put("sourceName", sa.getHostCard().getName());
            dto.put("abilityDescription", sa.toString());
            dto.put("description", sa.getHostCard().getController().getName() + " activates an ability of " + sa.getHostCard().getName());
        } else {
            dto.put("type", "spellCast");
            dto.put("spellId", String.valueOf(sa.getHostCard().getId()));
            dto.put("spellName", sa.getHostCard().getName());
            dto.put("casterId", String.valueOf(sa.getHostCard().getController().getId()));
            dto.put("description", sa.getHostCard().getController().getName() + " casts " + sa.getHostCard().getName());
        }
        return dto;
    }

    // THIS IS THE FIX: The single, correct implementation of this method.
    @Override
    public Map<String, Object> visit(GameEventPlayerDamaged event) {
        Map<String, Object> dto = new LinkedHashMap<>();
        PlayerView target = event.target();
        
        dto.put("type", "lifeChanged");
        dto.put("playerId", String.valueOf(target.getId()));
        dto.put("oldLife", target.getLife() + event.amount()); // Calculate life before damage
        dto.put("newLife", target.getLife());
        dto.put("change", -event.amount());
        dto.put("description", target.getName() + " takes " + event.amount() + " damage.");
        return dto;
    }

    // The other visit methods from the original file remain, returning null
    // as they do not generate log entries for the new system.
    @Override
    public Map<String, Object> visit(GameEventTurnPhase event) {
        return null; 
    }

    @Override
    public Map<String, Object> visit(GameEventCardChangeZone event) {
        return null; 
    }

    @Override
    public Map<String, Object> visit(GameEventAttackersDeclared event) {
        return null; 
    }

    @Override
    public Map<String, Object> visit(GameEventBlockersDeclared event) {
        return null; 
    }

    @Override
    public Map<String, Object> visit(GameEventCombatEnded event) {
        return null;
    }
}

// /usr/src/app/forge-game/src/main/java/forge/argentum/ArgentumEventVisitor.java
package forge.argentum;

import forge.game.card.CardView;
import forge.game.event.*;
import forge.game.player.PlayerView;
import forge.game.spellability.SpellAbilityView;
import forge.game.zone.ZoneType;
import forge.game.zone.ZoneView;

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
    public Map<String, Object> visit(GameEventTurnPhase event) {
        Map<String, Object> dto = new LinkedHashMap<>();
        dto.put("type", "phaseChanged");
        // FIX: Using .name() which is a standard method on all enums.
        dto.put("description", event.phase().name() + " Step");
        return dto;
    }

    @Override
    public Map<String, Object> visit(GameEventSpellAbilityCast event) {
        Map<String, Object> dto = new LinkedHashMap<>();
        SpellAbilityView sa = event.sa();
        dto.put("type", "spellCast");
        dto.put("spellId", String.valueOf(sa.getHostCard().getId()));
        dto.put("spellName", sa.getHostCard().getName());
        // FIX: Using the correct method to get the controller of the card.
        dto.put("casterId", String.valueOf(sa.getHostCard().getController().getId()));
        dto.put("description", sa.getHostCard().getController().getName() + " casts " + sa.getHostCard().getName());
        return dto;
    }

    @Override
    public Map<String, Object> visit(GameEventPlayerDamaged event) {
        Map<String, Object> dto = new LinkedHashMap<>();
        dto.put("type", "damageDealt");
        dto.put("sourceId", event.source() != null ? String.valueOf(event.source().getId()) : null);
        dto.put("sourceName", event.source() != null ? event.source().getName() : "Unknown");
        dto.put("targetId", String.valueOf(event.target().getId()));
        dto.put("targetName", event.target().getName());
        dto.put("amount", event.amount());
        dto.put("targetIsPlayer", true);
        // FIX: Removed isCombatDamage as the method does not exist.
        dto.put("description", event.target().getName() + " takes " + event.amount() + " damage.");
        return dto;
    }

    @Override
    public Map<String, Object> visit(GameEventCardChangeZone event) {
        Map<String, Object> dto = new LinkedHashMap<>();
        ZoneView fromZone = event.from();
        ZoneView toZone = event.to();
        String fromStr = fromZone != null ? fromZone.zoneType().name().toLowerCase() : "nowhere";
        String toStr = toZone != null ? toZone.zoneType().name().toLowerCase() : "oblivion";
        
        dto.put("cardId", String.valueOf(event.card().getId()));
        dto.put("cardName", event.card().getName());
        dto.put("destination", toStr);
        dto.put("description", event.card().getName() + " moves from " + fromStr + " to " + toStr);

        if ("battlefield".equals(toStr)) {
            dto.put("type", "permanentEntered");
        } else {
            dto.put("type", "permanentLeft");
        }
        
        return dto;
    }

    @Override
    public Map<String, Object> visit(GameEventAttackersDeclared event) {
        Map<String, Object> dto = new LinkedHashMap<>();
        dto.put("type", "attackersDeclared");
        dto.put("description", event.player().getName() + " declares attackers.");
        return dto;
    }

    @Override
    public Map<String, Object> visit(GameEventBlockersDeclared event) {
        Map<String, Object> dto = new LinkedHashMap<>();
        dto.put("type", "blockersDeclared");
        dto.put("description", event.defendingPlayer().getName() + " declares blockers.");
        return dto;
    }

    @Override
    public Map<String, Object> visit(GameEventCombatEnded event) {
        Map<String, Object> dto = new LinkedHashMap<>();
        dto.put("type", "combatEnded");
        dto.put("description", "Combat damage is dealt.");
        return dto;
    }
}

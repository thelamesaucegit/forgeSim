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

// This visitor now creates objects that directly match the TypeScript ClientEvent interfaces.
public class ArgentumEventVisitor extends IGameEventVisitor.Base<Object> {

    // Base DTO for all events
    private static abstract class ClientEventDTO {
        public String type;
        public String description;
    }

    private static class TurnBeganDTO extends ClientEventDTO {
        // No extra fields needed, description is sufficient
    }
    
    private static class TurnChangedDTO extends ClientEventDTO {
        public int turnNumber;
        public String activePlayerId;
    }

    private static class PhaseChangedDTO extends ClientEventDTO {
        // No extra fields, description is sufficient
    }

    private static class SpellCastDTO extends ClientEventDTO {
        public String spellId;
        public String spellName;
        public String casterId;
    }

    private static class PlayerDamagedDTO extends ClientEventDTO {
        public String sourceId;
        public String sourceName;
        public String targetId;
        public String targetName;
        public int amount;
        public boolean targetIsPlayer = true;
        public boolean isCombatDamage; // Will need to be determined
    }

    private static class ZoneChangeDTO extends ClientEventDTO {
        public String cardId;
        public String cardName;
        public String destination;
    }

    private static class AttackersDeclaredDTO extends ClientEventDTO {
        // We can add more fields here if needed later
    }

    private static class BlockersDeclaredDTO extends ClientEventDTO {
        // We can add more fields here if needed later
    }

    private static class CombatEndedDTO extends ClientEventDTO {
        // No extra fields, description is sufficient
    }


    @Override
    public Object visit(GameEventTurnBegan event) {
        TurnChangedDTO dto = new TurnChangedDTO();
        dto.type = "turnChanged";
        dto.turnNumber = event.turnNumber();
        dto.activePlayerId = String.valueOf(event.turnOwner().getId());
        dto.description = "Turn " + event.turnNumber() + " (" + event.turnOwner().getName() + ")";
        return dto;
    }

    @Override
    public Object visit(GameEventTurnPhase event) {
        PhaseChangedDTO dto = new PhaseChangedDTO();
        dto.type = "phaseChanged"; // Custom type, can be handled or ignored in UI
        dto.description = event.phase().getStepName(event.phase()) + " Step";
        return dto;
    }

    @Override
    public Object visit(GameEventSpellAbilityCast event) {
        SpellCastDTO dto = new SpellCastDTO();
        SpellAbilityView sa = event.sa();
        dto.type = "spellCast";
        dto.spellId = String.valueOf(sa.getHostCard().getId());
        dto.spellName = sa.getHostCard().getName();
        dto.casterId = String.valueOf(sa.getActivatingPlayer().getId());
        dto.description = sa.getActivatingPlayer().getName() + " casts " + sa.getHostCard().getName();
        return dto;
    }

    @Override
    public Object visit(GameEventPlayerDamaged event) {
        PlayerDamagedDTO dto = new PlayerDamagedDTO();
        dto.type = "damageDealt";
        dto.sourceId = event.source() != null ? String.valueOf(event.source().getId()) : null;
        dto.sourceName = event.source() != null ? event.source().getName() : "Unknown";
        dto.targetId = String.valueOf(event.target().getId());
        dto.targetName = event.target().getName();
        dto.amount = event.amount();
        dto.isCombatDamage = event.isCombatDamage();
        dto.description = event.target().getName() + " takes " + event.amount() + " damage.";
        return dto;
    }

    @Override
    public Object visit(GameEventCardChangeZone event) {
        ZoneChangeDTO dto = new ZoneChangeDTO();
        dto.type = "permanentLeft"; // Assuming most interesting zone changes are things leaving play
        ZoneView fromZone = event.from();
        ZoneView toZone = event.to();
        String fromStr = fromZone != null ? fromZone.zoneType().name().toLowerCase() : "nowhere";
        String toStr = toZone != null ? toZone.zoneType().name().toLowerCase() : "oblivion";
        
        dto.cardId = String.valueOf(event.card().getId());
        dto.cardName = event.card().getName();
        dto.destination = toStr; // Matches 'graveyard' | 'exile' | 'hand' | 'library'
        dto.description = event.card().getName() + " moves from " + fromStr + " to " + toStr;

        if ("battlefield".equals(toStr)) {
            dto.type = "permanentEntered";
        }
        
        return dto;
    }

    @Override
    public Object visit(GameEventAttackersDeclared event) {
        AttackersDeclaredDTO dto = new AttackersDeclaredDTO();
        dto.type = "attackersDeclared"; // Custom type
        dto.description = event.player().getName() + " declares attackers.";
        return dto;
    }

    @Override
    public Object visit(GameEventBlockersDeclared event) {
        BlockersDeclaredDTO dto = new BlockersDeclaredDTO();
        dto.type = "blockersDeclared"; // Custom type
        dto.description = event.defendingPlayer().getName() + " declares blockers.";
        return dto;
    }

    @Override
    public Object visit(GameEventCombatEnded event) {
        CombatEndedDTO dto = new CombatEndedDTO();
        dto.type = "combatEnded"; // Custom type
        dto.description = "Combat damage is dealt.";
        return dto;
    }
}

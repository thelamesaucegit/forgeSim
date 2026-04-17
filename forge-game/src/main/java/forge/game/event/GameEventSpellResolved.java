// /usr/src/app/forge-game/src/main/java/forge/game/event/GameEventSpellResolved.java

package forge.game.event;

import forge.game.spellability.SpellAbility;
import forge.game.spellability.SpellAbilityView;

// Revert this file to its original state. No 'IHasGame', no 'getGame()'.
public record GameEventSpellResolved(SpellAbilityView spell, boolean hasFizzled, String stackDescription) implements GameEvent {

    public GameEventSpellResolved(SpellAbility spell, boolean hasFizzled) {
        this(SpellAbilityView.get(spell), hasFizzled, spell.getStackDescription());
    }

    @Override
    public <T> T visit(IGameEventVisitor<T> visitor) {
        return visitor.visit(this);
    }

    @Override
    public String toString() {
        return "Stack resolved " + spell + (hasFizzled ? " (fizzled)" : "");
    }
}

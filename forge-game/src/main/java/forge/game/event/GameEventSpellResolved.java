//forge-game/src/main/java/forge/game/event/GameEventSpellResolved.java

package forge.game.event;

import forge.game.spellability.SpellAbility;
import forge.game.spellability.SpellAbilityView;
import forge.game.Game; // Import the Game class


public record GameEventSpellResolved(SpellAbilityView spell, boolean hasFizzled, String stackDescription) implements GameEvent, IHasGame {

    public GameEventSpellResolved(SpellAbility spell, boolean hasFizzled) {
        this(SpellAbilityView.get(spell), hasFizzled, spell.getStackDescription());
    }

    @Override
    public <T> T visit(IGameEventVisitor<T> visitor) {
        return visitor.visit(this);
    }
    
    // --- FIX: Add the getGame() method ---
    @Override
    public Game getGame() {
        return this.spell.getGame();
    }

    @Override
    public String toString() {
        return "Stack resolved " + spell + (hasFizzled ? " (fizzled)" : "");
    }
}

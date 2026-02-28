/*
 * Forge: Play Magic: the Gathering.
 * Copyright (C) 2011  Forge Team
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */
package forge.view;

import forge.gui.GuiBase;
import forge.gui.HeadlessGui;
import forge.gui.card.CardReaderExperiments;

/**
 * Main entry point for Forge. Acts as a simple router to command-line or GUI mode.
 */
public final class Main {

    /**
     * Main entry point for Forge.
     */
    public static void main(final String[] args) {
        // These system properties are safe and can be set for both modes.
        System.setProperty("java.util.Arrays.useLegacyMergeSort", "true");
        System.setProperty("sun.java2d.d3d", "false");

        if (args.length > 0) {
            runCommandLineMode(args);
        } else {
            // This call is now to a separate class, ensuring no GUI components
            // are loaded by the JVM in command-line mode.
            GuiAppRunner.start();
        }
    }

    /**
     * Initializes and runs the application in command-line mode (e.g., 'sim').
     * No Swing/AWT classes are ever referenced in this execution path.
     */
    private static void runCommandLineMode(final String[] args) {
        // Set the headless GUI implementation first.
        GuiBase.setInterface(new HeadlessGui());

        // Process the command-line arguments.
        String mode = args[0].toLowerCase();
        switch (mode) {
            case "sim":
                SimulateMatch.simulate(args);
                break;
            case "parse":
                CardReaderExperiments.parseAllCards(args);
                break;
            case "server":
                System.out.println("Dedicated server mode.\nNot implemented.");
                break;
            default:
                System.out.println("Unknown mode.\nKnown mode is 'sim', 'parse' ");
                break;
        }
        System.exit(0);
    }

    // This class is now just a router, so finalize is no longer needed here.
    
    // disallow instantiation
    private Main() {
    }
}

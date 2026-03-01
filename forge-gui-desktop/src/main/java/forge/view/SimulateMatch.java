package forge.view;

import java.io.File;
import java.util.ArrayList;
import java.util.Collections;
import java.util.EnumSet;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import org.apache.commons.lang3.time.StopWatch;
import forge.LobbyPlayer;
import forge.deck.Deck;
import forge.deck.DeckGroup;
import forge.deck.io.DeckSerializer;
import forge.game.Game;
import forge.game.GameEndReason;
import forge.game.GameLogEntry;
import forge.game.GameLogEntryType;
import forge.game.GameRules;
import forge.game.GameType;
import forge.game.Match;
import forge.game.player.RegisteredPlayer;
import forge.gamemodes.tournament.system.AbstractTournament;
import forge.gamemodes.tournament.system.TournamentBracket;
import forge.gamemodes.tournament.system.TournamentPairing;
import forge.gamemodes.tournament.system.TournamentPlayer;
import forge.gamemodes.tournament.system.TournamentRoundRobin;
import forge.gamemodes.tournament.system.TournamentSwiss;
import forge.localinstance.properties.ForgeConstants;
import forge.model.FModel;
import forge.player.GamePlayerUtil;
import forge.util.Lang;
import forge.util.TextUtil;
import forge.util.WordUtil;
import forge.util.storage.IStorage;

public class SimulateMatch {

    public static void simulate(String[] args) {
        // We pass 'true' to tell the FModel that this is a simulation and not a GUI session.
        FModel.initialize(null, null, true);
        System.out.println("Simulation mode");

        if (args.length < 4) {
            argumentHelp();
            return;
        }

        final Map<String, List<String>> params = new HashMap<String, List<String>>();
        List<String> options = null;

        // Correctly parse command-line arguments, allowing multiple values for a single flag.
        for (int i = 1; i < args.length; i++) {
            final String a = args[i];
            if (a.charAt(0) == '-') {
                if (a.length() < 2) {
                    System.err.println("Error at argument " + a);
                    argumentHelp();
                    return;
                }
                String key = a.substring(1);
                // Get the existing list for this flag, or create a new one if it's the first time.
                options = params.computeIfAbsent(key, k -> new ArrayList<>());
            } else if (options != null) {
                options.add(a);
            } else {
                System.err.println("Illegal parameter usage");
                return;
            }
        }

        int nGames = 1;
        if (params.containsKey("n")) {
            nGames = Integer.parseInt(params.get("n").get(0));
        }

        int matchSize = 0;
        if (params.containsKey("m")) {
            matchSize = Integer.parseInt(params.get("m").get(0));
        }

        boolean outputGamelog = !params.containsKey("q");
        GameType type = GameType.Constructed;
        if (params.containsKey("f")) {
            type = GameType.valueOf(WordUtil.capitalize(params.get("f").get(0)));
        }
        GameRules rules = new GameRules(type);
        rules.setAppliedVariants(EnumSet.of(type));

        if (matchSize != 0) {
            rules.setGamesPerMatch(matchSize);
        }

        if (params.containsKey("t")) {
            simulateTournament(params, rules, outputGamelog);
            System.out.flush();
            return;
        }

        List<RegisteredPlayer> pp = new ArrayList<RegisteredPlayer>();
        StringBuilder sb = new StringBuilder();
        int i = 1;

        if (params.containsKey("d")) {
            for (String deck : params.get("d")) {
                Deck d = deckFromCommandLineParameter(deck, type);
                if (d == null) {
                    System.out.println(TextUtil.concatNoSpace("Could not load deck - ", deck, ", match cannot start"));
                    return;
                }
                if (i > 1) {
                    sb.append(" vs ");
                }

                String aiProfile = "";
                if (params.containsKey("a") && (i - 1) < params.get("a").size()) {
                    aiProfile = params.get("a").get(i - 1);
                }

                String playerName = TextUtil.concatNoSpace("Ai(", String.valueOf(i), ")-", d.getName());
                // The player name used by the game engine should include the AI profile for clarity in logs
                String fullPlayerName = playerName;
                if (!aiProfile.isEmpty()) {
                    fullPlayerName = TextUtil.concatNoSpace(playerName, " (AI: ", aiProfile, ")");
                }
                sb.append(fullPlayerName);

                RegisteredPlayer rp;
                if (type.equals(GameType.Commander)) {
                    rp = RegisteredPlayer.forCommander(d);
                } else {
                    rp = new RegisteredPlayer(d);
                }
                // Use the full name for the player object
                rp.setPlayer(GamePlayerUtil.createAiPlayer(fullPlayerName, i - 1, 0, null, aiProfile));
                pp.add(rp);
                i++;
            }
        }

        if (params.containsKey("c")) {
            rules.setSimTimeout(Integer.parseInt(params.get("c").get(0)));
        }

        sb.append(" - ").append(Lang.nounWithNumeral(nGames, "game")).append(" of ").append(type);
        System.out.println(sb.toString());

        Match mc = new Match(rules, pp, "Test");
        if (matchSize != 0) {
            int iGame = 0;
            while (!mc.isMatchOver()) {
                simulateSingleMatch(mc, iGame, outputGamelog);
                iGame++;
            }
        } else {
            for (int iGame = 0; iGame < nGames; iGame++) {
                simulateSingleMatch(mc, iGame, outputGamelog);
            }
        }

        System.out.flush();
    }

    private static void argumentHelp() {
        System.out.println("Syntax: forge.exe sim -d <deck1[.dck]> <deck2[.dck]> ... -a [profile1] [profile2] ... -n [N] -q");
        System.out.println("\t-d: One or more deck names or filenames, separated by spaces.");
        System.out.println("\t-a: AI profiles for each deck, in corresponding order.");
        System.out.println("\t-n: Number of games to play (defaults to 1).");
        System.out.println("\t-q: Quiet mode (suppresses full game log).");
        // Add other arguments as needed
    }

    public static void simulateSingleMatch(final Match mc, int iGame, boolean outputGamelog) {
        final StopWatch sw = new StopWatch();
        sw.start();
        final Game g1 = mc.createGame();
        try {
            TimeLimitedCodeBlock.runWithTimeout(() -> {
                mc.startGame(g1);
                sw.stop();
            }, mc.getRules().getSimTimeout(), TimeUnit.SECONDS);
        } catch (TimeoutException e) {
            System.out.println("Stopping slow match as draw");
        } catch (Exception e) {
            e.printStackTrace();
        } finally {
            if (sw.isStarted()) {
                sw.stop();
            }
            if (!g1.isGameOver()) {
                g1.setGameOver(GameEndReason.Draw);
            }
        }

        List<GameLogEntry> log;
        if (outputGamelog) {
            log = g1.getGameLog().getLogEntries(null);
        } else {
            log = g1.getGameLog().getLogEntries(GameLogEntryType.MATCH_RESULTS);
        }
        Collections.reverse(log);
        for (GameLogEntry l : log) {
            // Use getMessage() to ensure formatted output for all log types
            System.out.println(l.getMessage());
        }

        if (g1.getOutcome().isDraw()) {
            System.out.printf("\nGame Result: Game %d ended in a Draw! Took %d ms.%n", 1 + iGame, sw.getTime());
        } else {
            System.out.printf("\nGame Result: Game %d ended in %d ms. %s has won!\n\n", 1 + iGame, sw.getTime(), g1.getOutcome().getWinningLobbyPlayer().getName());
        }
    }

    private static void simulateTournament(Map<String, List<String>> params, GameRules rules, boolean outputGamelog) {
        String tournament = params.get("t").get(0);
        AbstractTournament tourney = null;
        int matchPlayers = params.containsKey("p") ? Integer.parseInt(params.get("p").get(0)) : 2;
        DeckGroup deckGroup = new DeckGroup("SimulatedTournament");
        List<TournamentPlayer> players = new ArrayList<>();
        int numPlayers = 0;

        if (params.containsKey("d")) {
            for (String deck : params.get("d")) {
                Deck d = deckFromCommandLineParameter(deck, rules.getGameType());
                if (d == null) {
                    System.out.println(TextUtil.concatNoSpace("Could not load deck - ", deck, ", match cannot start"));
                    return;
                }
                deckGroup.addAiDeck(d);
                String aiProfile = "";
                if (params.containsKey("a") && numPlayers < params.get("a").size()) {
                    aiProfile = params.get("a").get(numPlayers);
                }
                String playerName = d.getName();
                if (!aiProfile.isEmpty()) {
                    playerName = TextUtil.concatNoSpace(playerName, " (AI: ", aiProfile, ")");
                }
                players.add(new TournamentPlayer(GamePlayerUtil.createAiPlayer(playerName, 0, 0, null, aiProfile), numPlayers));
                numPlayers++;
            }
        }

        if (params.containsKey("D")) {
            String foldName = params.get("D").get(0);
            File folder = new File(foldName);
            if (!folder.isDirectory()) {
                System.out.println("Directory not found - " + foldName);
            } else {
                for (File deck : folder.listFiles()) {
                    if (deck.getName().endsWith(".dck")) {
                        Deck d = DeckSerializer.fromFile(deck);
                        if (d == null) {
                            System.out.println(TextUtil.concatNoSpace("Could not load deck - ", deck.getName(), ", match cannot start"));
                            return;
                        }
                        deckGroup.addAiDeck(d);
                        String aiProfile = "";
                        if (params.containsKey("a") && numPlayers < params.get("a").size()) {
                            aiProfile = params.get("a").get(numPlayers);
                        }
                        String playerName = d.getName();
                        if (!aiProfile.isEmpty()) {
                            playerName = TextUtil.concatNoSpace(playerName, " (AI: ", aiProfile, ")");
                        }
                        players.add(new TournamentPlayer(GamePlayerUtil.createAiPlayer(playerName, 0, 0, null, aiProfile), numPlayers));
                        numPlayers++;
                    }
                }
            }
        }

        if (numPlayers == 0) {
            System.out.println("No decks/Players found. Please try again.");
            return;
        }

        if ("bracket".equalsIgnoreCase(tournament)) {
            tourney = new TournamentBracket(players, matchPlayers);
        } else if ("roundrobin".equalsIgnoreCase(tournament)) {
            tourney = new TournamentRoundRobin(players, matchPlayers);
        } else if ("swiss".equalsIgnoreCase(tournament)) {
            tourney = new TournamentSwiss(players, matchPlayers);
        }

        if (tourney == null) {
            System.out.println("Failed to initialize tournament, bailing out");
            return;
        }

        tourney.initializeTournament();
        String lastWinner = "";
        int curRound = 0;
        System.out.println(TextUtil.concatNoSpace("Starting a ", tournament, " tournament with ",
                String.valueOf(numPlayers), " players over ",
                String.valueOf(tourney.getTotalRounds()), " rounds"));
        while (!tourney.isTournamentOver()) {
            if (tourney.getActiveRound() != curRound) {
                if (curRound != 0) {
                    System.out.println(TextUtil.concatNoSpace("End Round - ", String.valueOf(curRound)));
                }
                curRound = tourney.getActiveRound();
                System.out.println();
                System.out.println(TextUtil.concatNoSpace("Round ", String.valueOf(curRound), " Pairings:"));
                for (TournamentPairing pairing : tourney.getActivePairings()) {
                    System.out.println(pairing.outputHeader());
                }
                System.out.println();
            }

            TournamentPairing pairing = tourney.getNextPairing();
            List<RegisteredPlayer> regPlayers = AbstractTournament.registerTournamentPlayers(pairing, deckGroup);

            StringBuilder sb = new StringBuilder();
            sb.append("Round ").append(tourney.getActiveRound()).append(" - ");
            sb.append(pairing.outputHeader());
            System.out.println(sb.toString());

            if (!pairing.isBye()) {
                Match mc = new Match(rules, regPlayers, "TourneyMatch");
                int exceptions = 0;
                int iGame = 0;
                while (!mc.isMatchOver()) {
                    try {
                        simulateSingleMatch(mc, iGame, outputGamelog);
                        iGame++;
                    } catch (Exception e) {
                        exceptions++;
                        System.out.println(e.toString());
                        if (exceptions > 5) {
                            System.out.println("Exceeded number of exceptions thrown. Abandoning match...");
                            break;
                        } else {
                            System.out.println("Game threw exception. Abandoning game and continuing...");
                        }
                    }
                }

                LobbyPlayer winner = mc.getWinner().getPlayer();
                for (TournamentPlayer tp : pairing.getPairedPlayers()) {
                    if (winner.equals(tp.getPlayer())) {
                        pairing.setWinner(tp);
                        lastWinner = winner.getName();
                        System.out.println(TextUtil.concatNoSpace("Match Winner - ", lastWinner, "!"));
                        System.out.println();
                        break;
                    }
                }
            }
            tourney.reportMatchCompletion(pairing);
        }
        tourney.outputTournamentResults();
    }

    public static Match simulateOffthreadGame(List<Deck> decks, GameType format, int games) {
        return null;
    }

    private static Deck deckFromCommandLineParameter(String deckname, GameType type) {
        int dotpos = deckname.lastIndexOf('.');
        if (dotpos > 0 && dotpos == deckname.length() - 4) {
            String baseDir = type.equals(GameType.Commander) ?
                    ForgeConstants.DECK_COMMANDER_DIR : ForgeConstants.DECK_CONSTRUCTED_DIR;
            File f = new File(baseDir + deckname);
            if (!f.exists()) {
                System.out.println("No deck found in " + baseDir);
                return null;
            }
            return DeckSerializer.fromFile(f);
        }

        IStorage<Deck> deckStore = null;
        if (type.equals(GameType.Commander)) {
            deckStore = FModel.getDecks().getCommander();
        } else {
            deckStore = FModel.getDecks().getConstructed();
        }

        return deckStore.get(deckname);
    }
}

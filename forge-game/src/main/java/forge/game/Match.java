// forge/game/Match.java

package forge.game;

import com.google.common.collect.*;
import com.google.common.eventbus.EventBus;
import forge.LobbyPlayer;
import forge.deck.CardPool;
import forge.deck.Deck;
import forge.deck.DeckFormat;
import forge.deck.DeckSection;
import forge.game.ability.AbilityKey;
import forge.game.card.Card;
import forge.game.card.CardCollectionView;
import forge.game.event.Event;
import forge.game.event.GameEventAddLog;
import forge.game.event.GameEventAnteCardsSelected;
import forge.game.event.GameEventGameFinished;
import forge.game.player.Player;
import forge.game.player.PlayerController;
import forge.game.player.RegisteredPlayer;
import forge.game.trigger.Trigger;
import forge.game.zone.PlayerZone;
import forge.game.zone.ZoneType;
import forge.item.PaperCard;
import forge.util.Localizer;
import forge.util.MyRandom;
import forge.util.collect.FCollectionView;
import org.apache.commons.lang3.tuple.Pair;

import java.util.*;
import java.util.Map.Entry;

public class Match {

    private static List<PaperCard> removedCards = Lists.newArrayList();

    private final List<RegisteredPlayer> players;
    private final GameRules rules;
    private final String title;
    private final EventBus events = new EventBus("match events");
    private final Map<Integer, GameOutcome> gameOutcomes = Maps.newHashMap();
    private GameOutcome lastOutcome = null;

    // v-v-v-v- NEW FIELD TO STORE THE UUID v-v-v-v-
    private final String id;
    // ^-^-^-^-^-^-^-^-^-^-^-^-^-^-^-^-^-^-^-^-^-^-

    // Original constructor, now calls the new one for backward compatibility
    public Match(final GameRules rules0, final List<RegisteredPlayer> players0, final String title) {
        this(rules0, players0, title, null);
    }

    // v-v-v-v- NEW CONSTRUCTOR THAT ACCEPTS OUR EXTERNAL UUID v-v-v-v-
    public Match(final GameRules rules0, final List<RegisteredPlayer> players0, final String title, final String externalId) {
        this.players = Collections.unmodifiableList(Lists.newArrayList(players0));
        this.rules = rules0;
        this.title = title;

        // If an external ID (our UUID from the command line) is provided, use it.
        // Otherwise, generate a new random UUID as a fallback.
        if (externalId != null && !externalId.isEmpty()) {
            this.id = externalId;
        } else {
            this.id = UUID.randomUUID().toString();
        }
    }
    // ^-^-^-^-^-^-^-^-^-^-^-^-^-^-^-^-^-^-^-^-^-^-^-^-^-^-^-^-^-^-

    // v-v-v-v- NEW PUBLIC GETTER FOR THE ID v-v-v-v-
    public String getMatchId() {
        return this.id;
    }
    // ^-^-^-^-^-^-^-^-^-^-^-^-^-^-^-^-^-^-^-^-^-^-^-

    public GameRules getRules() {
        return rules;
    }

    String getTitle() {
        final Multiset<RegisteredPlayer> wins = getGamesWon();
        final StringBuilder titleAppend = new StringBuilder(title);
        titleAppend.append(" (");
        for (final RegisteredPlayer rp : players) {
            titleAppend.append(wins.count(rp)).append('-');
        }
        titleAppend.deleteCharAt(titleAppend.length() - 1);
        titleAppend.append(')');
        return titleAppend.toString();
    }

    public void addGamePlayed(Game finished) {
        if (!finished.isGameOver()) {
            throw new IllegalStateException("Game is not over yet.");
        }
        lastOutcome = finished.getOutcome();
        gameOutcomes.put(finished.getId(), finished.getOutcome());
    }

    public Game createGame() {
        return new Game(players, rules, this);
    }

    public void startGame(final Game game) {
        startGame(game, null);
    }

    public void startGame(final Game game, Runnable startGameHook) {
        prepareAllZones(game);
        if (rules.useAnte()) {
            Multimap<Player, Card> list = game.chooseCardsForAnte(rules.getMatchAnteRarity());
            for (Entry<Player, Card> kv : list.entries()) {
                Player p = kv.getKey();
                game.getAction().moveTo(ZoneType.Ante, kv.getValue(), null, AbilityKey.newMap());
                game.fireEvent(new GameEventAddLog(GameLogEntryType.ANTE, p + " anted " + kv.getValue()));
            }
            game.fireEvent(GameEventAnteCardsSelected.fromCards(list));
        }
        game.getAction().startGame(this.lastOutcome, startGameHook);
        executeOwnershipChanges(game);
        game.clearCaches();
        game.fireEvent(new GameEventGameFinished());
        System.gc();
    }

    public GameOutcome getOutcomeById(int id) {
        return gameOutcomes.get(id);
    }

    public void clearGamesPlayed() {
        gameOutcomes.clear();
        for (RegisteredPlayer p : players) {
            p.restoreDeck();
        }
    }

    public Collection<GameOutcome> getOutcomes() {
        return gameOutcomes.values();
    }

    public GameOutcome getLastOutcome() {
        return lastOutcome;
    }

    public boolean isMatchOver() {
        int[] victories = new int[players.size()];
        for (GameOutcome go : getOutcomes()) {
            LobbyPlayer winner = go.getWinningLobbyPlayer();
            int i = 0;
            for (RegisteredPlayer p : players) {
                if (p.getPlayer().equals(winner)) {
                    victories[i]++;
                    if (victories[i] >= rules.getGamesToWinMatch()) {
                        return true;
                    }
                }
                i++;
            }
        }
        return false;
    }

    public int getGamesWonBy(LobbyPlayer questPlayer) {
        int sum = 0;
        for (GameOutcome go : getOutcomes()) {
            if (questPlayer.equals(go.getWinningLobbyPlayer())) {
                sum++;
            }
        }
        return sum;
    }

    public Multiset<RegisteredPlayer> getGamesWon() {
        final Multiset<RegisteredPlayer> won = HashMultiset.create(players.size());
        for (final GameOutcome go : getOutcomes()) {
            if (go.getWinningPlayer() == null) {
                return won;
            }
            won.add(go.getWinningPlayer());
        }
        return won;
    }

    public boolean isWonBy(LobbyPlayer questPlayer) {
        return getGamesWonBy(questPlayer) >= rules.getGamesToWinMatch();
    }

    public RegisteredPlayer getWinner() {
        if (this.isMatchOver()) {
            return lastOutcome.getWinningPlayer();
        }
        return null;
    }

    public List<RegisteredPlayer> getPlayers() {
        return players;
    }

    private static Set<PaperCard> getRemovedAnteCards(Deck toUse) {
        final String keywordToRemove = "Remove CARDNAME from your deck before playing if you're not playing for ante.";
        Set<PaperCard> myRemovedAnteCards = new HashSet<>();
        for (Entry<DeckSection, CardPool> ds : toUse) {
            for (Entry<PaperCard, Integer> cp : ds.getValue()) {
                if (Iterables.contains(cp.getKey().getRules().getMainPart().getKeywords(), keywordToRemove)) {
                    myRemovedAnteCards.add(cp.getKey());
                }
            }
        }
        return myRemovedAnteCards;
    }

    public static List<PaperCard> getRemovedCards() { return removedCards; }

    public void removeCard(PaperCard c) {
        removedCards.add(c);
    }

    private static void preparePlayerZone(Player player, final ZoneType zoneType, CardPool section, boolean canRandomFoil) {
        PlayerZone library = player.getZone(zoneType);
        List<Card> newLibrary = new ArrayList<>();
        for (final Entry<PaperCard, Integer> stackOfCards : section) {
            final PaperCard cp = stackOfCards.getKey();
            for (int i = 0; i < stackOfCards.getValue(); i++) {
                final Card card = Card.fromPaperCard(cp, player);
                if (cp.isFoil() || (canRandomFoil && MyRandom.percentTrue(5))) {
                    card.setRandomFoil();
                }
                card.setCollectible(true);
                newLibrary.add(card);
            }
        }
        library.setCards(newLibrary);
    }

    private void prepareAllZones(final Game game) {
        Trigger.resetIDs();
        game.getTriggerHandler().clearDelayedTrigger();
        Map<Player, Map<DeckSection, List<? extends PaperCard>>> rAICards = new HashMap<>();
        Multimap<Player, PaperCard> removedAnteCards = ArrayListMultimap.create();
        Map<Player, List<PaperCard>> unsupported = new HashMap<>();
        final FCollectionView<Player> players = game.getPlayers();
        final List<RegisteredPlayer> playersConditions = game.getMatch().getPlayers();
        boolean isFirstGame = gameOutcomes.isEmpty();
        boolean canSideBoard = !isFirstGame && rules.getGameType().isSideboardingAllowed();
        boolean sideboardForAIs = rules.getSideboardForAI() &&
            rules.getGameType().getDeckFormat().equals(DeckFormat.Constructed);
        PlayerController sideboardProxy = null;
        if (canSideBoard && sideboardForAIs) {
            for (int i = 0; i < players.size(); i++) {
                final Player player = players.get(i);
                if (!player.getController().isAI()) {
                    sideboardProxy = player.getController();
                    break;
                }
            }
        }
        for (int i = 0; i < playersConditions.size(); i++) {
            final Player player = players.get(i);
            final RegisteredPlayer psc = playersConditions.get(i);
            PlayerController person = player.getController();
            if (canSideBoard) {
                if (sideboardProxy != null && person.isAI()) {
                    person = sideboardProxy;
                }
                Deck toChange = psc.getDeck();
                if (!getRemovedCards().isEmpty()) {
                    CardPool main = new CardPool();
                    main.addAll(toChange.get(DeckSection.Main));
                    CardPool sideboard = new CardPool();
                    sideboard.addAll(toChange.getOrCreate(DeckSection.Sideboard));
                    for (PaperCard c : removedCards) {
                        if (main.contains(c)) {
                            main.remove(c, 1);
                        } else if (sideboard.contains(c)) {
                            sideboard.remove(c, 1);
                        }
                    }
                    toChange.getMain().clear();
                    toChange.getMain().addAll(main);
                    toChange.get(DeckSection.Sideboard).clear();
                    toChange.get(DeckSection.Sideboard).addAll(sideboard);
                }
                List<PaperCard> newMain = person.sideboard(toChange, rules.getGameType(), player.getName());
                if (null != newMain) {
                    CardPool allCards = new CardPool();
                    allCards.addAll(toChange.get(DeckSection.Main));
                    allCards.addAll(toChange.getOrCreate(DeckSection.Sideboard));
                    for (PaperCard c : newMain) {
                        allCards.remove(c);
                    }
                    toChange.getMain().clear();
                    toChange.getMain().add(newMain);
                    toChange.get(DeckSection.Sideboard).clear();
                    toChange.get(DeckSection.Sideboard).addAll(allCards);
                }
            }
            Deck toCheck = psc.getDeck();
            if (toCheck == null) {
                try {
                    System.err.println(psc.getPlayer().getName() + " Deck is NULL...");
                    int val = rules.getGameType().getDeckFormat().getMainRange().getMinimum();
                    toCheck = new Deck("NULL");
                    if (val > 0)
                        toCheck.getMain().add("Wastes", val);
                } catch (Exception ignored) {}
            }
            Pair<Deck, List<PaperCard>> myDeck = toCheck.getValid();
            player.setDraftNotes(myDeck.getLeft().getDraftNotes());
            Set<PaperCard> myRemovedAnteCards = null;
            if (!rules.useAnte()) {
                myRemovedAnteCards = getRemovedAnteCards(myDeck.getLeft());
                for (PaperCard cp: myRemovedAnteCards) {
                    for (Entry<DeckSection, CardPool> ds : myDeck.getLeft()) {
                        ds.getValue().removeAll(cp);
                    }
                }
            }
            preparePlayerZone(player, ZoneType.Library, myDeck.getLeft().getMain(), psc.useRandomFoil());
            if (myDeck.getLeft().has(DeckSection.Sideboard)) {
                preparePlayerZone(player, ZoneType.Sideboard, myDeck.getLeft().get(DeckSection.Sideboard), psc.useRandomFoil());
                player.assignCompanion(game, person);
            }
            player.initVariantsZones(psc);
            player.shuffle(null);
            if (isFirstGame) {
                Map<DeckSection, List<? extends PaperCard>> cardsComplained = player.getController().complainCardsCantPlayWell(myDeck.getLeft());
                if (cardsComplained != null && !cardsComplained.isEmpty()) {
                    rAICards.put(player, cardsComplained);
                }
            } else {
                for (Card c : player.getCardsIn(ZoneType.Library)) {
                    c.setTapped(false);
                    c.resetActivationsPerTurn();
                }
            }
            if (myRemovedAnteCards != null && !myRemovedAnteCards.isEmpty()) {
                removedAnteCards.putAll(player, myRemovedAnteCards);
            }
            unsupported.put(player, myDeck.getRight());
        }
        final Localizer localizer = Localizer.getInstance();
        if (!rAICards.isEmpty() && !rules.getGameType().isCardPoolLimited() && rules.warnAboutAICards()) {
            game.getAction().revealUnplayableByAI(localizer.getMessage("lblAICantPlayCards"), rAICards);
        }
        if (!removedAnteCards.isEmpty()) {
            game.getAction().revealAnte(localizer.getMessage("lblAnteCardsRemoved"), removedAnteCards);
        }
        if (!unsupported.isEmpty()) {
            game.getAction().revealUnsupported(unsupported);
        }
    }

    private void executeOwnershipChanges(Game lastGame) {
        GameOutcome outcome = lastGame.getOutcome();
        List<PaperCard> losses = new ArrayList<>();
        int cntPlayers = players.size();
        int iWinner = -1;
        for (int i = 0; i < cntPlayers; i++) {
            Player gamePlayer = lastGame.getRegisteredPlayers().get(i);
            RegisteredPlayer registered = gamePlayer.getRegisteredPlayer();
            CardCollectionView lostOwnership = gamePlayer.getLostOwnership();
            CardCollectionView gainedOwnership = gamePlayer.getGainedOwnership();
            if (!lostOwnership.isEmpty()) {
                List<PaperCard> lostPaperOwnership = new ArrayList<>();
                for (Card c : lostOwnership) {
                    lostPaperOwnership.add((PaperCard)c.getPaperCard());
                }
                outcome.addAnteLost(registered, lostPaperOwnership);
            }
            if (!gainedOwnership.isEmpty()) {
                List<PaperCard> gainedPaperOwnership = new ArrayList<>();
                for (Card c : gainedOwnership) {
                    gainedPaperOwnership.add((PaperCard)c.getPaperCard());
                }
                outcome.addAnteWon(registered, gainedPaperOwnership);
            }
            if (!getRules().useAnte()) {
                continue;
            }
            if (outcome.isDraw()) {
                continue;
            }
            if (!gamePlayer.hasLost()) {
                iWinner = i;
                continue;
            }
            Deck losersDeck = players.get(i).getDeck();
            List<PaperCard> personalLosses = new ArrayList<>();
            for (Card c : gamePlayer.getCardsIn(ZoneType.Ante)) {
                if(!c.isCollectible())
                    continue;
                PaperCard toRemove = (PaperCard) c.getPaperCard();
                losersDeck.getMain().remove(toRemove);
                personalLosses.add(toRemove);
                losses.add(toRemove);
            }
            outcome.addAnteLost(registered, personalLosses);
        }
        if (rules.useAnte() && iWinner >= 0) {
            Player fromGame = lastGame.getRegisteredPlayers().get(iWinner);
            RegisteredPlayer registered = fromGame.getRegisteredPlayer();
            outcome.addAnteWon(registered, losses);
            if (rules.getGameType().canAddWonCardsMidGame()) {
                List<PaperCard> chosen = fromGame.getController().chooseCardsYouWonToAddToDeck(losses);
                if (null != chosen) {
                    Deck deck = players.get(iWinner).getDeck();
                    for (PaperCard c : chosen) {
                        deck.getMain().add(c);
                    }
                }
            }
        }
    }

    public GameOutcome.AnteResult getAnteResult(RegisteredPlayer player) {
        GameOutcome.AnteResult out = new GameOutcome.AnteResult();
        for (GameOutcome outcome : gameOutcomes.values()) {
            GameOutcome.AnteResult gameAnte = outcome.getAnteResult(player);
            if (gameAnte == null) {
                continue;
            }
            out.addWon(gameAnte.wonCards);
            out.addLost(gameAnte.lostCards);
        }
        return out;
    }

    public void fireEvent(final Event event) {
        events.post(event);
    }

    public void subscribeToEvents(final Object subscriber) {
        events.register(subscriber);
    }
}

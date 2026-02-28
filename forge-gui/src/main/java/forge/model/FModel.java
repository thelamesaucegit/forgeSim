package forge.model;

import com.google.common.base.Supplier;
import com.google.common.base.Suppliers;
import com.google.common.collect.Maps;

import forge.*;
import forge.CardStorageReader.ProgressObserver;
import forge.ai.AiProfileUtil;
import forge.card.CardRulesPredicates;
import forge.card.CardType;
import forge.deck.CardArchetypeLDAGenerator;
import forge.deck.CardRelationMatrixGenerator;
import forge.deck.io.DeckPreferences;
import forge.game.GameFormat;
import forge.game.GameType;
import forge.game.card.CardUtil;
import forge.game.spellability.Spell;
import forge.gamemodes.gauntlet.GauntletData;
import forge.gamemodes.limited.GauntletMini;
import forge.gamemodes.limited.ThemedChaosDraft;
import forge.gamemodes.planarconquest.ConquestController;
import forge.gamemodes.planarconquest.ConquestPlane;
import forge.gamemodes.planarconquest.ConquestPreferences;
import forge.gamemodes.planarconquest.ConquestUtil;
import forge.gamemodes.quest.QuestController;
import forge.gamemodes.quest.QuestWorld;
import forge.gamemodes.quest.data.QuestPreferences;
import forge.gamemodes.tournament.TournamentData;
import forge.gui.FThreads;
import forge.gui.GuiBase;
import forge.gui.card.CardPreferences;
import forge.gui.interfaces.IProgressBar;
import forge.item.PaperCard;
import forge.item.PaperCardPredicates;
import forge.itemmanager.ItemManagerConfig;
import forge.localinstance.achievements.*;
import forge.localinstance.properties.ForgeConstants;
import forge.localinstance.properties.ForgeNetPreferences;
import forge.localinstance.properties.ForgePreferences;
import forge.localinstance.properties.ForgePreferences.FPref;
import forge.player.GamePlayerUtil;
import forge.util.*;
import forge.util.storage.IStorage;
import forge.util.storage.StorageBase;

import java.io.File;
import java.util.List;
import java.util.Map;
import java.util.function.Function;

public final class FModel {
    private FModel() { } //don't allow creating instance

    private static CardStorageReader reader, tokenReader, customReader, customTokenReader;
    private static final Supplier<StaticData> magicDb = Suppliers.memoize(new Supplier<StaticData>() {
        @Override
        public StaticData get() {
            return new StaticData(reader, tokenReader, customReader, customTokenReader, ForgeConstants.EDITIONS_DIR,
                ForgeConstants.USER_CUSTOM_EDITIONS_DIR, ForgeConstants.BLOCK_DATA_DIR, ForgeConstants.SETLOOKUP_DIR,
                getPreferences().getPref(FPref.UI_PREFERRED_ART),
                getPreferences().getPrefBoolean(FPref.UI_LOAD_UNKNOWN_CARDS),
                getPreferences().getPrefBoolean(FPref.UI_LOAD_NONLEGAL_CARDS),
                getPreferences().getPrefBoolean(FPref.ALLOW_CUSTOM_CARDS_IN_DECKS_CONFORMANCE),
                getPreferences().getPrefBoolean(FPref.UI_SMART_CARD_ART));
        }
    });

    private static final Supplier<QuestPreferences> questPreferences = Suppliers.memoize(new Supplier<QuestPreferences>() {
        @Override
        public QuestPreferences get() {
            return new QuestPreferences();
        }
    });
    private static final Supplier<ConquestPreferences> conquestPreferences = Suppliers.memoize(new Supplier<ConquestPreferences>() {
       @Override
        public ConquestPreferences get() {
           final ConquestPreferences cp = new ConquestPreferences();
           ConquestUtil.updateRarityFilterOdds(cp);
           return cp;
       }
    });

    private static ForgePreferences preferences;
    private static final Supplier<ForgeNetPreferences> netPreferences = Suppliers.memoize(new Supplier<ForgeNetPreferences>() {
        @Override
        public ForgeNetPreferences get() {
            return new ForgeNetPreferences();
        }
    });
    private static final Supplier<Map<GameType, AchievementCollection>> achievements = Suppliers.memoize(new Supplier<Map<GameType, AchievementCollection>>() {
        @Override
        public Map<GameType, AchievementCollection> get() {
            final Map<GameType, AchievementCollection> a = Maps.newHashMap();
            a.put(GameType.Constructed, new ConstructedAchievements());
            a.put(GameType.Draft, new DraftAchievements());
            a.put(GameType.Sealed, new SealedAchievements());
            a.put(GameType.Quest, new QuestAchievements());
            a.put(GameType.PlanarConquest, new PlanarConquestAchievements());
            a.put(GameType.Puzzle, new PuzzleAchievements());
            a.put(GameType.Adventure, new AdventureAchievements());
            return a;
        }
    });

    private static TournamentData tournamentData;
    private static GauntletData gauntletData;
    private static final Supplier<GauntletMini> gauntletMini = Suppliers.memoize(new Supplier<GauntletMini>() {
        @Override
        public GauntletMini get() {
            return new GauntletMini();
        }
    });
    private static final Supplier<QuestController> quest = Suppliers.memoize(new Supplier<QuestController>() {
        @Override
        public QuestController get() {
            return new QuestController();
        }
    });
    private static final Supplier<ConquestController> conquest = Suppliers.memoize(new Supplier<ConquestController>() {
        @Override
        public ConquestController get() {
            return new ConquestController();
        }
    });
    private static final Supplier<CardCollections> decks = Suppliers.memoize(new Supplier<CardCollections>() {
        @Override
        public CardCollections get() {
            return new CardCollections();
        }
    });
    private static final Supplier<IStorage<CardBlock>> blocks = Suppliers.memoize(new Supplier<IStorage<CardBlock>>() {
        @Override
        public IStorage<CardBlock> get() {
            final IStorage<CardBlock> cb = new StorageBase<CardBlock>("Block definitions", new CardBlock.Reader(ForgeConstants.BLOCK_DATA_DIR + "blocks.txt", getMagicDb().getEditions()));
            for (final CardBlock b : cb) {
                try {
                    getMagicDb().getBlockLands().add(b.getLandSet().getCode());
                } catch (Exception e) {
                    e.printStackTrace();
                }
            }
            return cb;
        }
    });

    private static final Supplier<IStorage<CardBlock>> fantasyBlocks = Suppliers.memoize(new Supplier<IStorage<CardBlock>>() {
        @Override
        public IStorage<CardBlock> get() {
            return new StorageBase<CardBlock>("Custom blocks", new CardBlock.Reader(ForgeConstants.BLOCK_DATA_DIR + "fantasyblocks.txt", getMagicDb().getEditions()));
        }
    });
    private static final Supplier<IStorage<ThemedChaosDraft>> themedChaosDrafts = Suppliers.memoize(new Supplier<IStorage<ThemedChaosDraft>>() {
        @Override
        public IStorage<ThemedChaosDraft> get() {
            return new StorageBase<ThemedChaosDraft>("Themed Chaos Drafts", new ThemedChaosDraft.Reader(ForgeConstants.BLOCK_DATA_DIR + "chaosdraftthemes.txt"));
        }
    });
    private static final Supplier<IStorage<ConquestPlane>> planes = Suppliers.memoize(new Supplier<IStorage<ConquestPlane>>() {
        @Override
        public IStorage<ConquestPlane> get() {
            return new StorageBase<ConquestPlane>("Conquest planes", new ConquestPlane.Reader(ForgeConstants.CONQUEST_PLANES_DIR + "planes.txt"));
        }
    });
    private static final Supplier<IStorage<QuestWorld>> worlds = Suppliers.memoize(new Supplier<IStorage<QuestWorld>>() {
        @Override
        public IStorage<QuestWorld> get() {
            final Map<String, QuestWorld> standardWorlds = new QuestWorld.Reader(ForgeConstants.QUEST_WORLD_DIR + "worlds.txt").readAll();
            final Map<String, QuestWorld> customWorlds = new QuestWorld.Reader(ForgeConstants.USER_QUEST_WORLD_DIR + "customworlds.txt").readAll();
            for(QuestWorld world : customWorlds.values()) {
                world.setCustom(true);
            }
            standardWorlds.putAll(customWorlds);
            final IStorage<QuestWorld> w = new StorageBase<QuestWorld>("Quest worlds", null, standardWorlds);
            return w;
        }
    });

    private static final Supplier<GameFormat.Collection> formats = Suppliers.memoize(new Supplier<GameFormat.Collection>() {
        @Override
        public GameFormat.Collection get() {
            return new GameFormat.Collection(new GameFormat.Reader( new File(ForgeConstants.FORMATS_DATA_DIR), new File(ForgeConstants.USER_FORMATS_DIR), preferences.getPrefBoolean(FPref.LOAD_ARCHIVED_FORMATS)));
        }
    });
    private static final Supplier<ItemPool<PaperCard>> uniqueCardsNoAlt = Suppliers.memoize(new Supplier<ItemPool<PaperCard>>() {
        @Override
        public ItemPool<PaperCard> get() {
            return ItemPool.createFrom(getMagicDb().getCommonCards().getUniqueCardsNoAlt(), PaperCard.class);
        }
    });
    private static final Supplier<ItemPool<PaperCard>> allCardsNoAlt = Suppliers.memoize(new Supplier<ItemPool<PaperCard>>() {
        @Override
        public ItemPool<PaperCard> get() {
            return ItemPool.createFrom(getMagicDb().getCommonCards().getAllCardsNoAlt(), PaperCard.class);
        }
    });
    private static final Supplier<ItemPool<PaperCard>> planechaseCards = Suppliers.memoize(new Supplier<ItemPool<PaperCard>>() {
        @Override
        public ItemPool<PaperCard> get() {
            return ItemPool.createFrom(getMagicDb().getVariantCards().getAllCards(PaperCardPredicates.fromRules(CardRulesPredicates.IS_PLANE_OR_PHENOMENON)), PaperCard.class);
        }
    });
    private static final Supplier<ItemPool<PaperCard>> archenemyCards = Suppliers.memoize(new Supplier<ItemPool<PaperCard>>() {
        @Override
        public ItemPool<PaperCard> get() {
            return ItemPool.createFrom(getMagicDb().getVariantCards().getAllCards(PaperCardPredicates.fromRules(CardRulesPredicates.IS_SCHEME)), PaperCard.class);
        }
    });
    private static final Supplier<ItemPool<PaperCard>> brawlCommander = Suppliers.memoize(new Supplier<ItemPool<PaperCard>>() {
        @Override
        public ItemPool<PaperCard> get() {
            return ItemPool.createFrom(getMagicDb().getCommonCards().getAllCardsNoAlt(getFormats().get("Brawl").getFilterPrinted().and(PaperCardPredicates.fromRules(CardRulesPredicates.CAN_BE_BRAWL_COMMANDER))), PaperCard.class);
        }
    });
    private static final Supplier<ItemPool<PaperCard>> oathbreakerCommander = Suppliers.memoize(new Supplier<ItemPool<PaperCard>>() {
        @Override
        public ItemPool<PaperCard> get() {
            return ItemPool.createFrom(getMagicDb().getCommonCards().getAllCardsNoAlt(PaperCardPredicates.fromRules(CardRulesPredicates.CAN_BE_OATHBREAKER.or(CardRulesPredicates.CAN_BE_SIGNATURE_SPELL))), PaperCard.class);
        }
    });
    private static final Supplier<ItemPool<PaperCard>> tinyLeadersCommander = Suppliers.memoize(new Supplier<ItemPool<PaperCard>>() {
        @Override
        public ItemPool<PaperCard> get() {
            return ItemPool.createFrom(getMagicDb().getCommonCards().getAllCardsNoAlt(PaperCardPredicates.fromRules(CardRulesPredicates.CAN_BE_TINY_LEADERS_COMMANDER)), PaperCard.class);
        }
    });
    private static final Supplier<ItemPool<PaperCard>> commanderPool = Suppliers.memoize(new Supplier<ItemPool<PaperCard>>() {
        @Override
        public ItemPool<PaperCard> get() {
            return ItemPool.createFrom(getMagicDb().getCommonCards().getAllCardsNoAlt(PaperCardPredicates.CAN_BE_COMMANDER), PaperCard.class);
        }
    });
    private static final Supplier<ItemPool<PaperCard>> avatarPool = Suppliers.memoize(new Supplier<ItemPool<PaperCard>>() {
        @O

package forge.view;

import forge.GuiDesktop;
import forge.Singletons;
import forge.error.ExceptionHandler;
import forge.gui.GuiBase;
import forge.util.BuildInfo;
import io.sentry.Sentry;

/**
 * Handles the initialization and startup sequence for the full Forge GUI desktop application.
 * This class should never be referenced by any command-line or headless code paths
 * to prevent accidental loading of Swing/AWT classes.
 */
public final class GuiAppRunner {

    // Disallow instantiation
    private GuiAppRunner() { }

    /**
     * Starts the full GUI application.
     */
    public static void start() {
        // All GUI-specific initializations are now safely isolated in this method.
        Sentry.init(options -> {
            options.setEnableExternalConfiguration(true);
            options.setRelease(BuildInfo.getVersionString());
            options.setEnvironment(System.getProperty("os.name"));
            options.setTag("Java Version", System.getProperty("java.version"));
            options.setShutdownTimeoutMillis(5000);
            if (options.getDsn() == null || options.getDsn().isEmpty())
                options.setDsn("https://87bc8d329e49441895502737c069067b@sentry.cardforge.org//3");
        }, true);

        GuiBase.setInterface(new GuiDesktop());
        ExceptionHandler.registerErrorHandling();
        Singletons.initializeOnce(true);
        Singletons.getControl().initialize();
    }
}

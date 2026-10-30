package com.albaik.pos;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;

import java.io.File;

/** What this device is: the main tablet running the servers, or a Screen showing the main device's pages. */
final class AppMode {
    enum Mode { UNSET, MAIN, SCREEN }

    /** What a Screen shows, and the page and default port on the main device for it. */
    enum Role {
        WAITER("/server-standalone/", 3003),
        KITCHEN("/kds-standalone/", 3002),
        POS("/", 3001);

        final String path;
        final int defaultPort;

        Role(String path, int defaultPort) {
            this.path = path;
            this.defaultPort = defaultPort;
        }
    }

    private static final String PREFS = "albaik-pos-mode";

    private AppMode() {}

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static Mode mode(Context context) {
        String stored = prefs(context).getString("mode", null);
        if (stored != null) return Mode.valueOf(stored);
        // Installs from before the setup screen existed already hold a main-tablet database.
        if (new File(NodeRuntime.userDataDir(context), "flo.db").exists()) {
            setMain(context);
            return Mode.MAIN;
        }
        return Mode.UNSET;
    }

    static void setMain(Context context) {
        prefs(context).edit().putString("mode", Mode.MAIN.name()).apply();
    }

    static void setScreen(Context context, Role role, String host, int port, String serviceName) {
        prefs(context).edit()
            .putString("mode", Mode.SCREEN.name())
            .putString("role", role.name())
            .putString("host", host)
            .putInt("port", port)
            .putString("serviceName", serviceName)
            // Written synchronously: becomeScreen ends the process right after.
            .commit();
    }

    /**
     * Switches this device to a Screen. Node cannot be stopped and restarted inside one process, so
     * the app restarts into the Screen in a fresh process that never starts the servers.
     */
    static void becomeScreen(Activity activity, Role role, String host, int port, String serviceName) {
        setScreen(activity, role, host, port, serviceName);
        activity.stopService(new Intent(activity, NodeService.class));
        activity.startActivity(new Intent(activity, ScreenActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK));
        android.os.Process.killProcess(android.os.Process.myPid());
    }

    static void updateScreenHost(Context context, String host, int port) {
        prefs(context).edit().putString("host", host).putInt("port", port).apply();
    }

    static Role role(Context context) {
        return Role.valueOf(prefs(context).getString("role", Role.POS.name()));
    }

    static String host(Context context) {
        return prefs(context).getString("host", "");
    }

    static int port(Context context) {
        return prefs(context).getInt("port", role(context).defaultPort);
    }

    static String serviceName(Context context) {
        return prefs(context).getString("serviceName", "");
    }
}

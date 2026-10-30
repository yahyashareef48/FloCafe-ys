package com.albaik.pos;

import android.content.Context;
import android.content.pm.PackageInfo;
import android.os.Build;
import android.os.Environment;
import android.util.Base64;
import android.util.Log;

import java.io.BufferedInputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.TimeZone;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/** Unpacks the bundled backend and runs it on nodejs-mobile; Node can start once per process. */
final class NodeRuntime {
    private static final String TAG = "AlBaikNode";
    private static final long NODE_STACK_BYTES = 16L * 1024 * 1024;
    private static boolean started;

    static {
        System.loadLibrary("node");
        System.loadLibrary("nodebridge");
    }

    private NodeRuntime() {}

    private static native int startNode(String[] args, String[] env);

    static synchronized void startOnce(Context context, ShellBridge bridge) {
        if (started) return;
        started = true;
        Context app = context.getApplicationContext();
        new Thread(null, () -> run(app, bridge), "node", NODE_STACK_BYTES).start();
    }

    private static void run(Context context, ShellBridge bridge) {
        String[] env;
        File entry;
        try {
            File project = extractProject(context);
            installSqliteBinary(context, project);
            entry = new File(project, "dist/main/android/entry.js");
            env = environment(context, bridge);
        } catch (Throwable t) {
            Log.e(TAG, "Could not prepare the POS server", t);
            bridge.onNodeStartFailed("Could not prepare the POS server: " + t.getMessage());
            return;
        }
        int code = startNode(new String[] {"node", entry.getAbsolutePath()}, env);
        Log.e(TAG, "Node exited with code " + code);
        bridge.onNodeExited(code);
    }

    static File userDataDir(Context context) {
        return new File(context.getNoBackupFilesDir(), "flo-data");
    }

    /**
     * Shared Documents/AlBaikPOS, so daily backups survive an uninstall and show in the
     * Files app; falls back to the app's own documents folder where that is not writable.
     */
    static File documentsDir(Context context) {
        File shared = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOCUMENTS), "AlBaikPOS");
        if (isWritable(shared)) return shared;
        File appScoped = context.getExternalFilesDir(Environment.DIRECTORY_DOCUMENTS);
        if (appScoped != null && isWritable(appScoped)) return appScoped;
        return new File(context.getFilesDir(), "Documents");
    }

    private static boolean isWritable(File dir) {
        try {
            if (!dir.isDirectory() && !dir.mkdirs()) return false;
            File probe = new File(dir, ".write-probe");
            try (OutputStream out = new FileOutputStream(probe)) {
                out.write(1);
            }
            return probe.delete();
        } catch (IOException | SecurityException e) {
            return false;
        }
    }

    private static String[] environment(Context context, ShellBridge bridge) throws Exception {
        PackageInfo info = context.getPackageManager().getPackageInfo(context.getPackageName(), 0);
        File tmp = new File(context.getCacheDir(), "node-tmp");
        File compileCache = new File(context.getCacheDir(), "node-compile-cache");
        //noinspection ResultOfMethodCallIgnored
        tmp.mkdirs();
        Locale locale = Locale.getDefault();
        File documents = documentsDir(context);
        Log.i(TAG, "Documents folder: " + documents);
        List<String> env = new ArrayList<>();
        add(env, "HOME", context.getFilesDir().getAbsolutePath());
        add(env, "TMPDIR", tmp.getAbsolutePath());
        add(env, "TZ", TimeZone.getDefault().getID());
        add(env, "NODE_OPTIONS", "--max-old-space-size-percentage=25");
        add(env, "NODE_COMPILE_CACHE", compileCache.getAbsolutePath());
        add(env, "NODE_COMPILE_CACHE_PORTABLE", "1");
        add(env, "FLO_ANDROID_USER_DATA", userDataDir(context).getAbsolutePath());
        add(env, "FLO_ANDROID_DOCUMENTS", documents.getAbsolutePath());
        add(env, "FLO_ANDROID_VERSION", info.versionName);
        add(env, "FLO_ANDROID_LOCALE", locale.toLanguageTag());
        add(env, "FLO_ANDROID_COUNTRY", locale.getCountry());
        add(env, "FLO_ANDROID_SECRET_KEY", Base64.encodeToString(SecretKeyStore.loadOrCreate(context), Base64.NO_WRAP));
        add(env, "FLO_ANDROID_BRIDGE_SOCKET", bridge.socketName());
        add(env, "FLO_ANDROID_BRIDGE_TOKEN", bridge.token());
        return env.toArray(new String[0]);
    }

    private static void add(List<String> env, String key, String value) {
        env.add(key);
        env.add(value == null ? "" : value);
    }

    private static String abi() {
        String arch = System.getProperty("os.arch", "");
        if (arch.contains("aarch64") || arch.contains("arm64")) return "arm64-v8a";
        if (arch.contains("x86_64") || arch.contains("amd64")) return "x86_64";
        return Build.SUPPORTED_ABIS[0];
    }

    private static void installSqliteBinary(Context context, File project) throws IOException {
        File target = new File(project, "node_modules/better-sqlite3/build/Release/better_sqlite3.node");
        if (target.isFile()) return;
        try (InputStream in = context.getAssets().open("node-native/" + abi() + "/better_sqlite3.node")) {
            IoUtil.writeFileAtomically(target, IoUtil.readFully(in));
        }
    }

    /** Re-extracts only when the installed APK changes. */
    private static File extractProject(Context context) throws Exception {
        File target = new File(context.getFilesDir(), "nodejs-project");
        File stamp = new File(target, ".apk-stamp");
        PackageInfo info = context.getPackageManager().getPackageInfo(context.getPackageName(), 0);
        String expected = info.versionName + "/" + info.lastUpdateTime;
        if (stamp.isFile() && expected.equals(new String(IoUtil.readFile(stamp), StandardCharsets.UTF_8))) return target;

        IoUtil.deleteRecursively(target);
        if (!target.mkdirs()) throw new IOException("Cannot create " + target);
        long startedAt = System.currentTimeMillis();
        String root = target.getCanonicalPath() + File.separator;
        byte[] buffer = new byte[64 * 1024];
        try (ZipInputStream zip = new ZipInputStream(new BufferedInputStream(context.getAssets().open("nodejs-project.zip"), 256 * 1024))) {
            ZipEntry entry;
            while ((entry = zip.getNextEntry()) != null) {
                File out = new File(target, entry.getName());
                if (!out.getCanonicalPath().startsWith(root)) throw new IOException("Unexpected zip entry " + entry.getName());
                if (entry.isDirectory()) {
                    //noinspection ResultOfMethodCallIgnored
                    out.mkdirs();
                    continue;
                }
                File parent = out.getParentFile();
                if (parent != null && !parent.isDirectory() && !parent.mkdirs()) throw new IOException("Cannot create " + parent);
                try (OutputStream os = new FileOutputStream(out)) {
                    int read;
                    while ((read = zip.read(buffer)) > 0) os.write(buffer, 0, read);
                }
            }
        }
        IoUtil.writeFileAtomically(stamp, expected.getBytes(StandardCharsets.UTF_8));
        Log.i(TAG, "Unpacked the POS server in " + (System.currentTimeMillis() - startedAt) + " ms");
        return target;
    }
}

package com.albaik.pos.spike;

import android.content.Context;
import android.content.pm.PackageInfo;
import android.util.Log;

import java.io.BufferedInputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

final class NodeRuntime {
    private static final String TAG = "AlBaikNode";
    private static boolean started;

    static {
        System.loadLibrary("node");
        System.loadLibrary("nodebridge");
    }

    private NodeRuntime() {}

    static native int startNode(String[] args, String[] env);

    static synchronized void startOnce(Context context) {
        if (started) return;
        started = true;
        Context app = context.getApplicationContext();
        Thread thread = new Thread(null, () -> run(app), "node", 16L * 1024 * 1024);
        thread.start();
    }

    private static void run(Context context) {
        try {
            File project = extractProject(context);
            File data = new File(context.getNoBackupFilesDir(), "flo-data");
            File cache = new File(context.getCacheDir(), "node-tmp");
            data.mkdirs();
            cache.mkdirs();
            String[] env = {
                "TMPDIR", cache.getAbsolutePath(),
                "HOME", context.getFilesDir().getAbsolutePath(),
                "FLO_DEV_USER_DATA", data.getAbsolutePath(),
                "NODE_OPTIONS", "--max-old-space-size-percentage=25",
            };
            String entry = new File(project, "dev-server.js").getAbsolutePath();
            int code = startNode(new String[] {"node", entry}, env);
            Log.e(TAG, "Node exited with code " + code);
        } catch (Throwable t) {
            Log.e(TAG, "Node failed to start", t);
        }
    }

    private static File extractProject(Context context) throws Exception {
        File target = new File(context.getFilesDir(), "nodejs-project");
        File stamp = new File(target, ".apk-stamp");
        PackageInfo info = context.getPackageManager().getPackageInfo(context.getPackageName(), 0);
        String expected = String.valueOf(info.lastUpdateTime);
        if (stamp.exists() && expected.equals(readAll(stamp))) return target;

        deleteRecursive(target);
        target.mkdirs();
        long t0 = System.currentTimeMillis();
        try (ZipInputStream zip = new ZipInputStream(new BufferedInputStream(context.getAssets().open("nodejs-project.zip")))) {
            ZipEntry e;
            byte[] buf = new byte[64 * 1024];
            String root = target.getCanonicalPath() + File.separator;
            while ((e = zip.getNextEntry()) != null) {
                File out = new File(target, e.getName());
                if (!out.getCanonicalPath().startsWith(root)) throw new IOException("Bad zip entry " + e.getName());
                if (e.isDirectory()) { out.mkdirs(); continue; }
                out.getParentFile().mkdirs();
                try (OutputStream os = new FileOutputStream(out)) {
                    int n;
                    while ((n = zip.read(buf)) > 0) os.write(buf, 0, n);
                }
            }
        }
        try (OutputStream os = new FileOutputStream(stamp)) { os.write(expected.getBytes()); }
        Log.i(TAG, "Extracted node project in " + (System.currentTimeMillis() - t0) + " ms");
        return target;
    }

    private static String readAll(File f) throws IOException {
        try (InputStream in = new java.io.FileInputStream(f)) {
            return new String(in.readAllBytes());
        }
    }

    private static void deleteRecursive(File f) {
        File[] children = f.listFiles();
        if (children != null) for (File c : children) deleteRecursive(c);
        f.delete();
    }
}

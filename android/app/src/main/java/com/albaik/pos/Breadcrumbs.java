package com.albaik.pos;

import android.content.Context;
import android.util.Log;

import java.io.File;
import java.io.FileOutputStream;
import java.io.RandomAccessFile;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * Printing steps written straight to logs/native.log, so a native crash that leaves no stack
 * still shows, in the next exit report, the last step that ran.
 */
final class Breadcrumbs {
    private static final String TAG = "AlBaikSteps";
    private static final long MAX_BYTES = 256 * 1024;

    private Breadcrumbs() {}

    static File file(Context context) {
        return new File(new File(NodeRuntime.userDataDir(context), "logs"), "native.log");
    }

    static synchronized void note(Context context, String step) {
        String line = new SimpleDateFormat("yyyy-MM-dd HH:mm:ss.SSS", Locale.ROOT).format(new Date())
            + " [" + Thread.currentThread().getName() + "] " + step + "\n";
        Log.i(TAG, step);
        try {
            File file = file(context);
            //noinspection ResultOfMethodCallIgnored
            file.getParentFile().mkdirs();
            boolean append = file.length() < MAX_BYTES;
            try (FileOutputStream out = new FileOutputStream(file, append)) {
                out.write(line.getBytes(StandardCharsets.UTF_8));
                // Flushed to disk now: the process may die on the next instruction.
                out.getFD().sync();
            }
        } catch (Exception e) {
            Log.w(TAG, "Could not record a step", e);
        }
    }

    static String tail(File file, int maxBytes) {
        if (!file.isFile()) return "(none)\n";
        try (RandomAccessFile in = new RandomAccessFile(file, "r")) {
            long start = Math.max(0, in.length() - maxBytes);
            byte[] bytes = new byte[(int) (in.length() - start)];
            in.seek(start);
            in.readFully(bytes);
            return new String(bytes, StandardCharsets.UTF_8);
        } catch (Exception e) {
            return "(could not read " + file.getName() + ": " + e + ")\n";
        }
    }
}

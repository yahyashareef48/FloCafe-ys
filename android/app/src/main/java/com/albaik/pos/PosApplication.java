package com.albaik.pos;

import android.app.ActivityManager;
import android.app.Application;
import android.app.ApplicationExitInfo;
import android.content.SharedPreferences;
import android.os.Build;
import android.util.Log;

import java.io.File;
import java.io.FileOutputStream;
import java.io.PrintWriter;
import java.io.RandomAccessFile;
import java.io.StringWriter;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.List;
import java.util.Locale;

/**
 * Writes the stack of any crash to Documents/AlBaikPOS/logs, where the operator can find it in
 * the Files app and send it, before Android ends the app as it normally would. On the next start
 * it also records why Android ended the previous run, which covers native and renderer crashes.
 */
public class PosApplication extends Application {
    private static final String TAG = "AlBaikCrash";

    @Override
    public void onCreate() {
        super.onCreate();
        Thread.UncaughtExceptionHandler previous = Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler((thread, error) -> {
            try {
                saveCrash(thread, error);
            } catch (Throwable ignored) {
                // Never let the crash log hide the crash.
            }
            if (previous != null) previous.uncaughtException(thread, error);
        });
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            new Thread(this::saveExitReasons, "albaik-exit-reasons").start();
        }
    }

    private void saveExitReasons() {
        try {
            SharedPreferences prefs = getSharedPreferences("albaik-crash-log", MODE_PRIVATE);
            long seen = prefs.getLong("lastExit", 0);
            long newest = seen;
            StringBuilder report = new StringBuilder();
            List<ApplicationExitInfo> exits = getSystemService(ActivityManager.class).getHistoricalProcessExitReasons(getPackageName(), 0, 10);
            for (ApplicationExitInfo exit : exits) {
                if (exit.getTimestamp() <= seen) continue;
                newest = Math.max(newest, exit.getTimestamp());
                if (!isAbnormal(exit.getReason())) continue;
                report.append(new SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.ROOT).format(new Date(exit.getTimestamp())))
                    .append("  ").append(exit).append('\n');
            }
            prefs.edit().putLong("lastExit", newest).apply();
            if (report.length() == 0) return;
            String stamp = new SimpleDateFormat("yyyy-MM-dd'T'HH-mm-ss", Locale.ROOT).format(new Date());
            String text = "Al Baik POS: how Android ended earlier runs\n" + device() + "\n\n" + report
                + "\n--- End of the POS server log before this start ---\n" + serverLogTail();
            Log.w(TAG, text);
            save("exit-" + stamp + ".txt", text);
        } catch (Exception e) {
            Log.w(TAG, "Could not read why the app last stopped", e);
        }
    }

    private static boolean isAbnormal(int reason) {
        return reason == ApplicationExitInfo.REASON_CRASH
            || reason == ApplicationExitInfo.REASON_CRASH_NATIVE
            || reason == ApplicationExitInfo.REASON_ANR
            || reason == ApplicationExitInfo.REASON_LOW_MEMORY
            || reason == ApplicationExitInfo.REASON_SIGNALED
            || reason == ApplicationExitInfo.REASON_INITIALIZATION_FAILURE
            || reason == ApplicationExitInfo.REASON_EXCESSIVE_RESOURCE_USAGE
            || reason == ApplicationExitInfo.REASON_UNKNOWN;
    }

    private String serverLogTail() {
        File log = new File(new File(NodeRuntime.userDataDir(this), "logs"), "main.log");
        if (!log.isFile()) return "(no server log)\n";
        try (RandomAccessFile file = new RandomAccessFile(log, "r")) {
            long start = Math.max(0, file.length() - 64 * 1024);
            byte[] tail = new byte[(int) (file.length() - start)];
            file.seek(start);
            file.readFully(tail);
            return new String(tail, StandardCharsets.UTF_8);
        } catch (Exception e) {
            return "(could not read the server log: " + e + ")\n";
        }
    }

    private static String device() {
        return "Android " + Build.VERSION.RELEASE + " (API " + Build.VERSION.SDK_INT + "), " + Build.MANUFACTURER + " " + Build.MODEL;
    }

    private void saveCrash(Thread thread, Throwable error) {
        StringWriter trace = new StringWriter();
        error.printStackTrace(new PrintWriter(trace));
        String stamp = new SimpleDateFormat("yyyy-MM-dd'T'HH-mm-ss", Locale.ROOT).format(new Date());
        String report = "Al Baik POS crash " + stamp + "\n" + device() + "\n"
            + "Thread: " + thread.getName() + "\n\n" + trace;
        Log.e(TAG, report);
        save("crash-" + stamp + ".txt", report);
    }

    private void save(String name, String text) {
        for (File dir : new File[] {
            new File(NodeRuntime.documentsDir(this), "logs"),
            new File(NodeRuntime.userDataDir(this), "logs"),
        }) {
            //noinspection ResultOfMethodCallIgnored
            dir.mkdirs();
            try (FileOutputStream out = new FileOutputStream(new File(dir, name))) {
                out.write(text.getBytes(StandardCharsets.UTF_8));
            } catch (Exception e) {
                Log.w(TAG, "Could not save the crash report in " + dir, e);
            }
        }
    }
}

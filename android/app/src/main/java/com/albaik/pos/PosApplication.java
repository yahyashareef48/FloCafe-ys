package com.albaik.pos;

import android.app.Application;
import android.os.Build;
import android.util.Log;

import java.io.File;
import java.io.FileOutputStream;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * Writes the stack of any crash to Documents/AlBaikPOS/logs, where the operator can find it in
 * the Files app and send it, before Android ends the app as it normally would.
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
    }

    private void saveCrash(Thread thread, Throwable error) throws Exception {
        StringWriter trace = new StringWriter();
        error.printStackTrace(new PrintWriter(trace));
        String stamp = new SimpleDateFormat("yyyy-MM-dd'T'HH-mm-ss", Locale.ROOT).format(new Date());
        String report = "Al Baik POS crash " + stamp + "\n"
            + "Android " + Build.VERSION.RELEASE + " (API " + Build.VERSION.SDK_INT + "), "
            + Build.MANUFACTURER + " " + Build.MODEL + "\n"
            + "Thread: " + thread.getName() + "\n\n" + trace;
        Log.e(TAG, report);
        for (File dir : new File[] {
            new File(NodeRuntime.documentsDir(this), "logs"),
            new File(NodeRuntime.userDataDir(this), "logs"),
        }) {
            //noinspection ResultOfMethodCallIgnored
            dir.mkdirs();
            try (FileOutputStream out = new FileOutputStream(new File(dir, "crash-" + stamp + ".txt"))) {
                out.write(report.getBytes(StandardCharsets.UTF_8));
            } catch (Exception e) {
                Log.w(TAG, "Could not save the crash report in " + dir, e);
            }
        }
    }
}

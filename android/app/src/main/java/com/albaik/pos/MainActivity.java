package com.albaik.pos;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.ComponentName;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.PowerManager;
import android.provider.OpenableColumns;
import android.provider.Settings;

import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/** The main tablet: starts the on-device servers and shows the POS with the electronAPI shim. */
public class MainActivity extends WebShellActivity implements ShellBridge.Listener, ShellBridge.RequestHandler {
    private static final String PREFS = "albaik-pos";
    private static final String PREF_BATTERY_ASKED = "battery-optimisation-asked";

    private JSONObject runtimeInfo;
    private boolean webLoaded;
    /** Read by {@link NodeService} to decide whether a stopped runtime needs a silent restart. */
    static volatile boolean inForeground;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // Lets automated tests skip the first-launch setup; release builds ignore it.
        if (BuildConfig.DEBUG && getIntent().getBooleanExtra("albaik.debug.mainMode", false)) AppMode.setMain(this);
        if (AppMode.mode(this) != AppMode.Mode.MAIN) {
            // A USB printer plugged into a Screen device opens this activity; route it to its own screen.
            startActivity(new Intent(this, LauncherActivity.class));
            finish();
            return;
        }
        showSplash(getString(R.string.starting), true, null, null);
        requestRuntimePermissions();
        NodeService.start(this);
        ShellBridge.get().setRequestHandler(this);
        ShellBridge.get().addListener(this);
        askForBatteryExemptionOnce();
    }

    @Override
    protected void onResume() {
        super.onResume();
        inForeground = true;
    }

    @Override
    protected void onPause() {
        inForeground = false;
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        ShellBridge.get().removeListener(this);
        ShellBridge.get().clearRequestHandler(this);
        super.onDestroy();
    }

    /** Notifications for the server status, and nearby devices for Bluetooth printers. */
    private void requestRuntimePermissions() {
        List<String> missing = new ArrayList<>();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
            && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            missing.add(Manifest.permission.POST_NOTIFICATIONS);
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
            && checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) != PackageManager.PERMISSION_GRANTED) {
            missing.add(Manifest.permission.BLUETOOTH_CONNECT);
        }
        if (!missing.isEmpty()) requestPermissions(missing.toArray(new String[0]), 1);
    }

    // ---- Runtime state ------------------------------------------------------------

    @Override
    public void onRuntimeStateChanged(ShellBridge.State state, JSONObject info, String error) {
        switch (state) {
            case READY:
                runtimeInfo = info;
                if (webLoaded) return;
                if (!webViewSupported()) {
                    showSplash(getString(R.string.webview_too_old), false, null, null);
                    return;
                }
                webLoaded = true;
                loadPage(posOrigin() + "/");
                hideSplash();
                break;
            case FAILED:
            case EXITED:
                showSplash(getString(R.string.start_failed) + "\n\n" + (error == null ? "" : error), false,
                    getString(R.string.restart), this::restartApp);
                break;
            default:
                break;
        }
    }

    private void restartApp() {
        Intent relaunch = Intent.makeRestartActivityTask(new ComponentName(this, MainActivity.class));
        startActivity(relaunch);
        android.os.Process.killProcess(android.os.Process.myPid());
    }

    private int port(String key, int fallback) {
        return runtimeInfo == null ? fallback : runtimeInfo.optInt(key, fallback);
    }

    private String posOrigin() {
        return "http://127.0.0.1:" + port("serverPort", 3001);
    }

    // ---- WebShellActivity ---------------------------------------------------------

    @Override
    protected Set<String> trustedOrigins() {
        return new HashSet<>(Arrays.asList(posOrigin(), "http://localhost:" + port("serverPort", 3001)));
    }

    @Override
    protected List<String> injectedScripts() {
        return Arrays.asList("webview-shim.js", "electron-api-shim.js");
    }

    @Override
    protected boolean isOwnServer(Uri uri) {
        String host = uri.getHost();
        if (!"http".equals(uri.getScheme()) || host == null) return false;
        if (!host.equals("127.0.0.1") && !host.equals("localhost")) return false;
        int port = uri.getPort();
        return port == port("serverPort", 3001) || port == port("kdsPort", 3002) || port == port("serverAppPort", 3003);
    }

    @Override
    protected String printBaseUrl() {
        return posOrigin() + "/";
    }

    @Override
    protected void handleWebRequest(String method, JSONObject params, ShellBridge.Reply reply) {
        switch (method) {
            // Database and settings actions run in the backend.
            case "hostAction":
                ShellBridge.get().callNode("hostAction", params, reply);
                break;
            case "saveFileCopy":
                saveFileCopy(params, reply);
                break;
            default:
                super.handleWebRequest(method, params, reply);
        }
    }

    // ---- Requests from Node --------------------------------------------------------

    @Override
    public void handle(String method, JSONObject params, ShellBridge.Reply reply) {
        switch (method) {
            case "openExternal":
                openExternal(params.optString("url"));
                reply.success(null);
                break;
            case "pickFile":
                pickFile(reply);
                break;
            case "confirm":
                confirm(params, reply);
                break;
            default:
                reply.error("Unknown request " + method);
        }
    }

    private void saveFileCopy(JSONObject params, ShellBridge.Reply reply) {
        File source = new File(params.optString("path"));
        File allowedRoot = NodeRuntime.documentsDir(this);
        try {
            if (!source.getCanonicalPath().startsWith(allowedRoot.getCanonicalPath() + File.separator)) {
                reply.error("Only files in the Al Baik POS documents folder can be copied");
                return;
            }
        } catch (IOException e) {
            reply.error(e.getMessage());
            return;
        }
        launch(createDocumentIntent(params.optString("suggestedName", source.getName()), params.optString("mimeType")), result -> {
            Uri target = result.getData() == null ? null : result.getData().getData();
            if (result.getResultCode() != RESULT_OK || target == null) {
                reply.success(Json.of("saved", false));
                return;
            }
            try (InputStream in = new FileInputStream(source); OutputStream out = getContentResolver().openOutputStream(target, "wt")) {
                if (out == null) throw new IOException("Cannot write the file");
                IoUtil.copy(in, out);
                reply.success(Json.of("saved", true));
            } catch (IOException e) {
                reply.error("Could not save the copy: " + e.getMessage());
            }
        });
    }

    /** Lets the operator pick a backup anywhere (Downloads, USB stick, Drive) and copies it where Node can read it. */
    private void pickFile(ShellBridge.Reply reply) {
        if (!resumed) {
            reply.error(getString(R.string.open_app_first));
            return;
        }
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*");
        launch(intent, result -> {
            Uri source = result.getData() == null ? null : result.getData().getData();
            if (result.getResultCode() != RESULT_OK || source == null) {
                reply.success(JSONObject.NULL);
                return;
            }
            File imports = new File(getCacheDir(), "imports");
            IoUtil.deleteRecursively(imports);
            File target = new File(imports, IoUtil.safeFileName(displayName(source), "restore.db"));
            try (InputStream in = getContentResolver().openInputStream(source)) {
                if (in == null) throw new IOException("Cannot read the file");
                if (!imports.mkdirs()) throw new IOException("Cannot create " + imports);
                try (OutputStream out = new java.io.FileOutputStream(target)) {
                    IoUtil.copy(in, out);
                }
                reply.success(Json.of("path", target.getAbsolutePath()));
            } catch (IOException e) {
                reply.error("Could not read the file: " + e.getMessage());
            }
        });
    }

    private String displayName(Uri uri) {
        try (Cursor cursor = getContentResolver().query(uri, new String[] {OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) return cursor.getString(0);
        } catch (RuntimeException ignored) {
            // Fall back to the default name.
        }
        return "restore.db";
    }

    private void confirm(JSONObject params, ShellBridge.Reply reply) {
        if (!resumed) {
            reply.error(getString(R.string.open_app_first));
            return;
        }
        String detail = params.optString("detail");
        new AlertDialog.Builder(this)
            .setTitle(params.optString("title"))
            .setMessage(params.optString("message") + (detail.isEmpty() ? "" : "\n\n" + detail))
            .setPositiveButton(params.optString("confirmLabel", "OK"), (d, w) -> reply.success(Json.of("confirmed", true)))
            .setNegativeButton(params.optString("cancelLabel", "Cancel"), (d, w) -> reply.success(Json.of("confirmed", false)))
            .setOnCancelListener(d -> reply.success(Json.of("confirmed", false)))
            .show();
    }

    // ---- Battery optimisation --------------------------------------------------------

    @SuppressLint("BatteryLife")
    private void askForBatteryExemptionOnce() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return;
        SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        PowerManager power = getSystemService(PowerManager.class);
        if (prefs.getBoolean(PREF_BATTERY_ASKED, false) || power.isIgnoringBatteryOptimizations(getPackageName())) return;
        prefs.edit().putBoolean(PREF_BATTERY_ASKED, true).apply();
        new AlertDialog.Builder(this)
            .setTitle(R.string.battery_title)
            .setMessage(R.string.battery_message)
            .setPositiveButton(R.string.allow, (d, w) -> {
                try {
                    startActivity(new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + getPackageName())));
                } catch (ActivityNotFoundException e) {
                    startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));
                }
            })
            .setNegativeButton(R.string.not_now, null)
            .show();
    }

}

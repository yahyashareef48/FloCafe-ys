package com.albaik.pos;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.ComponentName;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.PowerManager;
import android.provider.OpenableColumns;
import android.provider.Settings;
import android.database.Cursor;
import android.util.Base64;
import android.util.Log;
import android.view.View;
import android.view.WindowManager;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.TextView;

import androidx.activity.ComponentActivity;
import androidx.activity.OnBackPressedCallback;
import androidx.activity.result.ActivityResult;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebMessageCompat;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.Set;
import java.util.function.Consumer;

/** Full-screen POS: a WebView on the local server plus the native services the renderer needs. */
public class MainActivity extends ComponentActivity implements ShellBridge.Listener, ShellBridge.RequestHandler {
    private static final String TAG = "AlBaikActivity";
    private static final String PREFS = "albaik-pos";
    private static final String PREF_BATTERY_ASKED = "battery-optimisation-asked";

    private WebView webView;
    private View splash;
    private TextView status;
    private Button restart;
    private JSONObject runtimeInfo;
    private boolean webLoaded;
    private boolean resumed;
    /** Read by {@link NodeService} to decide whether a stopped runtime needs a silent restart. */
    static volatile boolean inForeground;

    private Consumer<ActivityResult> pendingResult;
    private ValueCallback<Uri[]> pendingFileChooser;
    private final ActivityResultLauncher<Intent> activityLauncher =
        registerForActivityResult(new ActivityResultContracts.StartActivityForResult(), result -> {
            Consumer<ActivityResult> callback = pendingResult;
            pendingResult = null;
            if (callback != null) callback.accept(result);
        });

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        splash = findViewById(R.id.splash);
        status = findViewById(R.id.status);
        restart = findViewById(R.id.restart);
        restart.setOnClickListener(v -> restartApp());
        enterImmersiveMode();

        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (webView != null && webView.canGoBack()) webView.goBack();
                else moveTaskToBack(true);
            }
        });

        requestRuntimePermissions();
        NodeService.start(this);
        ShellBridge.get().setRequestHandler(this);
        ShellBridge.get().addListener(this);
        askForBatteryExemptionOnce();
    }

    @Override
    protected void onResume() {
        super.onResume();
        resumed = true;
        inForeground = true;
        enterImmersiveMode();
    }

    @Override
    protected void onPause() {
        resumed = false;
        inForeground = false;
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        ShellBridge.get().removeListener(this);
        ShellBridge.get().clearRequestHandler(this);
        if (webView != null) webView.destroy();
        super.onDestroy();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) enterImmersiveMode();
    }

    /** Notifications for the server status, and nearby devices for Bluetooth printers. */
    private void requestRuntimePermissions() {
        java.util.List<String> missing = new java.util.ArrayList<>();
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

    private void enterImmersiveMode() {
        WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        controller.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
        controller.hide(WindowInsetsCompat.Type.systemBars());
    }

    // ---- Runtime state ------------------------------------------------------------

    @Override
    public void onRuntimeStateChanged(ShellBridge.State state, JSONObject info, String error) {
        switch (state) {
            case READY:
                runtimeInfo = info;
                showWebView();
                break;
            case FAILED:
            case EXITED:
                showError(error);
                break;
            default:
                break;
        }
    }

    private void showError(String error) {
        if (webView != null) webView.setVisibility(View.GONE);
        splash.setVisibility(View.VISIBLE);
        findViewById(R.id.progress).setVisibility(View.GONE);
        status.setText(getString(R.string.start_failed) + "\n\n" + (error == null ? "" : error));
        restart.setVisibility(View.VISIBLE);
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

    // ---- WebView ------------------------------------------------------------------

    @SuppressLint("SetJavaScriptEnabled")
    private void showWebView() {
        if (webLoaded) return;
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)
            || !WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            showError(getString(R.string.webview_too_old));
            return;
        }
        webLoaded = true;
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
        webView = new WebView(this);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setTextZoom(100);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setSupportMultipleWindows(false);

        Set<String> origins = new HashSet<>();
        origins.add(posOrigin());
        origins.add("http://localhost:" + port("serverPort", 3001));
        WebViewCompat.addDocumentStartJavaScript(webView, shimScript(), origins);
        WebViewCompat.addWebMessageListener(webView, "AlBaikNative", origins, this::onWebMessage);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (isOwnServer(uri)) return false;
                openExternal(uri.toString());
                return true;
            }

            @Override
            public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                Log.e(TAG, "WebView renderer stopped; reloading the POS");
                ((FrameLayout) findViewById(R.id.root)).removeView(view);
                view.destroy();
                webView = null;
                webLoaded = false;
                showWebView();
                return true;
            }
        });
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (pendingFileChooser != null) pendingFileChooser.onReceiveValue(null);
                pendingFileChooser = callback;
                launch(params.createIntent(), result -> {
                    ValueCallback<Uri[]> chooser = pendingFileChooser;
                    pendingFileChooser = null;
                    if (chooser != null) chooser.onReceiveValue(FileChooserParams.parseResult(result.getResultCode(), result.getData()));
                });
                return true;
            }
        });

        ((FrameLayout) findViewById(R.id.root)).addView(webView, new FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        webView.loadUrl(posOrigin() + "/");
        splash.setVisibility(View.GONE);
    }

    private boolean isOwnServer(Uri uri) {
        String host = uri.getHost();
        if (!"http".equals(uri.getScheme()) || host == null) return false;
        if (!host.equals("127.0.0.1") && !host.equals("localhost")) return false;
        int port = uri.getPort();
        return port == port("serverPort", 3001) || port == port("kdsPort", 3002) || port == port("serverAppPort", 3003);
    }

    private String shimScript() {
        try (InputStream in = getAssets().open("electron-api-shim.js")) {
            return new String(IoUtil.readFully(in), StandardCharsets.UTF_8);
        } catch (Exception e) {
            throw new IllegalStateException("Cannot load the electronAPI shim", e);
        }
    }

    // ---- Requests from the renderer (shim) -------------------------------------------

    private void onWebMessage(WebView view, WebMessageCompat message, Uri sourceOrigin, boolean isMainFrame, JavaScriptReplyProxy replyProxy) {
        if (!isMainFrame || message.getData() == null) return;
        Object id = null;
        try {
            JSONObject request = new JSONObject(message.getData());
            id = request.opt("id");
            Object requestId = id;
            JSONObject params = request.optJSONObject("params");
            String method = request.optString("method");
            ShellBridge.Reply reply = new ShellBridge.Reply() {
                @Override
                public void success(Object result) {
                    replyToPage(replyProxy, requestId, result, null);
                }

                @Override
                public void error(String error) {
                    replyToPage(replyProxy, requestId, null, error);
                }
            };
            JSONObject safeParams = params == null ? new JSONObject() : params;
            // Database and settings actions run in the backend; everything else is native.
            if ("hostAction".equals(method)) ShellBridge.get().callNode("hostAction", safeParams, reply);
            else handle(method, safeParams, reply);
        } catch (Exception e) {
            replyToPage(replyProxy, id, null, String.valueOf(e.getMessage()));
        }
    }

    private void replyToPage(JavaScriptReplyProxy proxy, Object id, Object result, String error) {
        try {
            JSONObject message = new JSONObject().put("id", id);
            if (error != null) message.put("error", error);
            else message.put("result", result == null ? JSONObject.NULL : result);
            proxy.postMessage(message.toString());
        } catch (Exception e) {
            Log.e(TAG, "Could not answer the page", e);
        }
    }

    // ---- Requests from the renderer and from Node --------------------------------------

    @Override
    public void handle(String method, JSONObject params, ShellBridge.Reply reply) {
        switch (method) {
            case "openExternal":
                openExternal(params.optString("url"));
                reply.success(null);
                break;
            case "printHtml":
                HtmlPrinter.print(this, params.optString("html"), posOrigin() + "/", params.optString("jobName", "Al Baik POS"),
                    () -> reply.success(new JSONObject()));
                break;
            case "saveDownload":
                saveDownload(params, reply);
                break;
            case "saveFileCopy":
                saveFileCopy(params, reply);
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

    private void launch(Intent intent, Consumer<ActivityResult> callback) {
        if (pendingResult != null) pendingResult.accept(new ActivityResult(RESULT_CANCELED, null));
        pendingResult = callback;
        try {
            activityLauncher.launch(intent);
        } catch (ActivityNotFoundException e) {
            pendingResult = null;
            callback.accept(new ActivityResult(RESULT_CANCELED, null));
        }
    }

    private void openExternal(String url) {
        Uri uri = Uri.parse(url);
        String scheme = uri.getScheme();
        if (!"https".equals(scheme) && !"http".equals(scheme) && !"whatsapp".equals(scheme) && !"mailto".equals(scheme) && !"tel".equals(scheme)) {
            Log.w(TAG, "Refused to open " + scheme + " link");
            return;
        }
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        } catch (ActivityNotFoundException e) {
            Log.w(TAG, "No app can open " + url);
        }
    }

    private Intent createDocumentIntent(String name, String mimeType) {
        return new Intent(Intent.ACTION_CREATE_DOCUMENT)
            .addCategory(Intent.CATEGORY_OPENABLE)
            .setType(mimeType == null || mimeType.isEmpty() ? "application/octet-stream" : mimeType)
            .putExtra(Intent.EXTRA_TITLE, IoUtil.safeFileName(name, "download"));
    }

    private void saveDownload(JSONObject params, ShellBridge.Reply reply) {
        byte[] data = Base64.decode(params.optString("base64"), Base64.DEFAULT);
        launch(createDocumentIntent(params.optString("name"), params.optString("mimeType")), result -> {
            Uri target = result.getData() == null ? null : result.getData().getData();
            if (result.getResultCode() != RESULT_OK || target == null) {
                reply.success(new JSONObjectBuilder().put("saved", false).build());
                return;
            }
            try (OutputStream out = getContentResolver().openOutputStream(target, "wt")) {
                if (out == null) throw new IOException("Cannot write the file");
                out.write(data);
                reply.success(new JSONObjectBuilder().put("saved", true).build());
            } catch (IOException e) {
                reply.error("Could not save the file: " + e.getMessage());
            }
        });
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
                reply.success(new JSONObjectBuilder().put("saved", false).build());
                return;
            }
            try (InputStream in = new FileInputStream(source); OutputStream out = getContentResolver().openOutputStream(target, "wt")) {
                if (out == null) throw new IOException("Cannot write the file");
                IoUtil.copy(in, out);
                reply.success(new JSONObjectBuilder().put("saved", true).build());
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
                reply.success(new JSONObjectBuilder().put("path", target.getAbsolutePath()).build());
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
            .setPositiveButton(params.optString("confirmLabel", "OK"), (d, w) -> reply.success(new JSONObjectBuilder().put("confirmed", true).build()))
            .setNegativeButton(params.optString("cancelLabel", "Cancel"), (d, w) -> reply.success(new JSONObjectBuilder().put("confirmed", false).build()))
            .setOnCancelListener(d -> reply.success(new JSONObjectBuilder().put("confirmed", false).build()))
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

    /** JSONObject.put throws a checked exception; this keeps the result builders readable. */
    private static final class JSONObjectBuilder {
        private final JSONObject object = new JSONObject();

        JSONObjectBuilder put(String key, Object value) {
            try {
                object.put(key, value);
            } catch (org.json.JSONException e) {
                throw new IllegalArgumentException(e);
            }
            return this;
        }

        JSONObject build() {
            return object;
        }
    }
}

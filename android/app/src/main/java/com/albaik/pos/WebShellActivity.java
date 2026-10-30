package com.albaik.pos;

import android.annotation.SuppressLint;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.util.Base64;
import android.util.Log;
import android.view.View;
import android.view.WindowManager;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
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

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Set;
import java.util.function.Consumer;

/**
 * Full-screen WebView shell shared by the main tablet's POS and Screen devices:
 * immersive window, document-start scripts, the AlBaikNative channel, and the
 * native services a page needs (printing, downloads, external links, file input).
 */
public abstract class WebShellActivity extends ComponentActivity {
    private static final String TAG = "AlBaikWebShell";

    protected WebView webView;
    private View splash;
    private View progress;
    private TextView status;
    private Button action;
    protected boolean resumed;

    private Consumer<ActivityResult> pendingResult;
    private ValueCallback<Uri[]> pendingFileChooser;
    private final ActivityResultLauncher<Intent> activityLauncher =
        registerForActivityResult(new ActivityResultContracts.StartActivityForResult(), result -> {
            Consumer<ActivityResult> callback = pendingResult;
            pendingResult = null;
            if (callback != null) callback.accept(result);
        });

    /** Origins whose pages get the injected scripts and may use AlBaikNative. */
    protected abstract Set<String> trustedOrigins();

    /** Asset scripts injected at document start, in order. */
    protected abstract List<String> injectedScripts();

    /** True for pages of the server this shell shows; anything else opens outside the app. */
    protected abstract boolean isOwnServer(Uri uri);

    /** Base URL for HTML the page sends to print, so relative images resolve. */
    protected abstract String printBaseUrl();

    protected void onMainFrameError() {}

    protected void onPageLoaded() {}

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        splash = findViewById(R.id.splash);
        progress = findViewById(R.id.progress);
        status = findViewById(R.id.status);
        action = findViewById(R.id.restart);
        enterImmersiveMode();
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (webView != null && webView.canGoBack()) webView.goBack();
                else moveTaskToBack(true);
            }
        });
    }

    @Override
    protected void onResume() {
        super.onResume();
        resumed = true;
        enterImmersiveMode();
    }

    @Override
    protected void onPause() {
        resumed = false;
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        if (webView != null) webView.destroy();
        super.onDestroy();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) enterImmersiveMode();
    }

    protected void enterImmersiveMode() {
        WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        controller.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
        controller.hide(WindowInsetsCompat.Type.systemBars());
    }

    // ---- Splash ----------------------------------------------------------------

    /** Shows the splash over the page; {@code actionLabel} null hides the button. */
    protected void showSplash(String message, boolean busy, String actionLabel, Runnable onAction) {
        splash.setVisibility(View.VISIBLE);
        splash.bringToFront();
        progress.setVisibility(busy ? View.VISIBLE : View.GONE);
        status.setText(message);
        if (actionLabel == null) {
            action.setVisibility(View.GONE);
        } else {
            action.setText(actionLabel);
            action.setOnClickListener(v -> onAction.run());
            action.setVisibility(View.VISIBLE);
        }
    }

    protected void hideSplash() {
        splash.setVisibility(View.GONE);
    }

    // ---- WebView -----------------------------------------------------------------

    protected boolean webViewSupported() {
        return WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)
            && WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER);
    }

    @SuppressLint("SetJavaScriptEnabled")
    protected void loadPage(String url) {
        if (webView == null) createWebView();
        webView.loadUrl(url);
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void createWebView() {
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

        Set<String> origins = trustedOrigins();
        for (String asset : injectedScripts()) WebViewCompat.addDocumentStartJavaScript(webView, readAsset(asset), origins);
        WebViewCompat.addWebMessageListener(webView, "AlBaikNative", origins, this::onWebMessage);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                if (isOwnServer(request.getUrl())) return false;
                openExternal(request.getUrl().toString());
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                onPageLoaded();
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) onMainFrameError();
            }

            @Override
            public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                Log.e(TAG, "WebView renderer stopped; reloading");
                String url = view.getUrl();
                ((FrameLayout) findViewById(R.id.root)).removeView(view);
                view.destroy();
                webView = null;
                if (url != null) loadPage(url);
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
        ((FrameLayout) findViewById(R.id.root)).addView(webView, 0, new FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
    }

    protected String readAsset(String name) {
        try (InputStream in = getAssets().open(name)) {
            return new String(IoUtil.readFully(in), StandardCharsets.UTF_8);
        } catch (IOException e) {
            throw new IllegalStateException("Cannot load " + name, e);
        }
    }

    // ---- Requests from pages ---------------------------------------------------------

    private void onWebMessage(WebView view, WebMessageCompat message, Uri sourceOrigin, boolean isMainFrame, JavaScriptReplyProxy replyProxy) {
        if (!isMainFrame || message.getData() == null) return;
        Object id = null;
        try {
            JSONObject request = new JSONObject(message.getData());
            id = request.opt("id");
            Object requestId = id;
            JSONObject params = request.optJSONObject("params");
            handleWebRequest(request.optString("method"), params == null ? new JSONObject() : params, new ShellBridge.Reply() {
                @Override
                public void success(Object result) {
                    replyToPage(replyProxy, requestId, result, null);
                }

                @Override
                public void error(String error) {
                    replyToPage(replyProxy, requestId, null, error);
                }
            });
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

    /** Requests from webview-shim.js; subclasses add their own and fall back to this. */
    protected void handleWebRequest(String method, JSONObject params, ShellBridge.Reply reply) {
        switch (method) {
            case "openExternal":
                openExternal(params.optString("url"));
                reply.success(null);
                break;
            case "printHtml":
                HtmlPrinter.print(this, params.optString("html"), printBaseUrl(), params.optString("jobName", "Al Baik POS"),
                    () -> reply.success(new JSONObject()));
                break;
            case "saveDownload":
                saveDownload(params, reply);
                break;
            default:
                reply.error("Unknown request " + method);
        }
    }

    protected void launch(Intent intent, Consumer<ActivityResult> callback) {
        if (pendingResult != null) pendingResult.accept(new ActivityResult(RESULT_CANCELED, null));
        pendingResult = callback;
        try {
            activityLauncher.launch(intent);
        } catch (ActivityNotFoundException e) {
            pendingResult = null;
            callback.accept(new ActivityResult(RESULT_CANCELED, null));
        }
    }

    protected void openExternal(String url) {
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

    protected Intent createDocumentIntent(String name, String mimeType) {
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
                reply.success(Json.of("saved", false));
                return;
            }
            try (OutputStream out = getContentResolver().openOutputStream(target, "wt")) {
                if (out == null) throw new IOException("Cannot write the file");
                out.write(data);
                reply.success(Json.of("saved", true));
            } catch (IOException e) {
                reply.error("Could not save the file: " + e.getMessage());
            }
        });
    }
}

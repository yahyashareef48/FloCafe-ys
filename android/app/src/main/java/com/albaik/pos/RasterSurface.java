package com.albaik.pos;

import android.annotation.SuppressLint;
import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.webkit.JavascriptInterface;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Hidden WebView that runs the backend's raster page (main/printers/raster-renderer.ts
 * rasterRendererHtml), the Android counterpart of Electron's offscreen raster window.
 * It draws text the printer cannot encode, such as the rupee sign or Urdu, as bitmaps.
 */
final class RasterSurface {
    private static final String TAG = "AlBaikRaster";
    private static final long REQUEST_TIMEOUT_MS = 15_000;
    private final Context context;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final Map<String, ShellBridge.Reply> inflight = new HashMap<>();
    private final List<JSONObject> queued = new ArrayList<>();
    private WebView view;
    private String loadedPage;
    private boolean ready;

    RasterSurface(Context context) {
        this.context = context;
    }

    void register(ShellBridge bridge) {
        bridge.registerServiceHandler("rasterRender", (method, params, reply) -> render(params, reply));
    }

    private void render(JSONObject params, ShellBridge.Reply reply) {
        JSONObject request = params.optJSONObject("request");
        String page = params.optString("pageHtml");
        if (request == null || page.isEmpty()) {
            reply.error("Invalid raster request");
            return;
        }
        String requestId = request.optString("requestId");
        if (inflight.containsKey(requestId)) {
            reply.error("Duplicate raster request ID");
            return;
        }
        inflight.put(requestId, reply);
        Breadcrumbs.note(context, "raster: request " + requestId + " (" + request.optInt("widthDots") + " dots)");
        main.postDelayed(() -> {
            ShellBridge.Reply pending = inflight.remove(requestId);
            if (pending != null) pending.error("Raster rendering timed out");
        }, REQUEST_TIMEOUT_MS);
        if (!page.equals(loadedPage)) load(page);
        if (ready) deliver(request);
        else queued.add(request);
    }

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    private void load(String page) {
        Breadcrumbs.note(context, "raster: creating the drawing page (" + page.length() + " chars)");
        if (view != null) view.destroy();
        ready = false;
        loadedPage = page;
        view = new WebView(context);
        WebSettings settings = view.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setBlockNetworkLoads(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        view.layout(0, 0, 1, 1);
        view.setWebViewClient(new WebViewClient() {
            @Override
            public boolean onRenderProcessGone(WebView gone, RenderProcessGoneDetail detail) {
                // Unhandled, a lost renderer ends the whole app, servers included.
                Log.e(TAG, "Raster renderer stopped (crashed: " + detail.didCrash() + ")");
                Breadcrumbs.note(context, "raster: renderer stopped (crashed: " + detail.didCrash() + ")");
                discard(gone);
                return true;
            }
        });
        view.addJavascriptInterface(new Host(), "AlBaikRasterHost");
        // assets/raster-host.js provides window.__floRaster; it must run before the page script.
        String host = "<script>" + hostScript() + "</script>";
        int firstScript = page.indexOf("<script>");
        String html = firstScript < 0 ? host + page : page.substring(0, firstScript) + host + page.substring(firstScript);
        view.loadDataWithBaseURL(null, html, "text/html", "UTF-8", null);
    }

    /** Drops a dead view and fails its work; the next request loads a fresh one. */
    private void discard(WebView gone) {
        if (gone != view) {
            gone.destroy();
            return;
        }
        view = null;
        loadedPage = null;
        ready = false;
        queued.clear();
        gone.destroy();
        for (ShellBridge.Reply pending : new ArrayList<>(inflight.values())) pending.error("The raster renderer stopped");
        inflight.clear();
    }

    private String hostScript() {
        try (java.io.InputStream in = context.getAssets().open("raster-host.js")) {
            return new String(IoUtil.readFully(in), java.nio.charset.StandardCharsets.UTF_8);
        } catch (java.io.IOException e) {
            throw new IllegalStateException("Cannot load the raster host script", e);
        }
    }

    private void deliver(JSONObject request) {
        try {
            String message = new JSONObject().put("version", 1).put("request", request).toString();
            view.evaluateJavascript("window.__floRasterDeliver(" + message + ")", null);
        } catch (Exception e) {
            ShellBridge.Reply pending = inflight.remove(request.optString("requestId"));
            if (pending != null) pending.error("Could not start raster rendering: " + e.getMessage());
        }
    }

    private final class Host {
        @JavascriptInterface
        public void ready() {
            main.post(() -> {
                Breadcrumbs.note(context, "raster: drawing page ready");
                ready = true;
                for (JSONObject request : queued) deliver(request);
                queued.clear();
            });
        }

        @JavascriptInterface
        public void result(String json) {
            main.post(() -> {
                try {
                    JSONObject result = new JSONObject(json);
                    Breadcrumbs.note(context, "raster: result " + result.optString("requestId") + " ok=" + result.optBoolean("ok"));
                    ShellBridge.Reply pending = inflight.remove(result.optString("requestId"));
                    if (pending != null) pending.success(result);
                } catch (Exception e) {
                    Log.e(TAG, "Unreadable raster result", e);
                }
            });
        }
    }
}

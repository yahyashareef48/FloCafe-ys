package com.albaik.pos;

import android.content.Intent;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;

import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * A Screen device: shows one page of the main device (waiter app, kitchen
 * display, or POS) full screen, and reconnects by itself when the Wi-Fi or
 * the main device drops, finding the main device again if its address changed.
 */
public class ScreenActivity extends WebShellActivity {
    private static final long WATCH_INTERVAL_MS = 20_000;
    private static final long RETRY_INTERVAL_MS = 3_000;
    private static final int RETRIES_BEFORE_REDISCOVERY = 5;

    private final Handler main = new Handler(Looper.getMainLooper());
    private ServerDiscovery discovery;
    private ConnectivityManager.NetworkCallback networkCallback;
    private boolean reconnecting;
    private int failedProbes;
    private int failedRetries;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (AppMode.mode(this) != AppMode.Mode.SCREEN || AppMode.host(this).isEmpty()) {
            startActivity(new Intent(this, SetupActivity.class));
            finish();
            return;
        }
        if (!webViewSupported()) {
            showSplash(getString(R.string.webview_too_old), false, null, null);
            return;
        }
        discovery = new ServerDiscovery(this);
        showSplash(getString(R.string.screen_connecting, AppMode.host(this)), true, null, null);
        loadPage(pageUrl());
        watchNetwork();
        main.postDelayed(this::watch, WATCH_INTERVAL_MS);
    }

    @Override
    protected void onDestroy() {
        main.removeCallbacksAndMessages(null);
        if (discovery != null) discovery.stop();
        if (networkCallback != null) getSystemService(ConnectivityManager.class).unregisterNetworkCallback(networkCallback);
        super.onDestroy();
    }

    private String origin() {
        return "http://" + AppMode.host(this) + ":" + AppMode.port(this);
    }

    private String pageUrl() {
        return origin() + AppMode.role(this).path;
    }

    // ---- WebShellActivity -------------------------------------------------------

    @Override
    protected Set<String> trustedOrigins() {
        return new HashSet<>(Collections.singletonList(origin()));
    }

    @Override
    protected List<String> injectedScripts() {
        return Arrays.asList("webview-shim.js");
    }

    @Override
    protected boolean isOwnServer(Uri uri) {
        return "http".equals(uri.getScheme()) && AppMode.host(this).equals(uri.getHost());
    }

    @Override
    protected String printBaseUrl() {
        return origin() + "/";
    }

    @Override
    protected void onMainFrameError() {
        startReconnecting();
    }

    @Override
    protected void onPageLoaded() {
        if (!reconnecting) hideSplash();
    }

    // ---- Connection watch ---------------------------------------------------------

    /** Checks the main device every few seconds; two misses in a row start reconnecting. */
    private void watch() {
        String url = pageUrl();
        new Thread(() -> {
            boolean ok = ServerDiscovery.reachable(url);
            main.post(() -> {
                if (reconnecting) return;
                if (ok) {
                    failedProbes = 0;
                } else if (++failedProbes >= 2) {
                    startReconnecting();
                    return;
                }
                main.postDelayed(this::watch, WATCH_INTERVAL_MS);
            });
        }).start();
    }

    private void startReconnecting() {
        if (reconnecting) return;
        reconnecting = true;
        failedRetries = 0;
        showSplash(getString(R.string.screen_reconnecting, AppMode.host(this)), true,
            getString(R.string.screen_change_setup), () -> startActivity(new Intent(this, SetupActivity.class)));
        main.removeCallbacksAndMessages(null);
        main.postDelayed(this::retry, RETRY_INTERVAL_MS);
    }

    private void retry() {
        String url = pageUrl();
        new Thread(() -> {
            boolean ok = ServerDiscovery.reachable(url);
            main.post(() -> {
                if (!reconnecting) return;
                if (ok) {
                    reconnected();
                    return;
                }
                if (++failedRetries == RETRIES_BEFORE_REDISCOVERY) rediscover();
                main.postDelayed(this::retry, RETRY_INTERVAL_MS);
            });
        }).start();
    }

    /** The main device may have a new address after a router restart; find it again by its service. */
    private void rediscover() {
        String wanted = AppMode.serviceName(this);
        discovery.start(server -> {
            if (!wanted.isEmpty() && !wanted.equals(server.name)) return;
            if (server.host.equals(AppMode.host(this))) return;
            AppMode.Role role = AppMode.role(this);
            AppMode.updateScreenHost(this, server.host, server.portFor(role));
            discovery.stop();
            // The trusted origin is fixed when the WebView is created, so start over with the new address.
            recreate();
        });
    }

    private void reconnected() {
        reconnecting = false;
        failedProbes = 0;
        discovery.stop();
        if (webView != null) webView.loadUrl(pageUrl());
        main.postDelayed(this::watch, WATCH_INTERVAL_MS);
    }

    private void watchNetwork() {
        networkCallback = new ConnectivityManager.NetworkCallback() {
            @Override
            public void onAvailable(Network network) {
                main.post(() -> {
                    if (reconnecting) {
                        main.removeCallbacksAndMessages(null);
                        retry();
                    }
                });
            }

            @Override
            public void onLost(Network network) {
                main.post(ScreenActivity.this::startReconnecting);
            }
        };
        getSystemService(ConnectivityManager.class).registerDefaultNetworkCallback(networkCallback);
    }
}

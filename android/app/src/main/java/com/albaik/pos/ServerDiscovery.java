package com.albaik.pos;

import android.content.Context;
import android.net.nsd.NsdManager;
import android.net.nsd.NsdServiceInfo;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.Map;

/**
 * Finds the main device on the Wi-Fi. Both the Android main tablet (NodeService)
 * and the Windows app advertise an `_http._tcp` service named "Flo" with the KDS
 * and Server App ports in its TXT record.
 */
final class ServerDiscovery {
    private static final String TAG = "AlBaikDiscovery";
    static final String SERVICE_TYPE = "_http._tcp.";
    static final String SERVICE_NAME = "Flo";

    static final class Server {
        final String name;
        final String host;
        final int posPort;
        final int kdsPort;
        final int serverAppPort;

        Server(String name, String host, int posPort, int kdsPort, int serverAppPort) {
            this.name = name;
            this.host = host;
            this.posPort = posPort;
            this.kdsPort = kdsPort;
            this.serverAppPort = serverAppPort;
        }

        int portFor(AppMode.Role role) {
            switch (role) {
                case WAITER:
                    return serverAppPort;
                case KITCHEN:
                    return kdsPort;
                default:
                    return posPort;
            }
        }
    }

    interface Listener {
        void onFound(Server server);
    }

    private final NsdManager nsd;
    private final Handler main = new Handler(Looper.getMainLooper());
    // NsdManager resolves one service at a time.
    private final ArrayDeque<NsdServiceInfo> toResolve = new ArrayDeque<>();
    private boolean resolving;
    private NsdManager.DiscoveryListener discovery;
    private Listener listener;

    ServerDiscovery(Context context) {
        nsd = (NsdManager) context.getApplicationContext().getSystemService(Context.NSD_SERVICE);
    }

    static boolean isFloService(String name) {
        return name != null && (name.equals(SERVICE_NAME) || name.startsWith(SERVICE_NAME + " ("));
    }

    void start(Listener found) {
        stop();
        listener = found;
        discovery = new NsdManager.DiscoveryListener() {
            @Override
            public void onStartDiscoveryFailed(String serviceType, int errorCode) {
                Log.w(TAG, "Discovery failed to start: " + errorCode);
            }

            @Override
            public void onStopDiscoveryFailed(String serviceType, int errorCode) {}

            @Override
            public void onDiscoveryStarted(String serviceType) {}

            @Override
            public void onDiscoveryStopped(String serviceType) {}

            @Override
            public void onServiceFound(NsdServiceInfo info) {
                if (!isFloService(info.getServiceName())) return;
                main.post(() -> {
                    toResolve.add(info);
                    resolveNext();
                });
            }

            @Override
            public void onServiceLost(NsdServiceInfo info) {}
        };
        nsd.discoverServices(SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, discovery);
    }

    void stop() {
        if (discovery != null) {
            try {
                nsd.stopServiceDiscovery(discovery);
            } catch (IllegalArgumentException ignored) {
                // Already stopped.
            }
        }
        discovery = null;
        listener = null;
        toResolve.clear();
    }

    @SuppressWarnings("deprecation")
    private void resolveNext() {
        if (resolving || toResolve.isEmpty()) return;
        resolving = true;
        nsd.resolveService(toResolve.poll(), new NsdManager.ResolveListener() {
            @Override
            public void onResolveFailed(NsdServiceInfo info, int errorCode) {
                main.post(() -> {
                    resolving = false;
                    resolveNext();
                });
            }

            @Override
            public void onServiceResolved(NsdServiceInfo info) {
                InetAddress address = info.getHost();
                Map<String, byte[]> txt = info.getAttributes();
                Server server = address == null ? null : new Server(
                    info.getServiceName(),
                    address.getHostAddress(),
                    info.getPort(),
                    intAttribute(txt, "kds_port", AppMode.Role.KITCHEN.defaultPort),
                    intAttribute(txt, "server_app_port", AppMode.Role.WAITER.defaultPort));
                main.post(() -> {
                    resolving = false;
                    if (server != null && listener != null) listener.onFound(server);
                    resolveNext();
                });
            }
        });
    }

    private static int intAttribute(Map<String, byte[]> txt, String key, int fallback) {
        byte[] value = txt == null ? null : txt.get(key);
        if (value == null) return fallback;
        try {
            return Integer.parseInt(new String(value, StandardCharsets.UTF_8).trim());
        } catch (NumberFormatException e) {
            return fallback;
        }
    }

    /** Blocking: true when the URL answers with a non-error status. Call off the main thread. */
    static boolean reachable(String url) {
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(url).openConnection();
            connection.setConnectTimeout(2500);
            connection.setReadTimeout(2500);
            connection.setInstanceFollowRedirects(false);
            int code = connection.getResponseCode();
            return code >= 200 && code < 400;
        } catch (Exception e) {
            return false;
        } finally {
            if (connection != null) connection.disconnect();
        }
    }
}

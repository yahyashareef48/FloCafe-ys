package com.albaik.pos;

import android.net.LocalServerSocket;
import android.net.LocalSocket;
import android.os.Handler;
import android.os.Looper;
import android.os.Process;
import android.util.Base64;
import android.util.Log;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Newline-delimited JSON channel to the Node runtime (main/android/native-bridge.ts)
 * over an abstract Unix socket. Only a peer with this app's UID that presents
 * the per-launch token is accepted.
 */
final class ShellBridge {
    private static final String TAG = "AlBaikBridge";

    enum State { STARTING, READY, FAILED, EXITED }

    interface Listener {
        void onRuntimeStateChanged(State state, JSONObject info, String error);
    }

    /** Handles a request from Node on the main thread and answers through {@link Reply}. */
    interface RequestHandler {
        void handle(String method, JSONObject params, Reply reply);
    }

    interface Reply {
        void success(Object result);
        void error(String message);
    }

    private static final ShellBridge INSTANCE = new ShellBridge();

    static ShellBridge get() {
        return INSTANCE;
    }

    private final Handler main = new Handler(Looper.getMainLooper());
    private final CopyOnWriteArrayList<Listener> listeners = new CopyOnWriteArrayList<>();
    private final Map<Integer, Reply> pendingCalls = new ConcurrentHashMap<>();
    private final AtomicInteger nextId = new AtomicInteger(1);
    private final ExecutorService writer = Executors.newSingleThreadExecutor();
    private volatile RequestHandler requestHandler;
    private final Map<String, RequestHandler> serviceHandlers = new ConcurrentHashMap<>();
    private volatile OutputStream nodeOut;
    private volatile State state = State.STARTING;
    private volatile JSONObject readyInfo;
    private volatile String failure;
    private String socketName;
    private String token;
    private LocalServerSocket server;

    private ShellBridge() {}

    synchronized void start() throws IOException {
        if (server != null) return;
        socketName = "albaik-pos-" + UUID.randomUUID();
        byte[] secret = new byte[32];
        new SecureRandom().nextBytes(secret);
        token = Base64.encodeToString(secret, Base64.NO_WRAP | Base64.NO_PADDING | Base64.URL_SAFE);
        server = new LocalServerSocket(socketName);
        Thread acceptor = new Thread(this::acceptLoop, "albaik-bridge-accept");
        acceptor.setDaemon(true);
        acceptor.start();
    }

    String socketName() {
        return socketName;
    }

    String token() {
        return token;
    }

    State state() {
        return state;
    }

    JSONObject readyInfo() {
        return readyInfo;
    }

    String failure() {
        return failure;
    }

    void setRequestHandler(RequestHandler handler) {
        requestHandler = handler;
    }

    /** Handlers that must work with no screen open (printing, raster); they take precedence over the UI handler. */
    void registerServiceHandler(String method, RequestHandler handler) {
        serviceHandlers.put(method, handler);
    }

    void clearRequestHandler(RequestHandler handler) {
        if (requestHandler == handler) requestHandler = null;
    }

    void addListener(Listener listener) {
        listeners.add(listener);
        main.post(() -> listener.onRuntimeStateChanged(state, readyInfo, failure));
    }

    void removeListener(Listener listener) {
        listeners.remove(listener);
    }

    void onNodeExited(int code) {
        setState(State.EXITED, null, "The POS server stopped (exit code " + code + ").");
    }

    void onNodeStartFailed(String message) {
        setState(State.FAILED, null, message);
    }

    /** Sends a request to Node; the reply arrives on the main thread. */
    void callNode(String method, JSONObject params, Reply reply) {
        int id = nextId.getAndIncrement();
        pendingCalls.put(id, reply);
        writer.execute(() -> {
            try {
                write(new JSONObject().put("id", id).put("method", method).put("params", params == null ? JSONObject.NULL : params));
            } catch (Exception e) {
                pendingCalls.remove(id);
                main.post(() -> reply.error(String.valueOf(e.getMessage())));
            }
        });
    }

    private void setState(State next, JSONObject info, String error) {
        state = next;
        if (info != null) readyInfo = info;
        failure = error;
        main.post(() -> {
            for (Listener listener : listeners) listener.onRuntimeStateChanged(next, readyInfo, error);
        });
    }

    private void acceptLoop() {
        while (true) {
            LocalSocket socket;
            try {
                socket = server.accept();
            } catch (IOException e) {
                Log.e(TAG, "Bridge accept failed", e);
                return;
            }
            try {
                if (socket.getPeerCredentials().getUid() != Process.myUid()) {
                    Log.w(TAG, "Rejected bridge connection from another app");
                    socket.close();
                    continue;
                }
                Thread reader = new Thread(() -> readLoop(socket), "albaik-bridge-read");
                reader.setDaemon(true);
                reader.start();
            } catch (IOException e) {
                Log.e(TAG, "Bridge connection failed", e);
            }
        }
    }

    private void readLoop(LocalSocket socket) {
        try (LocalSocket ignored = socket;
             BufferedReader in = new BufferedReader(new InputStreamReader(socket.getInputStream(), StandardCharsets.UTF_8))) {
            JSONObject hello = new JSONObject(in.readLine());
            byte[] presented = hello.optString("token", "").getBytes(StandardCharsets.UTF_8);
            if (!"hello".equals(hello.optString("type")) || !MessageDigest.isEqual(presented, token.getBytes(StandardCharsets.UTF_8))) {
                Log.w(TAG, "Rejected bridge connection with a wrong token");
                return;
            }
            nodeOut = socket.getOutputStream();
            String line;
            while ((line = in.readLine()) != null) {
                if (!line.isEmpty()) dispatch(new JSONObject(line));
            }
        } catch (Exception e) {
            Log.e(TAG, "Bridge connection closed", e);
        } finally {
            nodeOut = null;
        }
    }

    private void dispatch(JSONObject message) {
        if ("event".equals(message.optString("type"))) {
            String event = message.optString("event");
            JSONObject data = message.optJSONObject("data");
            if ("ready".equals(event)) setState(State.READY, data, null);
            else if ("failed".equals(event)) setState(State.FAILED, null, data == null ? "Unknown error" : data.optString("message"));
            return;
        }
        if (message.has("method")) {
            Object id = message.opt("id");
            String method = message.optString("method");
            JSONObject params = message.optJSONObject("params");
            main.post(() -> {
                RequestHandler service = serviceHandlers.get(method);
                RequestHandler handler = service != null ? service : requestHandler;
                Reply reply = new Reply() {
                    @Override
                    public void success(Object result) {
                        respond(id, result, null);
                    }

                    @Override
                    public void error(String error) {
                        respond(id, null, error);
                    }
                };
                if (handler == null) {
                    reply.error("No handler for " + method);
                    return;
                }
                try {
                    handler.handle(method, params == null ? new JSONObject() : params, reply);
                } catch (RuntimeException e) {
                    // Handlers run on the main thread, where an exception would end the app.
                    Log.e(TAG, method + " failed", e);
                    reply.error(method + " failed: " + e);
                }
            });
            return;
        }
        Reply pending = pendingCalls.remove(message.optInt("id", -1));
        if (pending == null) return;
        String error = message.isNull("error") ? null : message.optString("error", null);
        Object result = message.opt("result");
        main.post(() -> {
            if (error != null) pending.error(error);
            else pending.success(result);
        });
    }

    private void respond(Object id, Object result, String error) {
        writer.execute(() -> {
            try {
                JSONObject message = new JSONObject().put("id", id);
                if (error != null) message.put("error", error);
                else message.put("result", result == null ? JSONObject.NULL : result);
                write(message);
            } catch (Exception e) {
                Log.e(TAG, "Bridge reply failed", e);
            }
        });
    }

    private void write(JSONObject message) throws IOException {
        OutputStream out = nodeOut;
        if (out == null) throw new IOException("The POS server is not connected");
        out.write((message.toString() + "\n").getBytes(StandardCharsets.UTF_8));
        out.flush();
    }
}

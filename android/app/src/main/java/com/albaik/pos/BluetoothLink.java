package com.albaik.pos;

import java.io.IOException;
import java.util.Arrays;

/**
 * Keeps one Bluetooth printer connection open between jobs, so a bill starts printing at once
 * instead of after a reconnect of several seconds. While the connection is idle it sends a single
 * NUL byte every keep-alive period, which ESC/POS printers ignore: a printer that went away is
 * noticed then rather than by the next bill. The connection is closed after a long idle period.
 *
 * <p>Not thread-safe: every call must run on the one printer thread.
 */
final class BluetoothLink {
    interface Connection {
        void write(byte[] data, int offset, int length) throws IOException;

        void close();
    }

    interface Connector {
        Connection connect(String address) throws IOException;
    }

    interface Clock {
        long nowMs();

        void sleep(long ms) throws InterruptedException;
    }

    interface Notes {
        void note(String step);
    }

    private static final byte[] KEEP_ALIVE = {0};

    private final Connector connector;
    private final Clock clock;
    private final Notes notes;
    private final int chunkBytes;
    private final long chunkPauseMs;
    private final int tailPaddingBytes;
    private final long idleCloseMs;
    private final long keepAliveMs;

    private Connection connection;
    private String address;
    private long lastJobMs;
    private long lastWriteMs;

    BluetoothLink(
        Connector connector,
        Clock clock,
        Notes notes,
        int chunkBytes,
        long chunkPauseMs,
        int tailPaddingBytes,
        long idleCloseMs,
        long keepAliveMs) {
        this.connector = connector;
        this.clock = clock;
        this.notes = notes;
        this.chunkBytes = chunkBytes;
        this.chunkPauseMs = chunkPauseMs;
        this.tailPaddingBytes = tailPaddingBytes;
        this.idleCloseMs = idleCloseMs;
        this.keepAliveMs = keepAliveMs;
    }

    /** Prints one job; throws when the printer cannot be reached, leaving no connection open. */
    void send(String to, byte[] data) throws IOException, InterruptedException {
        byte[] job = Arrays.copyOf(data, data.length + tailPaddingBytes);
        boolean reused = isOpenTo(to);
        try {
            try {
                writePaced(open(to), job);
            } catch (IOException stale) {
                close("write failed (" + stale.getMessage() + ")");
                // A kept connection the printer dropped fails on its first write; connect again
                // once. A fresh connection that fails is a real failure.
                if (!reused) throw stale;
                notes.note("bluetooth: kept connection failed, reconnecting");
                writePaced(open(to), job);
            }
        } catch (IOException | InterruptedException | RuntimeException e) {
            // Part of a job may be in the printer; a fresh connection starts the next job clean.
            close("job not sent");
            throw e;
        }
        lastJobMs = clock.nowMs();
    }

    /** Runs the keep-alive and the idle close; call it every few seconds. */
    void tick() {
        if (connection == null) return;
        long now = clock.nowMs();
        if (now - lastJobMs >= idleCloseMs) {
            close("idle for " + (idleCloseMs / 60_000) + " min");
            return;
        }
        if (now - lastWriteMs < keepAliveMs) return;
        try {
            connection.write(KEEP_ALIVE, 0, KEEP_ALIVE.length);
            lastWriteMs = now;
        } catch (IOException e) {
            close("printer stopped answering (" + e.getMessage() + ")");
        }
    }

    /** Android reported that the printer's Bluetooth link is gone. */
    void dropped(String droppedAddress) {
        if (droppedAddress != null && droppedAddress.equalsIgnoreCase(address)) close("printer disconnected");
    }

    boolean isOpenTo(String to) {
        return connection != null && to.equalsIgnoreCase(address);
    }

    void close(String reason) {
        if (connection == null) return;
        Connection closing = connection;
        connection = null;
        address = null;
        closing.close();
        notes.note("bluetooth: connection closed: " + reason);
    }

    private Connection open(String to) throws IOException {
        if (isOpenTo(to)) return connection;
        close("switching printer");
        notes.note("bluetooth: connecting to " + to);
        connection = connector.connect(to);
        address = to;
        lastJobMs = lastWriteMs = clock.nowMs();
        notes.note("bluetooth: connected");
        return connection;
    }

    private void writePaced(Connection out, byte[] job) throws IOException, InterruptedException {
        for (int offset = 0; offset < job.length; offset += chunkBytes) {
            out.write(job, offset, Math.min(chunkBytes, job.length - offset));
            lastWriteMs = clock.nowMs();
            clock.sleep(chunkPauseMs);
        }
    }
}

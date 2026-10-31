package com.albaik.pos;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Random;

/**
 * Checks BluetoothLink against a simulated printer and clock: reuse, keep-alive, idle close,
 * printers that switch off, sleep or drop the link, and shifts of many hours with random events.
 * Runs on a plain JVM: android/scripts/test-bluetooth-link.sh.
 */
public final class BluetoothLinkCheck {
    static final int CHUNK = 256;
    static final long PAUSE = 20;
    static final int TAIL = 512;
    static final long IDLE_CLOSE = 2 * 60 * 60_000L;
    static final long KEEP_ALIVE = 30_000;
    static final long TICK = 5_000;
    static final long SUPERVISION_TIMEOUT = 20_000;
    static final String A = "AA:BB:CC:DD:EE:01";
    static final String B = "AA:BB:CC:DD:EE:02";

    static int checks;

    static void check(boolean ok, String what) {
        checks++;
        if (!ok) throw new AssertionError(what);
    }

    static final class FakeClock implements BluetoothLink.Clock {
        long now = 1_000_000;

        @Override
        public long nowMs() {
            return now;
        }

        @Override
        public void sleep(long ms) {
            now += ms;
        }
    }

    /** One printer. Bytes it receives go to `received`; a dead link refuses writes. */
    static final class FakePrinter {
        final String address;
        final FakeClock clock;
        boolean on = true;
        int connects;
        int failedConnects;
        int open;
        int maxOpen;
        FakeLink current;
        final ByteArrayOutputStream received = new ByteArrayOutputStream();

        FakePrinter(String address, FakeClock clock) {
            this.address = address;
            this.clock = clock;
        }

        FakeLink connect() throws IOException {
            if (!on) {
                failedConnects++;
                throw new IOException("read failed, socket might closed or timeout");
            }
            connects++;
            open++;
            maxOpen = Math.max(maxOpen, open);
            current = new FakeLink(this);
            return current;
        }

        /** Switched off: the link ends. Silent means Android only notices after the supervision timeout. */
        void switchOff(boolean silent) {
            on = false;
            if (current != null) current.die(silent ? clock.now + SUPERVISION_TIMEOUT : clock.now);
        }

        void switchOn() {
            on = true;
        }
    }

    static final class FakeLink implements BluetoothLink.Connection {
        final FakePrinter printer;
        boolean closed;
        long deadFrom = Long.MAX_VALUE;
        long writesAcceptedUntil = Long.MAX_VALUE;
        int lostBytes;

        FakeLink(FakePrinter printer) {
            this.printer = printer;
        }

        void die(long errorsFrom) {
            deadFrom = printer.clock.now;
            writesAcceptedUntil = errorsFrom;
        }

        @Override
        public void write(byte[] data, int offset, int length) throws IOException {
            if (closed) throw new IOException("socket closed");
            long now = printer.clock.now;
            if (now >= deadFrom) {
                if (now >= writesAcceptedUntil) throw new IOException("Broken pipe");
                lostBytes += length;
                return;
            }
            printer.received.write(data, offset, length);
        }

        @Override
        public void close() {
            check(!closed, "a connection is closed twice");
            closed = true;
            printer.open--;
            if (printer.current == this) printer.current = null;
        }
    }

    static final class Rig {
        final FakeClock clock = new FakeClock();
        final FakePrinter a = new FakePrinter(A, clock);
        final FakePrinter b = new FakePrinter(B, clock);
        final List<String> notes = new ArrayList<>();
        final BluetoothLink link = new BluetoothLink(
            address -> (address.equals(A) ? a : b).connect(),
            clock,
            notes::add,
            CHUNK,
            PAUSE,
            TAIL,
            IDLE_CLOSE,
            KEEP_ALIVE);

        /** Advances the clock, running the housekeeping tick every TICK ms as the app does. */
        void idle(long ms) {
            long end = clock.now + ms;
            while (clock.now + TICK <= end) {
                clock.now += TICK;
                link.tick();
            }
            clock.now = end;
        }
    }

    static byte[] bill(int seed, int length) {
        byte[] data = new byte[length];
        Random random = new Random(seed);
        for (int i = 0; i < length; i++) data[i] = (byte) (1 + random.nextInt(255));
        return data;
    }

    /** The printer's stream: the jobs in order, each followed by its NUL tail, NULs between them. */
    static void checkStream(byte[] stream, List<byte[]> jobs, String what) {
        int at = 0;
        for (int j = 0; j < jobs.size(); j++) {
            byte[] job = jobs.get(j);
            while (at < stream.length && stream[at] == 0) at++;
            check(at + job.length <= stream.length, what + ": job " + j + " is cut off");
            check(Arrays.equals(Arrays.copyOfRange(stream, at, at + job.length), job), what + ": job " + j + " arrived changed");
            at += job.length;
        }
        for (; at < stream.length; at++) check(stream[at] == 0, what + ": bytes other than NUL outside a job");
    }

    // ---- Scenarios ----------------------------------------------------------------

    static void oneJob() throws Exception {
        Rig rig = new Rig();
        byte[] job = bill(1, 3000);
        rig.link.send(A, job);
        byte[] got = rig.a.received.toByteArray();
        check(got.length == job.length + TAIL, "the job and its NUL tail arrive");
        checkStream(got, List.of(job), "one job");
        check(rig.a.connects == 1, "one connection");
        check(rig.link.isOpenTo(A), "the connection stays open after the job");
    }

    static void busyShiftReusesOneConnection() throws Exception {
        Rig rig = new Rig();
        List<byte[]> jobs = new ArrayList<>();
        for (int i = 0; i < 300; i++) {
            byte[] job = bill(i, 500 + i * 7);
            jobs.add(job);
            rig.link.send(A, job);
            rig.idle(60_000 + (i % 5) * 30_000);
        }
        check(rig.a.connects == 1, "300 bills over 7 hours use one connection (got " + rig.a.connects + ")");
        checkStream(rig.a.received.toByteArray(), jobs, "busy shift");
    }

    static void keepAliveSendsOnlyNulWhileIdle() throws Exception {
        Rig rig = new Rig();
        byte[] job = bill(7, 800);
        rig.link.send(A, job);
        int afterJob = rig.a.received.size();
        rig.idle(60 * 60_000);
        int nuls = rig.a.received.size() - afterJob;
        check(nuls >= 110 && nuls <= 121, "about one NUL every 30 s for an hour (got " + nuls + ")");
        checkStream(rig.a.received.toByteArray(), List.of(job), "keep-alive");
        check(rig.link.isOpenTo(A), "still connected after an idle hour");
    }

    static void idleCloseAfterTwoHours() throws Exception {
        Rig rig = new Rig();
        rig.link.send(A, bill(2, 400));
        rig.idle(IDLE_CLOSE - TICK);
        check(rig.link.isOpenTo(A), "open just before two idle hours");
        rig.idle(TICK);
        check(!rig.link.isOpenTo(A) && rig.a.open == 0, "closed after two idle hours");
        rig.link.send(A, bill(3, 400));
        check(rig.a.connects == 2, "the next bill connects again");
    }

    static void keepAliveDoesNotCountAsUse() throws Exception {
        Rig rig = new Rig();
        rig.link.send(A, bill(4, 400));
        rig.idle(IDLE_CLOSE + 10 * TICK);
        check(rig.a.open == 0, "keep-alive bytes do not hold the connection open forever");
    }

    static void printerSwitchedOffWhileIdle() throws Exception {
        Rig rig = new Rig();
        rig.link.send(A, bill(5, 400));
        rig.idle(10 * 60_000);
        rig.a.switchOff(false);
        rig.idle(KEEP_ALIVE + TICK);
        check(rig.a.open == 0, "a keep-alive notices the printer went away and closes the connection");
        try {
            rig.link.send(A, bill(6, 400));
            check(false, "printing to a switched-off printer fails");
        } catch (IOException expected) {
            check(rig.a.open == 0, "a failed print leaves no connection open");
        }
        rig.a.switchOn();
        byte[] job = bill(8, 900);
        int before = rig.a.received.size();
        rig.link.send(A, job);
        byte[] got = Arrays.copyOfRange(rig.a.received.toByteArray(), before, rig.a.received.size());
        checkStream(got, List.of(job), "after switching back on");
    }

    static void deadKeptLinkReconnectsOnce() throws Exception {
        Rig rig = new Rig();
        rig.link.send(A, bill(9, 400));
        rig.a.switchOff(false);
        rig.a.switchOn();
        byte[] job = bill(10, 2000);
        int before = rig.a.received.size();
        rig.link.send(A, job);
        check(rig.a.connects == 2, "a kept link that died is replaced once");
        byte[] got = Arrays.copyOfRange(rig.a.received.toByteArray(), before, rig.a.received.size());
        checkStream(got, List.of(job), "reconnected job");
        check(got.length == job.length + TAIL, "the bill prints exactly once");
    }

    static void androidReportsDisconnect() throws Exception {
        Rig rig = new Rig();
        rig.link.send(A, bill(11, 400));
        rig.link.dropped(B);
        check(rig.link.isOpenTo(A), "another device's disconnect is ignored");
        rig.link.dropped(A.toLowerCase());
        check(rig.a.open == 0 && !rig.link.isOpenTo(A), "the printer's disconnect closes the connection");
        rig.link.dropped(A);
        rig.link.send(A, bill(12, 400));
        check(rig.a.connects == 2, "the next bill connects again");
    }

    static void freshConnectionFailureIsReported() throws Exception {
        Rig rig = new Rig();
        rig.a.on = false;
        try {
            rig.link.send(A, bill(13, 400));
            check(false, "a printer that is off is reported");
        } catch (IOException expected) {
            check(rig.a.failedConnects == 1, "a fresh connection is tried once, not retried");
        }
    }

    static void switchingPrinters() throws Exception {
        Rig rig = new Rig();
        rig.link.send(A, bill(14, 400));
        rig.link.send(B, bill(15, 400));
        check(rig.a.open == 0 && rig.b.open == 1, "switching printers closes the first connection");
        rig.link.send(A, bill(16, 400));
        check(rig.a.open == 1 && rig.b.open == 0, "and switching back closes the second");
    }

    static void interruptedJobClosesTheConnection() throws Exception {
        Rig rig = new Rig();
        BluetoothLink link = new BluetoothLink(
            address -> rig.a.connect(),
            new BluetoothLink.Clock() {
                int sleeps;

                @Override
                public long nowMs() {
                    return rig.clock.now;
                }

                @Override
                public void sleep(long ms) throws InterruptedException {
                    if (++sleeps == 3) throw new InterruptedException();
                }
            },
            step -> {},
            CHUNK, PAUSE, TAIL, IDLE_CLOSE, KEEP_ALIVE);
        try {
            link.send(A, bill(17, 4000));
            check(false, "an interrupted job is reported");
        } catch (InterruptedException expected) {
            check(rig.a.open == 0, "a half-sent job does not leave its connection for the next bill");
        }
    }

    /**
     * Shifts of many hours with random bills, switch-offs (some only noticed after the Bluetooth
     * supervision timeout), Android disconnect reports and printer swaps. Every bill that reports
     * success arrives whole, except one sent in the seconds before Android can know the link died.
     */
    static void soak(int seed, long hours) throws Exception {
        Rig rig = new Rig();
        Random random = new Random(seed);
        long end = rig.clock.now + hours * 60 * 60_000;
        int sent = 0;
        int failed = 0;
        int lostInWindow = 0;
        List<byte[]> deliveredA = new ArrayList<>();
        while (rig.clock.now < end) {
            int event = random.nextInt(100);
            FakePrinter target = random.nextInt(20) == 0 ? rig.b : rig.a;
            if (event < 70) {
                byte[] job = bill(random.nextInt(), 200 + random.nextInt(6000));
                FakeLink before = target.current;
                int lostBefore = before == null ? 0 : before.lostBytes;
                boolean inSilentWindow = before != null && rig.clock.now >= before.deadFrom && rig.clock.now < before.writesAcceptedUntil;
                int receivedBefore = target.received.size();
                try {
                    rig.link.send(target.address, job);
                    sent++;
                    if (before != null && before.lostBytes > lostBefore) {
                        check(inSilentWindow, "seed " + seed + ": a bill was lost outside the silent window");
                        lostInWindow++;
                    } else if (target == rig.a) {
                        byte[] got = Arrays.copyOfRange(target.received.toByteArray(), receivedBefore, target.received.size());
                        checkStream(got, List.of(job), "seed " + seed + " bill " + sent);
                        deliveredA.add(job);
                    }
                } catch (IOException e) {
                    failed++;
                    check(!target.on, "seed " + seed + ": a print failed while the printer was on (" + e.getMessage() + ")");
                    check(!rig.link.isOpenTo(target.address), "seed " + seed + ": a failed print left a connection");
                }
            } else if (event < 78) {
                target.switchOff(random.nextBoolean());
            } else if (event < 90) {
                target.switchOn();
            } else if (event < 95) {
                if (target.current != null && target.current.deadFrom <= rig.clock.now) {
                    rig.link.dropped(target.address);
                }
            } else {
                rig.idle(random.nextInt(3) * 60 * 60_000L);
            }
            rig.idle(random.nextInt(40 * 60_000));
            check(rig.a.open + rig.b.open <= 1, "seed " + seed + ": more than one connection is open");
            check(rig.a.maxOpen <= 1 && rig.b.maxOpen <= 1, "seed " + seed + ": a connection leaked");
        }
        rig.idle(IDLE_CLOSE + TICK);
        check(rig.a.open + rig.b.open == 0, "seed " + seed + ": the connection closes once the shift is over");
        totals[0] += sent;
        totals[1] += failed;
        totals[2] += lostInWindow;
        totals[3] += rig.a.connects + rig.b.connects;
    }

    static final long[] totals = new long[4];

    public static void main(String[] args) throws Exception {
        oneJob();
        busyShiftReusesOneConnection();
        keepAliveSendsOnlyNulWhileIdle();
        idleCloseAfterTwoHours();
        keepAliveDoesNotCountAsUse();
        printerSwitchedOffWhileIdle();
        deadKeptLinkReconnectsOnce();
        androidReportsDisconnect();
        freshConnectionFailureIsReported();
        switchingPrinters();
        interruptedJobClosesTheConnection();
        int seeds = 300;
        long hours = 16;
        for (int seed = 0; seed < seeds; seed++) soak(seed, hours);
        System.out.println("bluetooth-link: " + checks + " checks passed; soak " + seeds + " shifts x " + hours
            + " h: " + totals[0] + " bills printed, " + totals[1] + " refused while the printer was off, "
            + totals[2] + " lost in the seconds before Android noticed a silent drop, " + totals[3] + " connections");
    }
}

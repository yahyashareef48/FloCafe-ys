package com.albaik.pos;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.net.nsd.NsdManager;
import android.net.nsd.NsdServiceInfo;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.util.Log;

import org.json.JSONObject;


/**
 * Keeps the POS, KDS and Server App servers running with the screen off: a
 * foreground service holding a partial wake lock and Wi-Fi locks.
 */
public class NodeService extends Service {
    private static final String TAG = "AlBaikService";
    private static final String CHANNEL = "server";
    private static final int NOTIFICATION_ID = 1;

    private PowerManager.WakeLock wakeLock;
    private WifiManager.WifiLock wifiLock;
    private WifiManager.MulticastLock multicastLock;
    private final ShellBridge.Listener restartWhenUnattended = (state, info, error) -> {
        // Node cannot restart inside the same process. With nobody at the tablet, end the
        // process so Android restarts this sticky service and the servers come back.
        if (state == ShellBridge.State.EXITED && !MainActivity.inForeground) {
            Log.e(TAG, "POS server stopped while unattended; restarting the process");
            android.os.Process.killProcess(android.os.Process.myPid());
        }
    };
    private boolean listening;
    private PrinterHub printers;
    private RasterSurface raster;
    private NsdManager.RegistrationListener advertisement;
    private final ShellBridge.Listener advertiseWhenReady = (state, info, error) -> {
        if (state == ShellBridge.State.READY && info != null) advertise(info);
    };

    static void start(Context context) {
        Intent intent = new Intent(context, NodeService.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent);
        else context.startService(intent);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        startForegroundWithNotification();
        // Screen devices run no server, even if Android restarts this service after the role changed.
        if (AppMode.mode(this) != AppMode.Mode.MAIN) {
            stopSelf();
            return START_NOT_STICKY;
        }
        acquireLocks();
        if (!listening) {
            listening = true;
            ShellBridge.get().addListener(restartWhenUnattended);
            // Printing runs here, not in the activity, so KOTs print with the screen off.
            printers = new PrinterHub(this);
            printers.register(ShellBridge.get());
            raster = new RasterSurface(this);
            raster.register(ShellBridge.get());
            ShellBridge.get().addListener(advertiseWhenReady);
        }
        try {
            ShellBridge.get().start();
            NodeRuntime.startOnce(this, ShellBridge.get());
        } catch (Exception e) {
            Log.e(TAG, "Could not start the POS server", e);
            ShellBridge.get().onNodeStartFailed("Could not start the POS server: " + e.getMessage());
        }
        return START_STICKY;
    }

    private void startForegroundWithNotification() {
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            manager.createNotificationChannel(new NotificationChannel(CHANNEL, getString(R.string.notification_channel), NotificationManager.IMPORTANCE_LOW));
        }
        PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class),
            PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? new Notification.Builder(this, CHANNEL)
            : new Notification.Builder(this);
        Notification notification = builder
            .setContentTitle(getString(R.string.notification_title))
            .setContentText(getString(R.string.notification_text))
            .setSmallIcon(R.drawable.ic_stat_server)
            .setContentIntent(open)
            .setOngoing(true)
            .build();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
    }

    private void acquireLocks() {
        if (wakeLock != null) return;
        wakeLock = getSystemService(PowerManager.class).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "albaikpos:server");
        wakeLock.setReferenceCounted(false);
        wakeLock.acquire();
        WifiManager wifi = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
        int mode = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
            ? WifiManager.WIFI_MODE_FULL_LOW_LATENCY
            : WifiManager.WIFI_MODE_FULL_HIGH_PERF;
        wifiLock = wifi.createWifiLock(mode, "albaikpos:server");
        wifiLock.setReferenceCounted(false);
        wifiLock.acquire();
        multicastLock = wifi.createMulticastLock("albaikpos:mdns");
        multicastLock.setReferenceCounted(false);
        multicastLock.acquire();
    }

    @Override
    public void onDestroy() {
        // Ask the backend to drain and close the database; SQLite's WAL keeps data safe if the process dies first.
        if (ShellBridge.get().state() == ShellBridge.State.READY) {
            ShellBridge.get().callNode("shutdown", new JSONObject(), new ShellBridge.Reply() {
                @Override
                public void success(Object result) {}

                @Override
                public void error(String message) {
                    Log.w(TAG, "Backend shutdown failed: " + message);
                }
            });
        }
        ShellBridge.get().removeListener(restartWhenUnattended);
        ShellBridge.get().removeListener(advertiseWhenReady);
        if (advertisement != null) {
            try {
                getSystemService(NsdManager.class).unregisterService(advertisement);
            } catch (IllegalArgumentException ignored) {
                // Never registered.
            }
        }
        if (multicastLock != null) multicastLock.release();
        if (wifiLock != null) wifiLock.release();
        if (wakeLock != null) wakeLock.release();
        super.onDestroy();
    }

    /** Advertises the POS like the Windows app does, so Screen devices find this tablet by themselves. */
    private void advertise(org.json.JSONObject info) {
        if (advertisement != null) return;
        NsdServiceInfo service = new NsdServiceInfo();
        service.setServiceName(ServerDiscovery.SERVICE_NAME);
        service.setServiceType(ServerDiscovery.SERVICE_TYPE);
        service.setPort(info.optInt("serverPort", 3001));
        try {
            service.setAttribute("version", getPackageManager().getPackageInfo(getPackageName(), 0).versionName);
        } catch (Exception ignored) {
            // The version is informational.
        }
        service.setAttribute("kds", "/kds");
        service.setAttribute("kds_port", String.valueOf(info.optInt("kdsPort", 3002)));
        service.setAttribute("server_app", "/server-standalone");
        service.setAttribute("server_app_port", String.valueOf(info.optInt("serverAppPort", 3003)));
        advertisement = new NsdManager.RegistrationListener() {
            @Override
            public void onRegistrationFailed(NsdServiceInfo serviceInfo, int errorCode) {
                Log.w(TAG, "Could not advertise the POS on the network: " + errorCode);
            }

            @Override
            public void onUnregistrationFailed(NsdServiceInfo serviceInfo, int errorCode) {}

            @Override
            public void onServiceRegistered(NsdServiceInfo serviceInfo) {
                Log.i(TAG, "Advertising the POS as " + serviceInfo.getServiceName());
            }

            @Override
            public void onServiceUnregistered(NsdServiceInfo serviceInfo) {}
        };
        getSystemService(NsdManager.class).registerService(service, NsdManager.PROTOCOL_DNS_SD, advertisement);
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}

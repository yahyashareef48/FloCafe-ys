package com.albaik.pos;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Starts the POS server after a reboot or an app update, so other devices reconnect on their own. */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent.getAction();
        boolean relevant = Intent.ACTION_BOOT_COMPLETED.equals(action) || Intent.ACTION_MY_PACKAGE_REPLACED.equals(action);
        // Screen devices run no server.
        if (relevant && AppMode.mode(context) == AppMode.Mode.MAIN) {
            NodeService.start(context);
        }
    }
}

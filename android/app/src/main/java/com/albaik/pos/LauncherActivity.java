package com.albaik.pos;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;

/** App icon entry point: opens the setup on first launch, otherwise this device's screen. */
public class LauncherActivity extends Activity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // Lets automated tests configure a Screen ("ROLE,host,port"); release builds ignore it.
        String debugScreen = BuildConfig.DEBUG ? getIntent().getStringExtra("albaik.debug.screen") : null;
        String[] parts = debugScreen == null ? new String[0] : debugScreen.split(",");
        if (parts.length == 3) {
            stopService(new Intent(this, NodeService.class));
            AppMode.setScreen(this, AppMode.Role.valueOf(parts[0]), parts[1], Integer.parseInt(parts[2]), "");
        }
        Class<?> target;
        switch (AppMode.mode(this)) {
            case MAIN:
                target = MainActivity.class;
                break;
            case SCREEN:
                target = ScreenActivity.class;
                break;
            default:
                target = SetupActivity.class;
        }
        startActivity(new Intent(this, target).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP));
        finish();
    }
}

package com.albaik.pos;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;

/** App icon entry point: opens the setup on first launch, otherwise this device's screen. */
public class LauncherActivity extends Activity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
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

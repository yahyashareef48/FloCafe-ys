package com.albaik.pos.spike;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.WindowManager;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.net.HttpURLConnection;
import java.net.URL;

public class MainActivity extends Activity {
    private static final String POS_URL = "http://127.0.0.1:3001/";
    private WebView web;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        if (Build.VERSION.SDK_INT >= 33) requestPermissions(new String[] {Manifest.permission.POST_NOTIFICATIONS}, 1);

        Intent service = new Intent(this, NodeService.class);
        if (Build.VERSION.SDK_INT >= 26) startForegroundService(service); else startService(service);

        web = new WebView(this);
        web.getSettings().setJavaScriptEnabled(true);
        web.getSettings().setDomStorageEnabled(true);
        web.setWebViewClient(new WebViewClient());
        web.loadData("<h2 style='font-family:sans-serif'>Starting Al Baik POS server…</h2>", "text/html", "utf-8");
        setContentView(web);
        waitForServer();
    }

    private void waitForServer() {
        new Thread(() -> {
            for (int i = 0; i < 600; i++) {
                try {
                    HttpURLConnection c = (HttpURLConnection) new URL(POS_URL + "api/health").openConnection();
                    c.setConnectTimeout(1000);
                    if (c.getResponseCode() == 200) {
                        new Handler(Looper.getMainLooper()).post(() -> web.loadUrl(POS_URL));
                        return;
                    }
                } catch (Exception ignored) {
                }
                try { Thread.sleep(1000); } catch (InterruptedException e) { return; }
            }
        }).start();
    }
}

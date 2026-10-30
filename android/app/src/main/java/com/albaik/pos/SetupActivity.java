package com.albaik.pos;

import android.app.AlertDialog;
import android.content.Intent;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Bundle;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import androidx.activity.ComponentActivity;
import androidx.activity.result.ActivityResultLauncher;

import com.journeyapps.barcodescanner.ScanContract;
import com.journeyapps.barcodescanner.ScanOptions;

import java.util.HashSet;
import java.util.Set;

/**
 * First-launch choice between "Main tablet" and "Screen", and for a Screen,
 * what it shows and how it finds the main device: discovery, QR code, or IP.
 * Also reachable later from the app icon's "Change device role" shortcut.
 */
public class SetupActivity extends ComponentActivity {
    private LinearLayout content;
    private AppMode.Role role;
    private ServerDiscovery discovery;
    private LinearLayout foundList;
    private final Set<String> foundHosts = new HashSet<>();

    private final ActivityResultLauncher<ScanOptions> qrScanner = registerForActivityResult(new ScanContract(), result -> {
        if (result.getContents() != null) connectToUrl(result.getContents());
    });

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        ScrollView scroll = new ScrollView(this);
        content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        content.setPadding(dp(32), dp(32), dp(32), dp(32));
        content.setGravity(Gravity.CENTER_HORIZONTAL);
        scroll.addView(content);
        setContentView(scroll);
        showModeChoice();
    }

    @Override
    protected void onDestroy() {
        if (discovery != null) discovery.stop();
        super.onDestroy();
    }

    // ---- Steps -----------------------------------------------------------------

    private void showModeChoice() {
        content.removeAllViews();
        title(getString(R.string.setup_title));
        option(getString(R.string.setup_main), getString(R.string.setup_main_detail), v -> chooseMain());
        option(getString(R.string.setup_screen), getString(R.string.setup_screen_detail), v -> showRoleChoice());
    }

    private void chooseMain() {
        AppMode.setMain(this);
        startActivity(new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TASK | Intent.FLAG_ACTIVITY_NEW_TASK));
        finish();
    }

    private void showRoleChoice() {
        content.removeAllViews();
        title(getString(R.string.setup_role_title));
        option(getString(R.string.role_waiter), getString(R.string.role_waiter_detail), v -> showFindMain(AppMode.Role.WAITER));
        option(getString(R.string.role_kitchen), getString(R.string.role_kitchen_detail), v -> showFindMain(AppMode.Role.KITCHEN));
        option(getString(R.string.role_pos), getString(R.string.role_pos_detail), v -> showFindMain(AppMode.Role.POS));
        back(v -> showModeChoice());
    }

    private void showFindMain(AppMode.Role chosen) {
        role = chosen;
        content.removeAllViews();
        title(getString(R.string.setup_find_title));
        text(getString(R.string.setup_searching), 16, false);
        foundList = new LinearLayout(this);
        foundList.setOrientation(LinearLayout.VERTICAL);
        content.addView(foundList);
        foundHosts.clear();
        if (discovery == null) discovery = new ServerDiscovery(this);
        discovery.start(server -> {
            if (!foundHosts.add(server.host)) return;
            option(server.name + " - " + server.host, getString(R.string.setup_found_detail),
                v -> connect(server.host, server.portFor(role), server.name), foundList);
        });

        option(getString(R.string.setup_scan_qr), getString(R.string.setup_scan_qr_detail), v -> {
            ScanOptions options = new ScanOptions();
            options.setDesiredBarcodeFormats(ScanOptions.QR_CODE);
            options.setPrompt(getString(R.string.setup_scan_prompt));
            options.setBeepEnabled(false);
            options.setOrientationLocked(false);
            qrScanner.launch(options);
        });

        EditText address = new EditText(this);
        address.setHint(R.string.setup_ip_hint);
        address.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        address.setSingleLine(true);
        content.addView(address, matchWidth(dp(16)));
        option(getString(R.string.setup_connect), null, v -> {
            String typed = address.getText().toString().trim();
            if (!typed.isEmpty()) connectToUrl(typed.contains("://") ? typed : "http://" + typed);
        });
        back(v -> {
            discovery.stop();
            showRoleChoice();
        });
    }

    // ---- Connecting -------------------------------------------------------------

    /**
     * Accepts any of the POS's QR links (http://IP:port/...) or a typed address. Only the host is
     * used; the port is the chosen role's standard port, so a POS or KDS QR code works for any role.
     */
    private void connectToUrl(String raw) {
        Uri uri = Uri.parse(raw.trim());
        String host = uri.getHost();
        if (host == null || host.isEmpty()) {
            Toast.makeText(this, R.string.setup_bad_address, Toast.LENGTH_LONG).show();
            return;
        }
        connect(host, role.defaultPort, "");
    }

    private void connect(String host, int port, String serviceName) {
        String url = "http://" + host + ":" + port + role.path;
        Toast.makeText(this, getString(R.string.setup_checking, host), Toast.LENGTH_SHORT).show();
        new Thread(() -> {
            boolean ok = ServerDiscovery.reachable(url);
            runOnUiThread(() -> {
                if (!ok) {
                    new AlertDialog.Builder(this)
                        .setTitle(R.string.setup_unreachable_title)
                        .setMessage(getString(R.string.setup_unreachable_detail, url))
                        .setPositiveButton(android.R.string.ok, null)
                        .show();
                    return;
                }
                if (discovery != null) discovery.stop();
                // A device switching from Main to Screen stops its own servers; its data stays on the device.
                AppMode.becomeScreen(this, role, host, port, serviceName);
            });
        }).start();
    }

    // ---- Views ------------------------------------------------------------------

    private void title(String value) {
        text(value, 26, true);
    }

    private void text(String value, int sizeSp, boolean bold) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextSize(sizeSp);
        view.setTextColor(0xFF222222);
        if (bold) view.setTypeface(Typeface.DEFAULT_BOLD);
        view.setGravity(Gravity.CENTER);
        content.addView(view, matchWidth(dp(16)));
    }

    private void option(String label, String detail, View.OnClickListener onClick) {
        option(label, detail, onClick, content);
    }

    private void option(String label, String detail, View.OnClickListener onClick, LinearLayout parent) {
        Button button = new Button(this);
        button.setAllCaps(false);
        button.setTextSize(18);
        button.setText(detail == null ? label : label + "\n" + detail);
        button.setPadding(dp(16), dp(16), dp(16), dp(16));
        button.setOnClickListener(onClick);
        parent.addView(button, matchWidth(dp(12)));
    }

    private void back(View.OnClickListener onClick) {
        Button button = new Button(this);
        button.setText(R.string.setup_back);
        button.setOnClickListener(onClick);
        content.addView(button, matchWidth(dp(24)));
    }

    private LinearLayout.LayoutParams matchWidth(int topMargin) {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        params.topMargin = topMargin;
        return params;
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }
}

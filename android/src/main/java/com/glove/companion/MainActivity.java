package com.glove.companion;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.app.NotificationManager;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.provider.Settings;
import android.text.InputFilter;
import android.view.View;
import android.view.WindowInsets;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONObject;

public final class MainActivity extends Activity {
    private static final int CAMERA_REQUEST = 1;
    private static final int SCAN_REQUEST = 2;
    private static final int INK = Color.rgb(20, 33, 59);
    private static final int MUTED = Color.rgb(78, 94, 121);
    private static final int BLUE = Color.rgb(33, 88, 220);
    private static final int BACKGROUND = Color.rgb(244, 247, 253);
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final SharedPreferences.OnSharedPreferenceChangeListener changes = (preferences, key) -> render();
    private CompanionStore store;
    private PeerConnection.Invitation invitation;
    private String ticket;
    private String code;
    private String message = "";
    private int revision;
    private long deadline;
    private boolean busy;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        store = new CompanionStore(this);
        store.preferences.registerOnSharedPreferenceChangeListener(changes);
    }

    @Override public void onResume() {
        super.onResume();
        render();
    }

    @Override public void onDestroy() {
        cancelPendingPairing();
        store.preferences.unregisterOnSharedPreferenceChangeListener(changes);
        // A request may already have reached the PC. Its late response still needs to revoke its ticket.
        worker.shutdown();
        super.onDestroy();
    }

    private void render() {
        CompanionStore.Pair pair = store.pair();
        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        scroll.setBackgroundColor(BACKGROUND);
        scroll.setOnApplyWindowInsetsListener((view, insets) -> {
            android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            return WindowInsets.CONSUMED;
        });
        LinearLayout content = column();
        content.setPadding(dp(22), dp(24), dp(22), dp(24));
        scroll.addView(content);

        LinearLayout header = new LinearLayout(this);
        header.setGravity(android.view.Gravity.CENTER_VERTICAL);
        android.widget.ImageView mark = new android.widget.ImageView(this);
        mark.setImageResource(R.drawable.glove_icon);
        mark.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        header.addView(mark, new LinearLayout.LayoutParams(dp(42), dp(42)));
        TextView brand = label("Glove Companion", 19, INK, true);
        LinearLayout.LayoutParams brandPosition = new LinearLayout.LayoutParams(-2, -2);
        brandPosition.setMarginStart(dp(10));
        header.addView(brand, brandPosition);
        add(content, header, 0);

        if (pair != null) {
            showPaired(content, pair);
        } else {
            showPairing(content);
        }
        if (!message.isEmpty()) {
            TextView status = label(message, 15, INK, false);
            status.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
            add(content, status, 14);
        }
        setContentView(scroll);
        scroll.requestApplyInsets();
    }

    private void showPairing(LinearLayout content) {
        add(content, label("Connect to Windows", 30, INK, true), 22);
        add(content, label("Keep this phone and your PC on the same private Wi-Fi network.", 16, MUTED, false), 8);
        LinearLayout card = card();
        add(content, card, 18);
        if (code != null) {
            add(card, label("Approve on your PC", 20, INK, true), 0);
            add(card, label("Check that Glove on Windows shows this same code before you approve.", 16, MUTED, false), 8);
            TextView value = label(code, 32, BLUE, true);
            value.setTypeface(Typeface.MONOSPACE, Typeface.BOLD);
            add(card, value, 12);
            add(card, button("Cancel pairing", false, this::cancelPairing), 12);
        } else if (invitation != null) {
            add(card, label("Pair with " + invitation.peer.address + "?", 20, INK, true), 0);
            add(card, label("Glove will request approval from the PC that displayed this pairing code.", 16, MUTED, false), 8);
            Button pair = button(busy ? "Contacting Windows…" : "Pair with this PC", true, this::beginPairing);
            pair.setEnabled(!busy);
            add(card, pair, 16);
            add(card, button("Cancel pairing", false, this::cancelPairing), 6);
        } else {
            add(card, label("Pair with a QR code", 20, INK, true), 0);
            add(card, label("In Glove on your PC, open Personal and choose Pair Android. Scan the code here.", 16, MUTED, false), 8);
            add(card, button("Scan Windows QR", true, this::requestScanner), 16);
            add(card, button("Enter pairing details", false, this::enterDetails), 6);
        }
    }

    private void showPaired(LinearLayout content, CompanionStore.Pair pair) {
        add(content, label("Your Windows connection", 29, INK, true), 22);
        add(content, label("Paired to " + pair.peer.address, 16, MUTED, false), 8);
        LinearLayout card = card();
        add(content, card, 18);
        add(card, label("Notifications and replies", 20, INK, true), 0);
        if (!listenerAllowed()) {
            add(card, label("Allow notification access in Android, then choose the apps you want to see in Windows.", 16, MUTED, false), 8);
            add(card, button("Allow notification access", true, this::openNotificationSettings), 16);
        } else {
            Set<String> apps = store.apps();
            String status = store.paused() ? "Sharing is paused on this phone."
                : apps.isEmpty() ? "Choose which apps can share notifications."
                : "Sharing from " + apps.size() + (apps.size() == 1 ? " app." : " apps.")
                    + " Phone lock hides previews and stops replies.";
            add(card, label(status, 16, MUTED, false), 8);
            add(card, button("Choose apps", true, () -> chooseApps(pair)), 16);
            add(card, button(store.paused() ? "Resume sharing" : "Pause sharing", false,
                () -> store.pause(!store.paused())), 6);
            add(card, button("Manage notification access", false, this::openNotificationSettings), 6);
        }
        add(content, button("Forget this PC", false, () -> forgetPc(pair)), 12);
    }

    private boolean listenerAllowed() {
        return getSystemService(NotificationManager.class)
            .isNotificationListenerAccessGranted(GloveNotificationListener.component(this));
    }

    private void openNotificationSettings() {
        Intent intent = new Intent(Settings.ACTION_NOTIFICATION_LISTENER_DETAIL_SETTINGS)
            .putExtra(Settings.EXTRA_NOTIFICATION_LISTENER_COMPONENT_NAME,
                GloveNotificationListener.component(this).flattenToString());
        try {
            startActivity(intent);
        } catch (android.content.ActivityNotFoundException unavailable) {
            try {
                startActivity(new Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS));
            } catch (android.content.ActivityNotFoundException missing) {
                message = "Open Android Settings and search for Notification access.";
                render();
            }
        }
    }

    private void chooseApps(CompanionStore.Pair pair) {
        Intent launcher = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER);
        PackageManager manager = getPackageManager();
        Map<String, String> appNames = new HashMap<>();
        for (ResolveInfo info : manager.queryIntentActivities(launcher, 0)) {
            String name = info.activityInfo.packageName;
            if (!getPackageName().equals(name)) appNames.put(name, info.loadLabel(manager).toString());
        }
        List<Map.Entry<String, String>> apps = new ArrayList<>(appNames.entrySet());
        apps.sort(Comparator.comparing(Map.Entry<String, String>::getValue, String.CASE_INSENSITIVE_ORDER)
            .thenComparing(Map.Entry::getKey));
        if (apps.isEmpty()) {
            message = "No launchable apps were found on this phone.";
            render();
            return;
        }
        Set<String> selected = new HashSet<>(store.apps());
        String[] labels = new String[apps.size()];
        boolean[] checked = new boolean[apps.size()];
        Map<String, Integer> labelCounts = new HashMap<>();
        for (Map.Entry<String, String> app : apps) labelCounts.merge(app.getValue(), 1, Integer::sum);
        for (int i = 0; i < apps.size(); i++) {
            Map.Entry<String, String> app = apps.get(i);
            labels[i] = labelCounts.get(app.getValue()) > 1
                ? app.getValue() + " (" + app.getKey() + ")" : app.getValue();
            checked[i] = selected.contains(app.getKey());
        }
        new AlertDialog.Builder(this).setTitle("Choose apps")
            .setMultiChoiceItems(labels, checked, (dialog, index, enabled) -> {
                String app = apps.get(index).getKey();
                if (enabled) selected.add(app);
                else selected.remove(app);
            })
            .setNegativeButton("Cancel", null)
            .setPositiveButton("Save", (dialog, which) -> {
                if (store.matches(pair)) store.apps(selected);
            })
            .show();
    }

    private void forgetPc(CompanionStore.Pair pair) {
        new AlertDialog.Builder(this).setTitle("Forget this PC?")
            .setMessage("Glove will stop sharing notifications with this Windows pairing. You can pair again with a new QR code.")
            .setNegativeButton("Cancel", null)
            .setPositiveButton("Forget PC", (dialog, which) -> {
                message = "Pairing removed.";
                if (store.matches(pair)) store.forget();
                pair.peer.revoke(pair.ticket);
            }).show();
    }

    private void requestScanner() {
        if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            openScanner();
        } else {
            requestPermissions(new String[] {Manifest.permission.CAMERA}, CAMERA_REQUEST);
        }
    }

    @Override public void onRequestPermissionsResult(int request, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(request, permissions, results);
        if (request != CAMERA_REQUEST) return;
        if (results.length != 0 && results[0] == PackageManager.PERMISSION_GRANTED) openScanner();
        else {
            message = "Camera access is needed to scan. You can enter pairing details instead.";
            render();
        }
    }

    private void openScanner() {
        startActivityForResult(new Intent(this, ScanActivity.class), SCAN_REQUEST);
    }

    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request == SCAN_REQUEST && result == RESULT_OK && data != null) {
            acceptDetails(data.getStringExtra(ScanActivity.QR_TEXT));
        }
    }

    private void enterDetails() {
        EditText input = new EditText(this);
        input.setHint("Pairing details from Glove for Windows");
        input.setFilters(new InputFilter[] {new InputFilter.LengthFilter(512)});
        input.setInputType(android.text.InputType.TYPE_CLASS_TEXT
            | android.text.InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
            | android.text.InputType.TYPE_TEXT_FLAG_MULTI_LINE);
        input.setMinLines(3);
        input.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO);
        LinearLayout container = column();
        container.setPadding(dp(20), dp(8), dp(20), 0);
        container.addView(input);
        new AlertDialog.Builder(this).setTitle("Enter pairing details")
            .setView(container)
            .setNegativeButton("Cancel", null)
            .setPositiveButton("Continue", (dialog, which) -> acceptDetails(input.getText().toString()))
            .show();
    }

    private void acceptDetails(String text) {
        if (text == null || store.pair() != null) return;
        try {
            invitation = PeerConnection.Invitation.parse(text.trim());
            message = "";
        } catch (Exception error) {
            message = "That code does not look like a Glove Windows pairing code. Generate a fresh code on the PC.";
        }
        render();
    }

    private void beginPairing() {
        if (busy || invitation == null) return;
        PeerConnection.Invitation target = invitation;
        busy = true;
        message = "";
        render();
        int attempt = ++revision;
        worker.execute(() -> {
            try {
                String phone = (Build.MANUFACTURER + " " + Build.MODEL).replace("\0", "").trim();
                if (phone.length() > 80) {
                    phone = phone.substring(0, Character.isHighSurrogate(phone.charAt(79)) ? 79 : 80);
                }
                JSONObject response = target.peer.post("/v1/pair/request", target.token,
                    new JSONObject().put("name", phone));
                String requestedTicket = PeerConnection.credential(response.getString("ticket"));
                String requestedCode = response.optString("code");
                if (!requestedCode.matches("[0-9]{6}")) {
                    target.peer.revoke(requestedTicket);
                    throw new IllegalArgumentException("Invalid code");
                }
                main.post(() -> {
                    if (revision != attempt) {
                        target.peer.revoke(requestedTicket);
                        return;
                    }
                    ticket = requestedTicket;
                    code = requestedCode;
                    deadline = SystemClock.elapsedRealtime() + 90_000;
                    render();
                    poll(attempt);
                });
            } catch (Exception error) {
                main.post(() -> fail(attempt, pairingError(error)));
            }
        });
    }

    private void poll(int attempt) {
        if (attempt != revision || ticket == null || invitation == null) return;
        if (SystemClock.elapsedRealtime() >= deadline) {
            fail(attempt, "Pairing expired. Create a fresh code in Glove on Windows.");
            return;
        }
        CompanionStore.Pair request = new CompanionStore.Pair(invitation.peer, ticket);
        worker.execute(() -> {
            try {
                String state = request.peer.post("/v1/pair/status", request.ticket, new JSONObject()).getString("state");
                main.post(() -> {
                    if (attempt != revision) return;
                    if (SystemClock.elapsedRealtime() >= deadline) {
                        fail(attempt, "Pairing expired. Create a fresh code in Glove on Windows.");
                        return;
                    }
                    switch (state) {
                        case "pending" -> main.postDelayed(() -> poll(attempt), 900);
                        case "paired" -> finishPairing(attempt, request);
                        default -> fail(attempt, "The PC declined or expired this pairing. Start again from Windows.");
                    }
                });
            } catch (PeerConnection.StatusException error) {
                main.post(() -> fail(attempt, pairingError(error)));
            } catch (Exception error) {
                main.postDelayed(() -> poll(attempt), 1_500);
            }
        });
    }

    private void finishPairing(int attempt, CompanionStore.Pair pair) {
        if (store.pair() != null) {
            fail(attempt, "This phone is already paired. Forget its current PC before pairing again.");
            return;
        }
        try {
            store.pair(pair);
            resetPairing();
            message = "";
            render();
        } catch (Exception error) {
            fail(attempt, "Android could not save this pairing. Forget the phone in Glove on Windows and try again.");
        }
    }

    private String pairingError(Exception error) {
        if (error instanceof PeerConnection.StatusException status) {
            if (status.status == 401 || status.status == 403 || status.status == 410) {
                return "The Windows code is no longer valid. Generate a fresh code on your PC.";
            }
            if (status.status == 409) return "Check the pending pairing in Glove on Windows.";
        }
        if (error instanceof javax.net.ssl.SSLException) {
            return "The PC’s secure connection could not be verified. Scan a new code directly from your Windows app.";
        }
        return "Could not reach Glove. Check that both devices are on the same Wi-Fi and that Windows allows Glove on your private network.";
    }

    private void fail(int attempt, String feedback) {
        if (attempt != revision) return;
        cancelPendingPairing();
        message = feedback;
        render();
    }

    private void cancelPairing() {
        cancelPendingPairing();
        message = "";
        render();
    }

    private void resetPairing() {
        revision++;
        invitation = null;
        ticket = null;
        code = null;
        busy = false;
    }

    private void cancelPendingPairing() {
        PeerConnection.Invitation pending = invitation;
        String pendingTicket = ticket;
        resetPairing();
        if (pending != null && pendingTicket != null) pending.peer.revoke(pendingTicket);
    }

    private LinearLayout column() {
        LinearLayout view = new LinearLayout(this);
        view.setOrientation(LinearLayout.VERTICAL);
        return view;
    }

    private LinearLayout card() {
        LinearLayout view = column();
        GradientDrawable background = new GradientDrawable();
        background.setColor(Color.WHITE);
        background.setStroke(dp(1), Color.rgb(220, 228, 240));
        background.setCornerRadius(dp(16));
        view.setBackground(background);
        view.setPadding(dp(17), dp(17), dp(17), dp(17));
        return view;
    }

    private TextView label(String value, int size, int color, boolean bold) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextSize(size);
        view.setTextColor(color);
        if (bold) view.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        return view;
    }

    private Button button(String caption, boolean primary, Runnable action) {
        Button button = new Button(this);
        button.setText(caption);
        button.setAllCaps(false);
        button.setTextSize(15);
        button.setTextColor(primary ? Color.WHITE : INK);
        button.setBackgroundTintList(ColorStateList.valueOf(primary ? BLUE : BACKGROUND));
        button.setMinHeight(dp(48));
        button.setFilterTouchesWhenObscured(true);
        button.setOnClickListener(view -> action.run());
        return button;
    }

    private void add(LinearLayout parent, View view, int top) {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2);
        params.topMargin = dp(top);
        parent.addView(view, params);
    }

    private int dp(int pixels) {
        return Math.round(getResources().getDisplayMetrics().density * pixels);
    }
}

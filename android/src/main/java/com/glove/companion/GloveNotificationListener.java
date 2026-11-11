package com.glove.companion;

import android.app.KeyguardManager;
import android.app.Notification;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.RemoteInput;
import android.content.BroadcastReceiver;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Pattern;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

public final class GloveNotificationListener extends NotificationListenerService {
    private static final int INTERVAL = 2_500;
    private static final int MAX_BACKOFF = 20_000;
    private static final int MAX_NOTIFICATIONS = 50;
    private static final Pattern SENSITIVE_TEXT = Pattern.compile(
        "(?iu)\\b(?:otp|2fa|one[- ]time(?: password| passcode| code)?|verification code|"
        + "security code|authentication code|login code|sign[- ]in code|passcode|"
        + "do not share (?:this|the) code)\\b");
    private static final Pattern CODE_ONLY = Pattern.compile("^[0-9 -]{4,12}$");
    private static final Pattern CONTROL_TEXT = Pattern.compile("[\\p{Cc}&&[^\\n\\t]]");
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final Map<String, Entry> entries = new HashMap<>();
    private final LinkedHashSet<String> handledCommands = new LinkedHashSet<>();
    private final Runnable tick = this::sync;
    private CompanionStore store;
    private CompanionStore.Pair pair;
    private volatile long generation;
    private boolean connected;
    private boolean inFlight;
    private boolean sharingAllowed;
    private boolean pcPaused;
    private int delay = INTERVAL;
    private JSONObject result;
    private final SharedPreferences.OnSharedPreferenceChangeListener changes = (preferences, key) -> {
        generation++;
        if (CompanionStore.PAIR.equals(key)) {
            pair = store.pair();
            delay = INTERVAL;
            result = null;
            pcPaused = false;
            handledCommands.clear();
        }
        refresh();
        schedule(0);
    };
    private final BroadcastReceiver displayState = new BroadcastReceiver() {
        @Override public void onReceive(Context context, Intent intent) {
            if (!connected || pair == null) return;
            generation++;
            if (canShare() != sharingAllowed) refresh();
            schedule(0);
        }
    };
    static ComponentName component(android.content.Context context) {
        return new ComponentName(context, GloveNotificationListener.class);
    }

    @Override public void onCreate() {
        super.onCreate();
        store = new CompanionStore(this);
        store.preferences.registerOnSharedPreferenceChangeListener(changes);
        IntentFilter displayEvents = new IntentFilter(Intent.ACTION_SCREEN_OFF);
        displayEvents.addAction(Intent.ACTION_SCREEN_ON);
        displayEvents.addAction(Intent.ACTION_USER_PRESENT);
        if (Build.VERSION.SDK_INT >= 33) {
            registerReceiver(displayState, displayEvents, Context.RECEIVER_NOT_EXPORTED);
        } else {
            registerReceiver(displayState, displayEvents);
        }
    }

    @Override public void onListenerConnected() {
        connected = true;
        pair = store.pair();
        delay = INTERVAL;
        refresh();
        schedule(0);
    }

    @Override public void onListenerDisconnected() {
        disconnect();
    }

    @Override public void onDestroy() {
        disconnect();
        store.preferences.unregisterOnSharedPreferenceChangeListener(changes);
        unregisterReceiver(displayState);
        worker.shutdownNow();
        super.onDestroy();
    }

    private void disconnect() {
        generation++;
        connected = false;
        pair = null;
        sharingAllowed = false;
        pcPaused = false;
        entries.clear();
        result = null;
        handledCommands.clear();
        main.removeCallbacks(tick);
    }

    @Override public void onNotificationPosted(StatusBarNotification notification) {
        if (!canShare()) return;
        Entry entry = entry(notification);
        if (entry == null) entries.remove(notification.getKey());
        else entries.put(notification.getKey(), entry);
    }

    @Override public void onNotificationRemoved(StatusBarNotification notification) {
        entries.remove(notification.getKey());
    }

    private void refresh() {
        entries.clear();
        sharingAllowed = canShare();
        if (!sharingAllowed) return;
        StatusBarNotification[] active = activeNotifications(null);
        if (active == null) return;
        for (StatusBarNotification notification : active) {
            Entry entry = entry(notification);
            if (entry != null) entries.put(notification.getKey(), entry);
        }
    }

    private StatusBarNotification[] activeNotifications(String[] keys) {
        try {
            return keys == null ? getActiveNotifications() : getActiveNotifications(keys);
        } catch (SecurityException ignored) {
            // Android can revoke listener access while a refresh or reply is in progress.
            return null;
        }
    }

    private Entry entry(StatusBarNotification status) {
        String packageName = status.getPackageName();
        if (!store.apps().contains(packageName) || getPackageName().equals(packageName)) return null;
        Notification notification = status.getNotification();
        if (notification.visibility == Notification.VISIBILITY_SECRET
            || (notification.flags & (Notification.FLAG_GROUP_SUMMARY | Notification.FLAG_ONGOING_EVENT)) != 0) {
            return null;
        }
        Bundle extras = notification.extras;
        if (extras == null) return null;
        String title = text(extras.getCharSequence(Notification.EXTRA_TITLE), 160);
        String body = text(extras.getCharSequence(Notification.EXTRA_BIG_TEXT), 1200);
        if (body.isEmpty()) body = text(extras.getCharSequence(Notification.EXTRA_TEXT), 1200);
        if ((title.isEmpty() && body.isEmpty()) || sensitive(title, body)) return null;
        String label = packageName;
        PackageManager packages = getPackageManager();
        try {
            label = text(packages.getApplicationLabel(packages.getApplicationInfo(packageName, 0)), 160);
        } catch (PackageManager.NameNotFoundException ignored) {
            // The package can be uninstalled between the event and this lookup.
            return null;
        }
        return new Entry(UUID.randomUUID().toString(), status.getKey(), status.getPostTime(),
            title, body, label, replyAction(notification, packageName));
    }

    private static ReplyAction replyAction(Notification notification, String packageName) {
        if (notification.actions == null) return null;
        ReplyAction fallback = null;
        for (Notification.Action action : notification.actions) {
            if (action == null || action.actionIntent == null || action.getRemoteInputs() == null
                || !packageName.equals(action.actionIntent.getCreatorPackage())) continue;
            int semantic = action.getSemanticAction();
            if (semantic != Notification.Action.SEMANTIC_ACTION_REPLY
                && semantic != Notification.Action.SEMANTIC_ACTION_NONE) continue;
            if (Build.VERSION.SDK_INT >= 31 && (action.isAuthenticationRequired() || action.actionIntent.isImmutable())) {
                continue;
            }
            for (RemoteInput input : action.getRemoteInputs()) {
                if (input != null && input.getAllowFreeFormInput()) {
                    ReplyAction reply = new ReplyAction(action.actionIntent, input);
                    if (semantic == Notification.Action.SEMANTIC_ACTION_REPLY) return reply;
                    if (fallback == null) fallback = reply;
                    break;
                }
            }
        }
        return fallback;
    }

    private static boolean sensitive(String title, String body) {
        return SENSITIVE_TEXT.matcher(title + " " + body).find()
            || CODE_ONLY.matcher(body).matches() || (body.isEmpty() && CODE_ONLY.matcher(title).matches());
    }

    private static String text(CharSequence value, int limit) {
        if (value == null) return "";
        String clean = CONTROL_TEXT.matcher(value).replaceAll("").trim();
        if (clean.length() <= limit) return clean;
        int end = Character.isHighSurrogate(clean.charAt(limit - 1)) ? limit - 1 : limit;
        return clean.substring(0, end);
    }

    private boolean canShare() {
        if (!connected || pair == null || store.paused()) return false;
        KeyguardManager lock = getSystemService(KeyguardManager.class);
        PowerManager power = getSystemService(PowerManager.class);
        NotificationManager manager = getSystemService(NotificationManager.class);
        return power.isInteractive() && !lock.isKeyguardLocked()
            && manager.isNotificationListenerAccessGranted(component(this));
    }

    private void schedule(int delay) {
        main.removeCallbacks(tick);
        if (connected && pair != null && !inFlight) main.postDelayed(tick, delay);
    }

    private void sync() {
        CompanionStore.Pair current = pair;
        if (!connected || current == null || inFlight) return;
        if (canShare() != sharingAllowed) refresh();
        JSONObject request = new JSONObject();
        try {
            JSONArray notifications = new JSONArray();
            if (sharingAllowed && !pcPaused) {
                entries.values().stream().sorted(Comparator.comparingLong((Entry entry) -> entry.time).reversed())
                    .limit(MAX_NOTIFICATIONS).forEach(entry -> notifications.put(entry.json()));
            }
            request.put("access", sharingAllowed).put("notifications", notifications);
            if (result != null) request.put("result", result);
        } catch (JSONException impossible) {
            schedule(INTERVAL);
            return;
        }
        long revision = generation;
        inFlight = true;
        worker.execute(() -> {
            JSONObject response = null;
            boolean revoked = false;
            if (revision == generation) {
                try {
                    response = current.peer.post("/v1/sync", current.ticket, request);
                } catch (PeerConnection.StatusException failure) {
                    revoked = failure.status == 401 || failure.status == 410;
                } catch (Exception ignored) {
                    // The desktop may be asleep or on another network. Retry the existing pairing.
                }
            }
            JSONObject value = response;
            boolean forget = revoked;
            main.post(() -> complete(current, revision, value, forget));
        });
    }

    private void complete(CompanionStore.Pair current, long revision, JSONObject response, boolean revoked) {
        inFlight = false;
        if (!connected || current != pair) {
            schedule(0);
            return;
        }
        if (revoked) {
            store.forget();
            return;
        }
        boolean changed = revision != generation;
        boolean resumed = false;
        if (response != null) {
            delay = INTERVAL;
            result = null;
            boolean wasPaused = pcPaused;
            pcPaused = response.optBoolean("paused");
            resumed = wasPaused && !pcPaused;
            JSONObject command = response.optJSONObject("command");
            if (command != null) receiveReply(command, !changed && !pcPaused);
        } else if (!changed) {
            delay = Math.min(delay * 2, MAX_BACKOFF);
        }
        schedule(changed || resumed ? 0 : delay);
    }

    private void receiveReply(JSONObject command, boolean canReply) {
        String id = command.optString("id");
        if (!id.matches("[A-Za-z0-9_-]{1,128}") || !handledCommands.add(id)) return;
        if (handledCommands.size() > 64) handledCommands.remove(handledCommands.iterator().next());
        String status = canReply ? performReply(command.optString("notificationId"), command.optString("text")) : "expired";
        try {
            result = new JSONObject().put("id", id).put("status", status);
        } catch (JSONException impossible) {
            result = null;
        }
    }

    private String performReply(String notificationId, String reply) {
        if (reply.trim().isEmpty() || reply.length() > 1000) return "failed";
        if (!canShare()) return "expired";
        Entry selected = entries.values().stream().filter(entry -> entry.id.equals(notificationId)).findFirst().orElse(null);
        if (selected == null || selected.action == null) return "expired";
        StatusBarNotification[] current = activeNotifications(new String[] {selected.key});
        if (current == null || current.length != 1) return "expired";
        Entry actual = entry(current[0]);
        if (!selected.sameReply(actual) || !canShare()) return "expired";
        Bundle results = new Bundle();
        results.putCharSequence(actual.action.input.getResultKey(), reply);
        Intent fill = new Intent();
        RemoteInput.addResultsToIntent(new RemoteInput[] {actual.action.input}, fill, results);
        RemoteInput.setResultsSource(fill, RemoteInput.SOURCE_FREE_FORM_INPUT);
        try {
            actual.action.pendingIntent.send(this, 0, fill);
            return "submitted";
        } catch (PendingIntent.CanceledException | SecurityException ignored) {
            return "failed";
        }
    }

    private static final class ReplyAction {
        final PendingIntent pendingIntent;
        final RemoteInput input;

        ReplyAction(PendingIntent pendingIntent, RemoteInput input) {
            this.pendingIntent = pendingIntent;
            this.input = input;
        }
    }

    private static final class Entry {
        final String id;
        final String key;
        final long time;
        final String title;
        final String body;
        final String label;
        final ReplyAction action;

        Entry(String id, String key, long time, String title, String body, String label, ReplyAction action) {
            this.id = id;
            this.key = key;
            this.time = time;
            this.title = title;
            this.body = body;
            this.label = label;
            this.action = action;
        }

        JSONObject json() {
            try {
                return new JSONObject().put("id", id).put("time", time).put("title", title)
                    .put("body", body).put("app", label).put("replyable", action != null);
            } catch (JSONException impossible) {
                throw new IllegalStateException(impossible);
            }
        }

        boolean sameReply(Entry other) {
            return other != null && other.action != null && key.equals(other.key) && time == other.time
                && title.equals(other.title) && body.equals(other.body)
                && action.pendingIntent.equals(other.action.pendingIntent)
                && action.input.getResultKey().equals(other.action.input.getResultKey());
        }
    }
}

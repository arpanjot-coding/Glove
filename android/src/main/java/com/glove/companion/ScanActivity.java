package com.glove.companion;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.ImageFormat;
import android.hardware.Camera;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Surface;
import android.view.SurfaceHolder;
import android.view.SurfaceView;
import android.view.WindowInsets;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import com.google.zxing.DecodeHintType;
import com.google.zxing.BinaryBitmap;
import com.google.zxing.PlanarYUVLuminanceSource;
import com.google.zxing.ReaderException;
import com.google.zxing.common.HybridBinarizer;
import com.google.zxing.qrcode.QRCodeReader;
import java.util.Comparator;
import java.util.Collections;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@SuppressWarnings("deprecation")
public final class ScanActivity extends Activity implements SurfaceHolder.Callback {
    static final String QR_TEXT = "com.glove.companion.QR_TEXT";
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService decoder = Executors.newSingleThreadExecutor();
    private SurfaceView preview;
    private TextView hint;
    private Camera camera;
    private boolean surfaceReady;
    private boolean visible;
    private boolean openingFailed;
    private int revision;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        layout.setBackgroundColor(Color.rgb(244, 247, 253));
        layout.setOnApplyWindowInsetsListener((view, insets) -> {
            android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
            view.setPadding(bars.left + dp(20), bars.top + dp(16), bars.right + dp(20), bars.bottom + dp(16));
            return WindowInsets.CONSUMED;
        });
        TextView title = new TextView(this);
        title.setText("Scan Windows QR");
        title.setTextSize(26);
        title.setTextColor(Color.rgb(20, 33, 59));
        title.setTypeface(android.graphics.Typeface.DEFAULT, android.graphics.Typeface.BOLD);
        layout.addView(title);

        hint = new TextView(this);
        hint.setText("Point this camera at the pairing code on your Windows PC.");
        hint.setTextSize(16);
        hint.setPadding(0, dp(8), 0, dp(16));
        hint.setAccessibilityLiveRegion(android.view.View.ACCESSIBILITY_LIVE_REGION_POLITE);
        layout.addView(hint);

        preview = new SurfaceView(this);
        preview.getHolder().addCallback(this);
        layout.addView(preview, new LinearLayout.LayoutParams(-1, 0, 1));

        Button cancel = new Button(this);
        cancel.setText("Cancel");
        cancel.setAllCaps(false);
        cancel.setMinHeight(dp(48));
        cancel.setOnClickListener(view -> finish());
        layout.addView(cancel);
        setContentView(layout);
        layout.requestApplyInsets();
    }

    @Override protected void onResume() {
        super.onResume();
        visible = true;
        openingFailed = false;
        startCamera();
    }

    @Override protected void onPause() {
        visible = false;
        closeCamera();
        super.onPause();
    }

    @Override protected void onDestroy() {
        main.removeCallbacksAndMessages(null);
        decoder.shutdownNow();
        super.onDestroy();
    }

    @Override public void surfaceCreated(SurfaceHolder holder) {
        surfaceReady = true;
        startCamera();
    }

    @Override public void surfaceChanged(SurfaceHolder holder, int format, int width, int height) {
        startCamera();
    }

    @Override public void surfaceDestroyed(SurfaceHolder holder) {
        surfaceReady = false;
        closeCamera();
    }

    private void startCamera() {
        if (!visible || !surfaceReady || camera != null || openingFailed) return;
        try {
            int index = backCamera();
            if (index < 0) throw new IllegalStateException("No back camera");
            Camera.CameraInfo info = new Camera.CameraInfo();
            Camera.getCameraInfo(index, info);
            camera = Camera.open(index);
            Camera.Parameters parameters = camera.getParameters();
            Camera.Size size = parameters.getSupportedPreviewSizes().stream()
                .min(Comparator.comparingInt(value -> Math.abs(value.width - 800) + Math.abs(value.height - 600)))
                .orElse(parameters.getPreviewSize());
            parameters.setPreviewSize(size.width, size.height);
            parameters.setPreviewFormat(ImageFormat.NV21);
            if (parameters.getSupportedFocusModes() != null
                && parameters.getSupportedFocusModes().contains(Camera.Parameters.FOCUS_MODE_CONTINUOUS_PICTURE)) {
                parameters.setFocusMode(Camera.Parameters.FOCUS_MODE_CONTINUOUS_PICTURE);
            }
            camera.setParameters(parameters);
            int rotation = getDisplay().getRotation();
            int degrees = switch (rotation) {
                case Surface.ROTATION_90 -> 90;
                case Surface.ROTATION_180 -> 180;
                case Surface.ROTATION_270 -> 270;
                default -> 0;
            };
            camera.setDisplayOrientation((info.orientation - degrees + 360) % 360);
            camera.setPreviewDisplay(preview.getHolder());
            camera.startPreview();
            camera.setErrorCallback((error, source) -> {
                if (source == camera) cameraUnavailable();
            });
            int attempt = ++revision;
            nextFrame(attempt, size.width, size.height);
        } catch (Exception error) {
            cameraUnavailable();
        }
    }

    private void cameraUnavailable() {
        openingFailed = true;
        closeCamera();
        hint.setText("Could not open the camera. Go back to enter the pairing details.");
    }

    private void nextFrame(int attempt, int width, int height) {
        if (camera == null || attempt != revision) return;
        try {
            camera.setOneShotPreviewCallback((frame, source) -> {
                if (source != camera || attempt != revision) return;
                decoder.execute(() -> {
                    String value = decode(frame, width, height);
                    main.post(() -> {
                        if (attempt != revision) return;
                        if (value == null) {
                            main.postDelayed(() -> nextFrame(attempt, width, height), 100);
                        } else {
                            setResult(RESULT_OK, new Intent().putExtra(QR_TEXT, value));
                            finish();
                        }
                    });
                });
            });
        } catch (RuntimeException unavailable) {
            cameraUnavailable();
        }
    }

    private static String decode(byte[] frame, int width, int height) {
        if (frame == null || frame.length < width * height) return null;
        PlanarYUVLuminanceSource source = new PlanarYUVLuminanceSource(frame, width, height,
            0, 0, width, height, false);
        BinaryBitmap bitmap = new BinaryBitmap(new HybridBinarizer(source));
        try {
            String value = new QRCodeReader().decode(bitmap,
                Collections.singletonMap(DecodeHintType.TRY_HARDER, Boolean.TRUE)).getText();
            return value.length() <= 512 ? value : null;
        } catch (ReaderException ignored) {
            return null;
        }
    }

    private static int backCamera() {
        Camera.CameraInfo info = new Camera.CameraInfo();
        for (int i = 0; i < Camera.getNumberOfCameras(); i++) {
            Camera.getCameraInfo(i, info);
            if (info.facing == Camera.CameraInfo.CAMERA_FACING_BACK) return i;
        }
        return -1;
    }

    private void closeCamera() {
        revision++;
        if (camera == null) return;
        Camera closing = camera;
        camera = null;
        try {
            closing.setOneShotPreviewCallback(null);
            closing.stopPreview();
        } catch (RuntimeException ignored) {
            // The camera service may have disconnected before teardown.
        } finally {
            try {
                closing.release();
            } catch (RuntimeException ignored) {
                // The camera is already unusable. Its local reference has been cleared.
            }
        }
    }

    private int dp(int pixels) {
        return Math.round(getResources().getDisplayMetrics().density * pixels);
    }
}

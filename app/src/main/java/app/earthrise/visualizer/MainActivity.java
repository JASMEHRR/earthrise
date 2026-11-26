package app.earthrise.visualizer;

import android.Manifest;
import android.app.Activity;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.media.audiofx.Visualizer;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.KeyEvent;
import android.view.View;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.webkit.WebViewAssetLoader;

/**
 * Full-screen WebView that runs the web app from the bundled assets (../web).
 * Native extras: Spotify login redirect (earthrise://callback), live TV audio
 * spectrum for the sound bars, remote media keys, and the Back button.
 */
public class MainActivity extends Activity {
    private static final String TAG = "Earthrise";
    private static final String BASE = "https://appassets.androidplatform.net/assets/index.html";
    private static final int REQ_AUDIO = 7;
    private static final int BANDS = 64;
    private static final long PUSH_INTERVAL_MS = 33;

    private final Handler main = new Handler(Looper.getMainLooper());
    private WebView web;
    private Visualizer visualizer;
    private boolean wantAudio = false;
    private boolean askedPermission = false;
    private long lastPush = 0;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        web = new WebView(this);
        web.setBackgroundColor(Color.BLACK);
        setContentView(web);
        hideSystemUi();

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);

        final WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return loader.shouldInterceptRequest(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri u = request.getUrl();
                String scheme = u.getScheme();
                if ("earthrise".equals(scheme)) {
                    String q = u.getEncodedQuery();
                    view.loadUrl(BASE + (q != null ? "?" + q : ""));
                    return true;
                }
                // Stay inside the app for web pages (Spotify login); ignore app-launch links like intent://.
                return !("http".equals(scheme) || "https".equals(scheme));
            }
        });
        web.addJavascriptInterface(new Bridge(), "EarthriseNative");

        if (savedInstanceState != null) web.restoreState(savedInstanceState);
        else web.loadUrl(BASE);
        web.requestFocus();
    }

    private void hideSystemUi() {
        getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                        | View.SYSTEM_UI_FLAG_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) hideSystemUi();
    }

    /** Methods the web app can call as window.EarthriseNative.*. */
    private class Bridge {
        @JavascriptInterface
        public String getClientId() {
            return BuildConfig.SPOTIFY_CLIENT_ID;
        }

        @JavascriptInterface
        public String getYoutubeKey() {
            return BuildConfig.YOUTUBE_API_KEY;
        }

        @JavascriptInterface
        public void setLiveAudio(final boolean on) {
            main.post(() -> {
                wantAudio = on;
                if (on) startAudio();
                else {
                    stopAudio();
                    js("window.onNativeAudioStatus&&onNativeAudioStatus('off')");
                }
            });
        }
    }

    private void js(String code) {
        if (web != null) web.evaluateJavascript(code, null);
    }

    private void startAudio() {
        if (visualizer != null) return;
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            if (!askedPermission) {
                askedPermission = true;
                requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQ_AUDIO);
            } else {
                js("window.onNativeAudioStatus&&onNativeAudioStatus('denied')");
            }
            return;
        }
        try {
            Visualizer v = new Visualizer(0);
            v.setEnabled(false);
            v.setCaptureSize(Visualizer.getCaptureSizeRange()[1]);
            int rate = Math.min(Visualizer.getMaxCaptureRate(), 30000);
            v.setDataCaptureListener(new Visualizer.OnDataCaptureListener() {
                @Override
                public void onWaveFormDataCapture(Visualizer vis, byte[] waveform, int samplingRate) { }

                @Override
                public void onFftDataCapture(Visualizer vis, byte[] fft, int samplingRate) {
                    pushSpectrum(fft);
                }
            }, rate, false, true);
            v.setEnabled(true);
            visualizer = v;
            js("window.onNativeAudioStatus&&onNativeAudioStatus('on')");
        } catch (RuntimeException e) {
            // Some TVs do not allow apps to read the output mix.
            Log.w(TAG, "Visualizer unavailable", e);
            visualizer = null;
            js("window.onNativeAudioStatus&&onNativeAudioStatus('unavailable')");
        }
    }

    private void stopAudio() {
        if (visualizer == null) return;
        try {
            visualizer.setEnabled(false);
            visualizer.release();
        } catch (RuntimeException e) {
            Log.w(TAG, "Visualizer release failed", e);
        }
        visualizer = null;
    }

    /** Turns raw FFT bytes into 64 log-spaced bands in 0..1 and sends them to the page. */
    private void pushSpectrum(byte[] fft) {
        long now = System.currentTimeMillis();
        if (now - lastPush < PUSH_INTERVAL_MS || fft == null || fft.length < 8) return;
        lastPush = now;
        int n = fft.length / 2;
        StringBuilder sb = new StringBuilder("window.onNativeSpectrum&&onNativeSpectrum([");
        for (int b = 0; b < BANDS; b++) {
            int lo = Math.max(1, (int) Math.floor(Math.pow(n - 1, b / (double) BANDS)));
            int hi = Math.max(lo + 1, (int) Math.floor(Math.pow(n - 1, (b + 1) / (double) BANDS)));
            double peak = 0;
            for (int k = lo; k < hi && 2 * k + 1 < fft.length; k++) {
                double mag = Math.hypot(fft[2 * k], fft[2 * k + 1]);
                if (mag > peak) peak = mag;
            }
            double v = 20 * Math.log10(peak + 1) / 45.0;
            if (v < 0) v = 0;
            if (v > 1) v = 1;
            if (b > 0) sb.append(',');
            sb.append(Math.round(v * 1000) / 1000.0);
        }
        sb.append("])");
        js(sb.toString());
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != REQ_AUDIO) return;
        boolean granted = grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED;
        if (granted && wantAudio) startAudio();
        else if (!granted) js("window.onNativeAudioStatus&&onNativeAudioStatus('denied')");
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        String name = null;
        switch (event.getKeyCode()) {
            case KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE:
            case KeyEvent.KEYCODE_MEDIA_PLAY:
            case KeyEvent.KEYCODE_MEDIA_PAUSE:
                name = "playpause";
                break;
            case KeyEvent.KEYCODE_MEDIA_NEXT:
            case KeyEvent.KEYCODE_MEDIA_FAST_FORWARD:
                name = "next";
                break;
            case KeyEvent.KEYCODE_MEDIA_PREVIOUS:
            case KeyEvent.KEYCODE_MEDIA_REWIND:
                name = "prev";
                break;
            case KeyEvent.KEYCODE_MENU:
                name = "menu";
                break;
            default:
                break;
        }
        if (name == null) return super.dispatchKeyEvent(event);
        if (event.getAction() == KeyEvent.ACTION_DOWN && event.getRepeatCount() == 0) {
            js("window.onNativeKey&&onNativeKey('" + name + "')");
        }
        return true;
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        if (web == null) {
            super.onBackPressed();
            return;
        }
        web.evaluateJavascript("window.handleBack?String(window.handleBack()):'false'", result -> {
            if (!"\"true\"".equals(result)) finish();
        });
    }

    @Override
    protected void onResume() {
        super.onResume();
        hideSystemUi();
        if (web != null) web.onResume();
        if (wantAudio) startAudio();
    }

    @Override
    protected void onPause() {
        stopAudio();
        if (web != null) web.onPause();
        super.onPause();
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        if (web != null) web.saveState(outState);
    }

    @Override
    protected void onDestroy() {
        stopAudio();
        if (web != null) {
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}

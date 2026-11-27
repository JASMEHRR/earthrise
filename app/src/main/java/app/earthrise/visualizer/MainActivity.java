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
 * spectrum for the sound bars, remote media keys, the Back button, and the link to Earthrise Link
 * on the laptop (LinkClient).
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
    /** Words from Jarvis in Glass Home ("play X on Spotify"), kept until the page asks for them. */
    private volatile String pendingPlay = null;
    static final String EXTRA_PLAY = "play";

    private void takeIntent(android.content.Intent i) {
        String q = i == null ? null : i.getStringExtra(EXTRA_PLAY);
        if (q == null || q.trim().isEmpty() || q.length() > 200) return;
        pendingPlay = q.trim();
        if (web != null) js("window.onNativePlay&&onNativePlay(" + org.json.JSONObject.quote(pendingPlay) + ")");
    }

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
        String first = getIntent() == null ? null : getIntent().getStringExtra(EXTRA_PLAY);
        if (first != null && !first.trim().isEmpty() && first.length() <= 200) pendingPlay = first.trim(); // the page asks with takePlay()
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

        /** What Jarvis asked to play when it opened Earthrise (once). */
        @JavascriptInterface
        public String takePlay() {
            String q = pendingPlay;
            pendingPlay = null;
            return q == null ? "" : q;
        }

        @JavascriptInterface
        public String getYoutubeKey() {
            return BuildConfig.YOUTUBE_API_KEY;
        }

        /** Finds Earthrise Link on the laptop; answers window.onLinkResult(id, json). */
        @JavascriptInterface
        public void linkDiscover(final String id) {
            new Thread(() -> answer(id, LinkClient.discover(2500)), "link-discover").start();
        }

        /** One /link/ call to the laptop (see LinkClient); answers window.onLinkResult(id, json). */
        @JavascriptInterface
        public void linkCall(final String id, final String method, final String base, final String path,
                             final String body, final String secret) {
            new Thread(() -> answer(id, LinkClient.call(method, base, path, body, secret)), "link-call").start();
        }

        /**
         * Starts the stick's Spotify app (the phone-style one, which keeps playing behind other apps)
         * so it shows up as a Spotify device; the page then plays on it and calls backFromSpotify.
         * Comes back by itself after 20 s regardless. False when Spotify is not installed.
         */
        @JavascriptInterface
        public boolean wakeSpotify() {
            android.content.Intent i = getPackageManager().getLaunchIntentForPackage(SPOTIFY);
            if (i == null) return false;
            final android.content.Intent go = i.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK
                    | android.content.Intent.FLAG_ACTIVITY_NO_ANIMATION);
            main.post(() -> {
                try {
                    startActivity(go);
                } catch (RuntimeException e) {
                    Log.w(TAG, "could not open Spotify: " + e);
                    return;
                }
                waking = true;
                main.postDelayed(bringBack, 20000);
            });
            return true;
        }

        /** The song is sent: come back on top of Spotify (it keeps playing behind Earthrise). */
        @JavascriptInterface
        public void backFromSpotify() {
            main.post(() -> {
                if (!waking) return;
                main.removeCallbacks(bringBack);
                main.postDelayed(bringBack, 1500);
            });
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

    private static final String SPOTIFY = "com.spotify.music";
    /** Spotify was opened by wakeSpotify and Earthrise should come back on top of it. */
    private boolean waking;

    private final Runnable bringBack = () -> {
        if (!waking) return;
        waking = false;
        startActivity(new android.content.Intent(MainActivity.this, MainActivity.class)
                .addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK
                        | android.content.Intent.FLAG_ACTIVITY_REORDER_TO_FRONT
                        | android.content.Intent.FLAG_ACTIVITY_NO_ANIMATION));
    };

    /** Behind Spotify, Fire OS's WebView pauses the page; it has to keep going to send the song. */
    private final Runnable keepAwake = new Runnable() {
        @Override
        public void run() {
            if (!waking || web == null) return;
            web.resumeTimers();
            main.postDelayed(this, 1000);
        }
    };

    private void answer(String id, String json) {
        final String code = "window.onLinkResult&&onLinkResult(" + org.json.JSONObject.quote(id == null ? "" : id) + "," + json + ")";
        main.post(() -> js(code));
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
    protected void onNewIntent(android.content.Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        takeIntent(intent);
    }

    @Override
    protected void onResume() {
        super.onResume();
        waking = false;
        main.removeCallbacks(bringBack);
        main.removeCallbacks(keepAwake);
        hideSystemUi();
        if (web != null) web.onResume();
        if (wantAudio) startAudio();
    }

    @Override
    protected void onPause() {
        stopAudio();
        if (web != null) {
            web.onPause();
            web.resumeTimers(); // Fire OS's WebView would stop the page here (see keepAwake)
        }
        main.post(keepAwake);
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

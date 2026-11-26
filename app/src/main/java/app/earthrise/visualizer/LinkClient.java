package app.earthrise.visualizer;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.HttpURLConnection;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.regex.Pattern;

/**
 * Talks to "Earthrise Link" on the laptop (link/ in this repo), which holds the Spotify login and
 * hands this TV short-lived access tokens. The page runs on https://appassets.androidplatform.net,
 * so it cannot call the laptop's plain-http address itself; these calls run here instead and their
 * results go back to the page as JSON. Only private (home network) addresses and /link/ paths are
 * allowed.
 */
final class LinkClient {
    static final int DISCOVERY_PORT = 5198;
    private static final String HELLO = "EARTHRISE_DISCOVER";
    private static final Pattern BASE = Pattern.compile(
            "^http://(10\\.\\d{1,3}|192\\.168|172\\.(1[6-9]|2\\d|3[01]))\\.\\d{1,3}\\.\\d{1,3}:\\d{2,5}$");
    private static final Pattern PATH = Pattern.compile("^/link/[A-Za-z0-9/_-]{1,80}$");

    private LinkClient() {
    }

    /** Broadcasts a hello and waits up to timeoutMs for the laptop: {"ok":true,"ip","port","name"} or {"ok":false}. */
    static String discover(int timeoutMs) {
        try (DatagramSocket s = new DatagramSocket()) {
            s.setBroadcast(true);
            byte[] hello = HELLO.getBytes(StandardCharsets.UTF_8);
            for (String to : targets()) {
                try {
                    s.send(new DatagramPacket(hello, hello.length, InetAddress.getByName(to), DISCOVERY_PORT));
                } catch (IOException ignored) {
                    // one target failing (no route) is fine
                }
            }
            long end = System.currentTimeMillis() + timeoutMs;
            byte[] buf = new byte[1024];
            while (System.currentTimeMillis() < end) {
                s.setSoTimeout((int) Math.max(50, end - System.currentTimeMillis()));
                DatagramPacket p = new DatagramPacket(buf, buf.length);
                try {
                    s.receive(p);
                } catch (SocketTimeoutException e) {
                    break;
                }
                try {
                    JSONObject j = new JSONObject(new String(p.getData(), 0, p.getLength(), StandardCharsets.UTF_8));
                    if (!"earthrise-link".equals(j.optString("app"))) continue;
                    String ip = p.getAddress().getHostAddress();
                    int port = j.optInt("port", 5173);
                    if (!BASE.matcher("http://" + ip + ":" + port).matches()) continue;
                    return new JSONObject().put("ok", true).put("ip", ip).put("port", port)
                            .put("name", j.optString("name", "your laptop")).toString();
                } catch (JSONException ignored) {
                    // not our reply
                }
            }
        } catch (IOException ignored) {
            // no network
        }
        return "{\"ok\":false}";
    }

    /** One call to the laptop: {"status":200,"body":"..."}; status 0 when it could not be reached. */
    static String call(String method, String base, String path, String body, String secret) {
        JSONObject out = new JSONObject();
        try {
            if (base == null || path == null || !BASE.matcher(base).matches() || !PATH.matcher(path).matches()
                    || !("GET".equals(method) || "POST".equals(method))) {
                return out.put("status", 0).put("body", "not allowed").toString();
            }
            HttpURLConnection h = (HttpURLConnection) new URL(base + path).openConnection();
            h.setConnectTimeout(3000);
            h.setReadTimeout(6000);
            h.setRequestMethod(method);
            h.setRequestProperty("Accept", "application/json");
            if (secret != null && !secret.isEmpty()) h.setRequestProperty("Authorization", "Bearer " + secret);
            if ("POST".equals(method)) {
                byte[] b = (body == null ? "{}" : body).getBytes(StandardCharsets.UTF_8);
                h.setDoOutput(true);
                h.setRequestProperty("Content-Type", "application/json");
                h.setFixedLengthStreamingMode(b.length);
                try (OutputStream o = h.getOutputStream()) {
                    o.write(b);
                }
            }
            int status = h.getResponseCode();
            InputStream in = status >= 400 ? h.getErrorStream() : h.getInputStream();
            String text = "";
            if (in != null) {
                ByteArrayOutputStream b = new ByteArrayOutputStream();
                byte[] buf = new byte[4096];
                for (int n; (n = in.read(buf)) > 0 && b.size() < 65536; ) b.write(buf, 0, n);
                in.close();
                text = b.toString("UTF-8");
            }
            h.disconnect();
            return out.put("status", status).put("body", text).toString();
        } catch (IOException | RuntimeException e) {
            try {
                return out.put("status", 0).put("body", String.valueOf(e.getMessage())).toString();
            } catch (JSONException ignored) {
                return "{\"status\":0}";
            }
        } catch (JSONException e) {
            return "{\"status\":0}";
        }
    }

    /** Where the hello goes: everyone on the network, plus this Wi-Fi's own broadcast address. */
    private static String[] targets() {
        String own = null;
        try {
            for (NetworkInterface ni : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!ni.isUp() || ni.isLoopback()) continue;
                for (InetAddress a : Collections.list(ni.getInetAddresses())) {
                    if (a instanceof Inet4Address && a.isSiteLocalAddress()) {
                        String ip = a.getHostAddress();
                        own = ip.substring(0, ip.lastIndexOf('.') + 1) + "255";
                    }
                }
            }
        } catch (IOException | RuntimeException ignored) {
            // fall back to the general broadcast
        }
        return own == null ? new String[]{"255.255.255.255"} : new String[]{"255.255.255.255", own};
    }
}

# Earthrise

A full-screen music visualizer for your TV that follows whatever you're playing on Spotify, on any device.

- **Song fan (bottom-left):** a small spinning record, with the current song and the next three from your Spotify queue fanned out beside it. Pick one with the remote to skip to it.
- **Lyrics (left):** synced lyrics, word by word. Key words are big and filler words small, so each line reads like a poster.
- **Record (centre):** the album cover spins as a vinyl, with 120 sound bars around the rim that pulse on the beat.

## One-time setup

1. **Make a Spotify app** (free) at https://developer.spotify.com/dashboard
   - Create app, any name. Tick **Web API**.
   - Under **Redirect URIs** add exactly `earthrise://callback`
   - Copy the **Client ID**.
2. **Give the build your Client ID.** Either put it in `.env` as `SPOTIFY_CLIENT_ID=...` (see `.env.example`) and ask Claude to push it, or run:
   ```
   gh variable set SPOTIFY_CLIENT_ID
   ```
   and paste it at the prompt. The next build bakes it in. (You can also type it in the app under Settings.)
3. **Install the APK on the TV.** Download `earthrise-visualizer.apk` from the latest release in this repo, then send it to the TV with a USB stick or an app such as "Send Files to TV". Allow installs from unknown sources when the TV asks.
4. Open **Earthrise**, press **Connect Spotify**, log in with your email and password (Google and Facebook buttons do not work inside TV apps), then play music anywhere.

If Spotify says the user is not registered, add your Spotify email under **User Management** in the Spotify app dashboard.

## Remote

| Button | Does |
|---|---|
| Any arrow or OK | Shows the controls |
| OK on a control | Previous, play/pause, next, settings |
| Arrow up from controls | Reaches the song fan. OK skips to that song |
| Play/pause, next, previous keys | Control Spotify directly |
| Menu | Settings |
| Back | Hides controls, then exits |

Play, pause and skip from the TV need Spotify Premium (Spotify's rule). Showing the song, lyrics and visuals works on free accounts.

## About the sound bars

When Spotify plays **on the TV itself**, the bars follow the real sound (the app asks for audio permission once). When it plays on your phone or another speaker, the TV can't hear it, so the bars follow a simulated beat. Spotify doesn't give apps its audio data.

## Develop

- Web app: `web/` (plain HTML, CSS, JS, no build step). Preview with `python -m http.server 5173 --directory web` and open `http://127.0.0.1:5173/?demo=1` for a fake song without logging in. To log in on the web, add `http://127.0.0.1:5173/` as a Redirect URI in your Spotify app.
- Tests: `node --test tests`
- Android wrapper: `app/` (Java, WebView). The APK is built by GitHub Actions on every push to `main` and attached to a release.

# Decisions

- 2026-11-24: Now-playing comes from the Spotify Web API (currently-playing + queue), logged in with PKCE so no client secret is stored. Undo: none needed, it is the core feature.
- 2026-11-24: Sound bars use Android's Visualizer on the TV's output mix when Spotify plays on the TV; otherwise a simulated beat. Spotify does not give apps its audio, and its audio-analysis API is closed to new apps. Undo: Settings > TV audio for bars.
- 2026-11-24: Synced lyrics come from LRCLIB (free, no key, CORS open). Songs without synced lyrics show title and artist. Undo: Settings > Lyrics.
- 2026-11-24: Removed the drawn Earth and the part numbers; background is plain black with a soft glow behind the record, per feedback.
- 2026-11-24: APK is built by GitHub Actions (no Java or Android SDK on this PC). Gradle 8.7, AGP 8.5.2, minSdk 23. Undo: build locally with Android Studio.
- 2026-11-24: Release signing key is a PKCS12 file made with OpenSSL, kept in .signing/ (git-ignored) and stored as GitHub secrets, so every build can update the previous install.
- 2026-11-24: Repo is private. Making it public would let the TV download the APK straight from the Releases page. Undo: gh repo edit --visibility public.
- 2026-11-24: Styles use vw/vh and solid text colour (no container units, no gradient-clipped text) so older Android TV WebViews render it.

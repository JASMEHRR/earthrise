# Earthrise Link (laptop app)

Keeps the Spotify login on the laptop so the TV app never has to log in itself.

Start: double-click `link\start.cmd` (needs Node.js). It opens http://127.0.0.1:5173/link, where you log in to Spotify once and allow TVs. Windows may ask to let Node.js use the network: allow it on private networks, or the TV cannot reach the laptop. The login is saved in `%APPDATA%\Earthrise\link.json`.

## Contract v1 (for the TV app)
- Discovery: UDP broadcast `EARTHRISE_DISCOVER` to port 5198; reply `{"app":"earthrise-link","v":1,"port":5173,"name":...}` goes to the sender's address and port. Fallback: `GET /link/status`.
- Pairing: `POST /link/pair {"device":"Fire TV"}` returns `{pairId, code}`. Poll `GET /link/pair/<pairId>`: pending, denied, expired, or approved with `secret` (shown once, never expires). Requests expire after 5 minutes.
- Token: `GET /link/token` with `Authorization: Bearer <secret>` returns `{access_token, expires_at, scope}`. 401 unpaired, 409 spotify_login_needed, 502 spotify_unreachable. Calls from the laptop itself need no secret.

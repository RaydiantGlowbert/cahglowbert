# Known Limitations (MVP)

This MVP is playable and suitable for early users, but has known limits:

1. No authentication or moderation
- Anyone with a room code can join while room is in lobby.
- No profanity filtering, reporting, bans, or admin controls.

2. Single-room server process assumptions
- Remote gameplay is server-authoritative, but horizontal scaling is not fully production-tuned.
- For best durability, use Redis-backed room storage in hosted environments.

3. Basic reconnect UX
- Rejoin is supported by session token, but users may still need to manually re-enter room code/name after long tab inactivity or storage loss.

4. Browser/device support is best-effort
- Tested primarily on modern Chromium-based browsers.
- Older browsers or aggressive mobile battery/network policies may interrupt long sessions.

5. No in-app telemetry dashboard
- There is no built-in admin UI for room metrics, replay rates, or live operational monitoring.

6. Gameplay safety rails are minimal
- The app enforces turn/host/judge rules, but does not include anti-cheat identity guarantees beyond session/socket checks.

7. No localization and limited accessibility testing matrix
- Core accessibility improvements are included, but full screen reader and cross-device audit coverage is not exhaustive.

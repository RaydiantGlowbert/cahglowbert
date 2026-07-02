# Official Launch Checklist (No Additional Testing)

This checklist is designed for a practical launch when you do not have a separate tester group.

## 1. Lock Scope

- Keep feature scope frozen to current remote multiplayer flow.
- Avoid adding new gameplay logic until after launch feedback.
- Treat only critical production outages as hotfix-worthy on launch day.

## 2. Confirm Production Endpoints

- Frontend URL: https://cards-against-humanity-mu.vercel.app
- Backend URL: https://cahglowbert.onrender.com
- Verify Vercel environment variable:
  - VITE_SERVER_URL=https://cahglowbert.onrender.com
- Verify backend CORS includes frontend domain in CORS_ORIGIN.

## 3. Basic Operational Hardening

- Use Redis-backed room storage in production:
  - ROOM_STORE=redis
  - REDIS_URL=...
- Keep file storage only for local development.
- Make sure backend host plan allows websocket uptime suitable for multiplayer rooms.

## 4. Launch Safety Controls

- Publish as a soft launch first:
  - Invite a small group (3-10 people) initially.
  - Share that it is an early public release and feedback is welcome.
- Prepare a rollback option:
  - Keep last known-good Vercel deployment available for quick rollback.
- Keep one emergency message template ready for users in case of outage:
  - "We are applying a fix and service will be back shortly."

## 5. Launch-Day Manual Smoke (Solo)

This is not a full testing pass. It is a minimal confidence check:

- Open two browser windows (or one normal + one incognito).
- Verify you can create and join the same room.
- Verify host can start game.
- Verify non-judge can submit.
- Verify judge can choose winner.
- Verify host can advance round.

If all six actions work once, proceed with launch announcement.

## 6. Support and Feedback Loop

- Add a contact point to collect issues (Discord, email, or GitHub issues).
- Ask users to include:
  - room code
  - approximate time
  - screenshot/error text
  - browser and device
- Review first-day reports and batch fixes after launch.

## 7. Post-Launch Priorities (First 72 Hours)

- Prioritize fixes in this order:
  1. Cannot create/join room
  2. Cannot submit/choose/advance
  3. Reconnect/session loss issues
  4. Non-critical UI polish
- Avoid feature expansion before stabilizing top issues.

## 8. Suggested Public Launch Copy

"Cards Against Humanity online rooms are now live. Create a room, share the code, and play in your browser. If you hit an issue, send room code + screenshot and we will patch quickly."

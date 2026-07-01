# Cards Against Humanity (Custom Deck)

A browser-based Cards Against Humanity style game with:

- Local mode
- Remote multiplayer mode (Socket.IO)
- Server-authoritative game flow
- Custom black and white card decks
- Deck validation and startup lock for invalid card data
- Reconnect sessions and per-player hand privacy
- Room persistence (file or Redis)

## Requirements

- Node.js 20+
- npm 10+

## Quick Start (Local Dev)

1. Install dependencies:

```bash
npm install
```

2. Copy env file:

```bash
copy .env.example .env
```

If you are on macOS/Linux, use:

```bash
cp .env.example .env
```

3. Run frontend + multiplayer server together:

```bash
npm run dev:all
```

4. Open frontend:

- http://localhost:5173

5. Optional release check commands:

```bash
npm run test -- --run
npm run build
```

## Scripts

- `npm run dev` -> Vite frontend
- `npm run server:dev` -> multiplayer server
- `npm run dev:all` -> frontend + server concurrently
- `npm run test -- --run` -> run tests
- `npm run build` -> production build

## Environment Variables

See `.env.example`.

Important server settings:

- `ROOM_STORE=file|redis`
- `REDIS_URL=redis://...` when using Redis
- `CORS_ORIGIN=https://your-frontend-domain`

## Room Storage Backends

The server supports two persistence modes:

1. `file` (default)
- Uses `server/data/rooms.json`
- Good for local development and single-instance hosting

2. `redis`
- Uses `REDIS_URL`
- Better for production durability and scaling

If `ROOM_STORE` is omitted and `REDIS_URL` is set, Redis is used automatically.

## Deployment Notes

Recommended split deployment:

1. Frontend: Vercel
2. Server: Render / Fly.io / Railway / Azure / similar
3. Storage: Managed Redis

Set frontend env in Vercel:

- `VITE_SERVER_URL=https://your-server-domain`

Vercel project settings for this repo:

- Framework preset: `Vite`
- Install command: `npm install`
- Build command: `npm run build`
- Output directory: `dist`

`vercel.json` is included to keep deployment settings and SPA rewrites consistent.

Set server env in your backend host:

- `PORT=3001` (or platform-assigned)
- `CORS_ORIGIN=https://your-frontend-domain`
- `ROOM_STORE=redis`
- `REDIS_URL=redis://...`

## How To Play (MVP)

1. Host creates a room in `Remote` mode and shares the room code.
2. Other players join with the room code and their names.
3. Host starts the game when everyone is ready.
4. Active player submits cards when prompted.
5. Judge picks a winning anonymized submission.
6. Host advances to the next round until game over.

For local-only sessions, use `Local` mode and enter player names on one device.

## Known Limitations

Current MVP constraints are tracked in `KNOWN_LIMITATIONS.md`.

## Current Multiplayer Milestones

- M1: Room create/join lobby flow
- M2: Server-authoritative remote gameplay flow
- M3: Reconnect sessions and per-player hand privacy
- M4: Durable storage with Redis-capable room store and file fallback
- M5: Anonymous judging with alias-only winner selection
- M6: Session hardening, host controls, and lifecycle edge-case coverage

## Remote UX Action States

- Action buttons show in-progress labels during server acknowledgements (`Creating...`, `Joining...`, `Starting...`, `Submitting...`, `Advancing...`).
- While one remote action is pending, other mutating actions are temporarily disabled to prevent duplicate submissions and racey double-clicks.
- On disconnect, pending action state is cleared so controls recover cleanly after reconnect.

## Remote Multiplayer QA Checklist

Use this checklist before releases to validate failure/recovery paths:

1. Session recovery and stale sockets
- Rejoin with valid token reconnects to same room/player in lobby and in-game.
- Old socket is rejected after token takeover (`Session is no longer active.`).
- Saved session expiry falls back cleanly to manual room rejoin.

2. Lobby and join constraints
- Room rejects duplicate connected names (case-insensitive).
- Name can be reused after original player disconnects.
- Room capacity caps at 15 connected players; disconnected seats can be replaced.
- New joins are blocked once game is in progress (`Game already in progress.`).

3. Host and round authority
- Only host can start game.
- Host transfer works on disconnect and explicit leave.
- Only host can advance round from `round-over`.
- Transferred host can still advance rounds.

4. Judge fairness and privacy
- Judge sees anonymized submission aliases only.
- Raw player IDs are rejected for winner selection.
- Invalid aliases are rejected (`Winner is invalid.`).
- Anonymous alias mapping remains valid across judge reconnect.

5. Room lifecycle cleanup
- Starting game prunes disconnected lobby players.
- Pruned players cannot rejoin with old session tokens.
- Room is deleted when all players disconnect or final player explicitly leaves.

# Cards Against Humanity (Online Multiplayer)

A browser-based Cards Against Humanity style game focused on online rooms.

## Features

- Online multiplayer with room codes
- Server-authoritative game flow via Socket.IO
- Simultaneous non-judge submissions per round
- Judge-selected winner with anonymized submissions
- Session reconnection support
- Room persistence via file or Redis

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

3. Run frontend + server together:

```bash
npm run dev:all
```

4. Open frontend:

- http://localhost:5173

## Scripts

- npm run dev -> Vite frontend
- npm run server:dev -> multiplayer server
- npm run dev:all -> frontend + server concurrently
- npm run test -- --run -> run tests
- npm run build -> production build

## Environment Variables

See .env.example.

Important server settings:

- ROOM_STORE=file|redis
- REDIS_URL=redis://... when using Redis
- CORS_ORIGIN=https://your-frontend-domain

## Room Storage Backends

The server supports two persistence modes:

1. file (default)
- Uses server/data/rooms.json
- Good for local development and single-instance hosting

2. redis
- Uses REDIS_URL
- Better for production durability and scaling

If ROOM_STORE is omitted and REDIS_URL is set, Redis is used automatically.

## Deployment Notes

Recommended split deployment:

1. Frontend: Vercel
2. Server: Render / Fly.io / Railway / Azure / similar
3. Storage: Managed Redis

Set frontend env in Vercel:

- VITE_SERVER_URL=https://your-server-domain

Vercel project settings for this repo:

- Framework preset: Vite
- Install command: npm install
- Build command: npm run build
- Output directory: dist

vercel.json is included to keep deployment settings and SPA rewrites consistent.

Set server env in your backend host:

- PORT=3001 (or platform-assigned)
- CORS_ORIGIN=https://your-frontend-domain
- ROOM_STORE=redis
- REDIS_URL=redis://...

## How To Play

1. Host creates a room and shares the room code.
2. Other players join with room code and names.
3. Host starts the game when everyone is ready.
4. Each non-judge player submits cards in the answer phase.
5. Judge picks a winning anonymized submission.
6. Host advances to the next round until game over.

## Official Launch Prep

Use OFFICIAL_LAUNCH_CHECKLIST.md for launch-day prep without adding a full testing round.

## Known Limitations

Current MVP constraints are tracked in KNOWN_LIMITATIONS.md.

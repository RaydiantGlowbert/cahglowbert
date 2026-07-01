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
cp .env.example .env
```

3. Run frontend + multiplayer server together:

```bash
npm run dev:all
```

4. Open frontend:

- http://localhost:5173

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

Set server env in your backend host:

- `PORT=3001` (or platform-assigned)
- `CORS_ORIGIN=https://your-frontend-domain`
- `ROOM_STORE=redis`
- `REDIS_URL=redis://...`

## Current Multiplayer Milestones

- M1: Room create/join lobby flow
- M2: Server-authoritative remote gameplay flow
- M3: Reconnect sessions and per-player hand privacy
- M4: Durable storage with Redis-capable room store and file fallback

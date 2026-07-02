# 15-Player Event Runbook

Use this runbook when you are preparing a real 15-player room session.

## Goal

Run one stable event room with up to 15 connected players.

## 1. Required Production Settings

Set these in your backend host environment:

- ROOM_STORE=redis
- REDIS_URL=your-managed-redis-url
- CORS_ORIGIN=https://cards-against-humanity-mu.vercel.app

Set this in Vercel:

- VITE_SERVER_URL=https://cahglowbert.onrender.com

## 2. Why Redis Is Required for Event Use

- File-based storage is acceptable for local development.
- For hosted event reliability and persistence, Redis should be used.
- Server startup now fails fast if ROOM_STORE=redis is set without REDIS_URL.

## 3. Pre-Event Sequence (No Full Test Cycle)

Do this 30-60 minutes before event time:

1. Open the live frontend.
2. Confirm server status changes to Connected.
3. Create one room.
4. Join from one second browser session.
5. Start game and complete one round action path:
   - submit
   - judge pick
   - next round

If this single path succeeds once, proceed.

## 4. During Event

- Keep one host on stable desktop internet if possible.
- Ask players to stay in one tab and avoid force-closing during rounds.
- If someone disconnects, they should rejoin with same room code and name.

## 5. Fast Incident Response

If room flow breaks mid-event:

1. Post quick status update:
   - "We are applying a fix and will resume shortly."
2. Ask players to refresh and rejoin using room code.
3. If backend is unhealthy, restart backend service.
4. If issue persists, rollback to the previous Vercel deployment.

## 6. After Event

Capture basic issue notes:

- timestamp
- room code
- action being attempted
- screenshot or error text
- browser/device

Use this data to prioritize v1.1 fixes.

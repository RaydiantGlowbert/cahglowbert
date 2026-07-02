import cors from 'cors'
import express from 'express'
import { randomUUID } from 'crypto'
import { createServer } from 'http'
import path from 'path'
import { Server } from 'socket.io'
import {
  type Card,
  chooseWinner,
  createInitialGameState,
  endGame,
  nextRound,
  submitAnswer,
  type GameState
} from '../../src/game'
import { createRoomStore, type PersistedRoom } from './storage'
import type { RoomPlayer, RoomSnapshot, SocketAck } from './types'

const PORT = Number(process.env.PORT ?? 3001)
const MAX_PLAYERS = 15
const ROOM_CODE_LENGTH = 6
const ACTION_ACK_CACHE_LIMIT = 64
const ROOMS_STORE_PATH = path.resolve(process.cwd(), 'server', 'data', 'rooms.json')

function parseCorsOrigins(rawOrigins: string | undefined): string[] | '*' {
  const parsedOrigins = rawOrigins
    ?.split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0)

  return parsedOrigins && parsedOrigins.length > 0 ? parsedOrigins : '*'
}

const corsOrigins = parseCorsOrigins(process.env.CORS_ORIGIN)

type ActionAck = SocketAck | { ok: true } | { ok: false; error: string }

type RoomPlayerState = {
  id: string
  name: string
  isHost: boolean
  gamePlayerId?: string
  sessionToken: string
  socketId?: string
  connected: boolean
  actionAckCache: Map<string, ActionAck>
}

type Room = {
  roomCode: string
  players: Map<string, RoomPlayerState>
  phase: 'lobby' | 'in-game'
  gameState: GameState | null
  judgeAliasToPlayerId: Map<string, string>
  anonymizedSubmittedAnswers: Array<{ playerId: string; cards: Card[] }>
}

const roomStore = createRoomStore({
  mode: process.env.ROOM_STORE,
  redisUrl: process.env.REDIS_URL,
  filePath: ROOMS_STORE_PATH
})
const rooms = new Map<string, Room>()
let bootstrapped = false

function shuffleEntries<T>(items: T[]): T[] {
  const nextItems = [...items]

  for (let index = nextItems.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1))
    ;[nextItems[index], nextItems[swapIndex]] = [nextItems[swapIndex], nextItems[index]]
  }

  return nextItems
}

function serializeRooms(): PersistedRoom[] {
  return [...rooms.values()].map((room) => ({
    roomCode: room.roomCode,
    phase: room.phase,
    gameState: room.gameState,
    players: [...room.players.values()].map((player) => ({
      id: player.id,
      name: player.name,
      isHost: player.isHost,
      gamePlayerId: player.gamePlayerId,
      sessionToken: player.sessionToken,
      connected: player.connected
    }))
  }))
}

function persistRooms() {
  void roomStore.save(serializeRooms()).catch((error) => {
    console.error('Failed to persist rooms', error)
  })
}

function hydrateRooms(serializedRooms: PersistedRoom[]) {
  for (const room of serializedRooms) {
    const players = new Map<string, RoomPlayerState>()
    for (const player of room.players) {
      players.set(player.id, {
        ...player,
        connected: false,
        socketId: undefined,
        actionAckCache: new Map()
      })
    }

    rooms.set(room.roomCode, {
      roomCode: room.roomCode,
      phase: room.phase,
      gameState: room.gameState,
      players,
      judgeAliasToPlayerId: new Map(),
      anonymizedSubmittedAnswers: []
    })
  }
}

function readActionId(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') {
    return undefined
  }

  const actionId = (payload as { actionId?: unknown }).actionId
  if (typeof actionId !== 'string') {
    return undefined
  }

  const normalizedActionId = actionId.trim()
  return normalizedActionId.length > 0 ? normalizedActionId : undefined
}

function getCachedActionAck<TAck extends ActionAck>(
  requester: RoomPlayerState,
  eventName: string,
  payload: unknown
): TAck | undefined {
  const actionId = readActionId(payload)
  if (!actionId) {
    return undefined
  }

  return requester.actionAckCache.get(`${eventName}:${actionId}`) as TAck | undefined
}

function cacheActionAck(requester: RoomPlayerState, eventName: string, payload: unknown, ack: ActionAck) {
  const actionId = readActionId(payload)
  if (!actionId) {
    return
  }

  requester.actionAckCache.set(`${eventName}:${actionId}`, ack)

  if (requester.actionAckCache.size <= ACTION_ACK_CACHE_LIMIT) {
    return
  }

  const oldestKey = requester.actionAckCache.keys().next().value
  if (oldestKey) {
    requester.actionAckCache.delete(oldestKey)
  }
}

const app = express()
app.use(
  cors({
    origin: corsOrigins
  })
)
app.get('/health', (_request, response) => {
  response.json({ ok: true })
})

const httpServer = createServer(app)

const io = new Server(httpServer, {
  cors: {
    origin: corsOrigins
  }
})

function generateRoomCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let code = ''

  for (let index = 0; index < ROOM_CODE_LENGTH; index += 1) {
    code += alphabet[Math.floor(Math.random() * alphabet.length)]
  }

  return code
}

function createUniqueRoomCode(): string {
  let code = generateRoomCode()

  while (rooms.has(code)) {
    code = generateRoomCode()
  }

  return code
}

function toRoomSnapshot(room: Room): RoomSnapshot {
  const players: RoomPlayer[] = [...room.players.values()].map((player) => ({
    id: player.id,
    name: player.name,
    isHost: player.isHost,
    gamePlayerId: player.gamePlayerId,
    connected: player.connected
  }))

  return {
    roomCode: room.roomCode,
    players,
    phase: room.phase,
    gameState: room.gameState ?? undefined
  }
}

function refreshJudgeAnonymization(room: Room) {
  if (!room.gameState || room.gameState.phase !== 'waiting-for-judge') {
    room.judgeAliasToPlayerId.clear()
    room.anonymizedSubmittedAnswers = []
    return
  }

  if (room.anonymizedSubmittedAnswers.length === room.gameState.submittedAnswers.length) {
    return
  }

  const shuffledAnswers = shuffleEntries(room.gameState.submittedAnswers)
  room.judgeAliasToPlayerId.clear()
  room.anonymizedSubmittedAnswers = shuffledAnswers.map((answer, index) => {
    const aliasId = `submission-${index + 1}`
    room.judgeAliasToPlayerId.set(aliasId, answer.playerId)

    return {
      playerId: aliasId,
      cards: answer.cards
    }
  })
}

function maskGameStateForPlayer(room: Room, requesterGamePlayerId?: string): GameState | null {
  if (!room.gameState) {
    return null
  }

  refreshJudgeAnonymization(room)

  const submittedAnswers =
    room.gameState.phase === 'waiting-for-judge'
      ? room.anonymizedSubmittedAnswers
      : room.gameState.submittedAnswers

  return {
    ...room.gameState,
    submittedAnswers,
    players: room.gameState.players.map((player) => ({
      ...player,
      hand: requesterGamePlayerId === player.id ? player.hand : []
    }))
  }
}

function toRoomSnapshotForPlayer(room: Room, player: RoomPlayerState): RoomSnapshot {
  const baseSnapshot = toRoomSnapshot(room)

  return {
    ...baseSnapshot,
    gameState: maskGameStateForPlayer(room, player.gamePlayerId) ?? undefined
  }
}

function broadcastRoom(room: Room) {
  for (const player of room.players.values()) {
    if (!player.socketId || !player.connected) {
      continue
    }

    io.to(player.socketId).emit('room-updated', toRoomSnapshotForPlayer(room, player))
  }
}

function leaveCurrentRoom(socketId: string, roomCode: string | undefined, removePlayer: boolean) {
  if (!roomCode) {
    return
  }

  const room = rooms.get(roomCode)
  if (!room) {
    return
  }

  const removedPlayer = [...room.players.values()].find((player) => player.socketId === socketId)
  if (!removedPlayer) {
    return
  }

  if (removePlayer) {
    room.players.delete(removedPlayer.id)
  } else {
    removedPlayer.connected = false
    removedPlayer.socketId = undefined
    room.players.set(removedPlayer.id, removedPlayer)
  }

  if (room.players.size === 0 || [...room.players.values()].every((player) => !player.connected)) {
    rooms.delete(roomCode)
    persistRooms()
    return
  }

  if (removedPlayer.isHost) {
    const nextHost = [...room.players.values()].find((player) => player.connected)
    if (nextHost) {
      room.players.forEach((player) => {
        if (player.isHost) {
          player.isHost = false
        }
      })
      nextHost.isHost = true
      room.players.set(nextHost.id, nextHost)
    }
  }

  persistRooms()
  broadcastRoom(room)
}

function createPlayer(name: string, isHost: boolean, socketId: string): RoomPlayerState {
  return {
    id: randomUUID(),
    name,
    isHost,
    sessionToken: randomUUID(),
    socketId,
    connected: true,
    actionAckCache: new Map()
  }
}

function assignGamePlayerIds(room: Room) {
  if (!room.gameState) {
    return
  }

  const orderedPlayers = [...room.players.values()]
  orderedPlayers.forEach((player, index) => {
    player.gamePlayerId = room.gameState?.players[index]?.id
    room.players.set(player.id, player)
  })
}

io.on('connection', (socket) => {
  socket.on('create-room', (payload: { playerName?: string }, callback: (ack: SocketAck) => void) => {
    const playerName = payload.playerName?.trim()
    if (!playerName) {
      callback({ ok: false, error: 'Please enter a player name.' })
      return
    }

    leaveCurrentRoom(socket.id, socket.data.roomCode, true)

    const roomCode = createUniqueRoomCode()
    const room: Room = {
      roomCode,
      players: new Map(),
      phase: 'lobby',
      gameState: null,
      judgeAliasToPlayerId: new Map(),
      anonymizedSubmittedAnswers: []
    }

    const player = createPlayer(playerName, true, socket.id)

    room.players.set(player.id, player)
    rooms.set(roomCode, room)
    persistRooms()

    socket.data.roomCode = roomCode
    socket.data.playerId = player.id
    void socket.join(roomCode)

    const snapshot = toRoomSnapshotForPlayer(room, player)
    callback({ ok: true, room: snapshot, playerId: player.id, sessionToken: player.sessionToken })
    broadcastRoom(room)
  })

  socket.on(
    'join-room',
    (
      payload: { roomCode?: string; playerName?: string },
      callback: (ack: SocketAck) => void
    ) => {
      const roomCode = payload.roomCode?.trim().toUpperCase()
      const playerName = payload.playerName?.trim()

      if (!roomCode || !playerName) {
        callback({ ok: false, error: 'Room code and player name are required.' })
        return
      }

      const room = rooms.get(roomCode)
      if (!room) {
        callback({ ok: false, error: 'Room not found.' })
        return
      }

      if (room.phase !== 'lobby') {
        callback({ ok: false, error: 'Game already in progress.' })
        return
      }

      const connectedPlayersCount = [...room.players.values()].filter((player) => player.connected).length
      if (connectedPlayersCount >= MAX_PLAYERS) {
        callback({ ok: false, error: 'Room is full.' })
        return
      }

      const hasNameConflict = [...room.players.values()].some((player) => {
        if (!player.connected) {
          return false
        }

        return player.name.toLowerCase() === playerName.toLowerCase()
      })
      if (hasNameConflict) {
        callback({ ok: false, error: 'That player name is already in this room.' })
        return
      }

      leaveCurrentRoom(socket.id, socket.data.roomCode, true)

      const player = createPlayer(playerName, false, socket.id)

      room.players.set(player.id, player)
      persistRooms()
      socket.data.roomCode = roomCode
      socket.data.playerId = player.id
      void socket.join(roomCode)

      const snapshot = toRoomSnapshotForPlayer(room, player)
      callback({ ok: true, room: snapshot, playerId: player.id, sessionToken: player.sessionToken })
      broadcastRoom(room)
    }
  )

  socket.on(
    'rejoin-room',
    (
      payload: { roomCode?: string; sessionToken?: string },
      callback: (ack: SocketAck) => void
    ) => {
      const roomCode = payload.roomCode?.trim().toUpperCase()
      const sessionToken = payload.sessionToken?.trim()

      if (!roomCode || !sessionToken) {
        callback({ ok: false, error: 'Room code and session token are required.' })
        return
      }

      const room = rooms.get(roomCode)
      if (!room) {
        callback({ ok: false, error: 'Room not found.' })
        return
      }

      const matchingPlayer = [...room.players.values()].find(
        (player) => player.sessionToken === sessionToken
      )

      if (!matchingPlayer) {
        callback({ ok: false, error: 'Session expired for this room.' })
        return
      }

      leaveCurrentRoom(socket.id, socket.data.roomCode, true)

      matchingPlayer.socketId = socket.id
      matchingPlayer.connected = true
      room.players.set(matchingPlayer.id, matchingPlayer)
      persistRooms()

      socket.data.roomCode = roomCode
      socket.data.playerId = matchingPlayer.id
      void socket.join(roomCode)

      callback({
        ok: true,
        room: toRoomSnapshotForPlayer(room, matchingPlayer),
        playerId: matchingPlayer.id,
        sessionToken: matchingPlayer.sessionToken
      })

      broadcastRoom(room)
    }
  )

  socket.on('leave-room', () => {
    const roomCode = socket.data.roomCode as string | undefined
    const room = roomCode ? rooms.get(roomCode) : undefined
    const removePlayer = room?.phase !== 'in-game'

    leaveCurrentRoom(socket.id, roomCode, removePlayer)
    socket.data.roomCode = undefined
    socket.data.playerId = undefined
  })

  socket.on(
    'start-game',
    (
      payloadOrCallback:
        | { actionId?: string }
        | ((ack: SocketAck | { ok: false; error: string }) => void),
      maybeCallback?: (ack: SocketAck | { ok: false; error: string }) => void
    ) => {
      const payload = typeof payloadOrCallback === 'function' ? {} : payloadOrCallback
      const callback = typeof payloadOrCallback === 'function' ? payloadOrCallback : maybeCallback
      if (!callback) {
        return
      }

      const roomCode = socket.data.roomCode as string | undefined
      const room = roomCode ? rooms.get(roomCode) : undefined

      if (!room) {
        callback({ ok: false, error: 'Room not found.' })
        return
      }

      const requester = room.players.get(socket.data.playerId as string | undefined ?? '')
      if (!requester || !requester.connected || requester.socketId !== socket.id) {
        callback({ ok: false, error: 'Session is no longer active.' })
        return
      }

      const cachedAck = getCachedActionAck<SocketAck | { ok: false; error: string }>(requester, 'start-game', payload)
      if (cachedAck) {
        callback(cachedAck)
        return
      }

      if (room.phase !== 'lobby') {
        const ack = { ok: false, error: 'Game has already started.' } as const
        cacheActionAck(requester, 'start-game', payload, ack)
        callback(ack)
        return
      }

      if (!requester.isHost) {
        const ack = { ok: false, error: 'Only the host can start the game.' } as const
        cacheActionAck(requester, 'start-game', payload, ack)
        callback(ack)
        return
      }

      for (const player of [...room.players.values()]) {
        if (!player.connected) {
          room.players.delete(player.id)
        }
      }

      const players = [...room.players.values()].filter((player) => player.connected)
      if (players.length < 2) {
        const ack = { ok: false, error: 'At least two players are required.' } as const
        cacheActionAck(requester, 'start-game', payload, ack)
        callback(ack)
        return
      }

      const gameState = createInitialGameState(players.map((player) => player.name))
      room.gameState = gameState
      assignGamePlayerIds(room)

      room.phase = 'in-game'
      persistRooms()

      const ack: SocketAck = {
        ok: true,
        room: toRoomSnapshotForPlayer(room, requester),
        playerId: requester.id,
        sessionToken: requester.sessionToken
      }
      cacheActionAck(requester, 'start-game', payload, ack)
      callback(ack)
      broadcastRoom(room)
    }
  )

  socket.on(
    'submit-answer',
    (
      payload: { cardIds?: string[]; actionId?: string },
      callback: (ack: { ok: true } | { ok: false; error: string }) => void
    ) => {
      const roomCode = socket.data.roomCode as string | undefined
      const room = roomCode ? rooms.get(roomCode) : undefined

      if (!room || room.phase !== 'in-game' || !room.gameState) {
        callback({ ok: false, error: 'Game is not active.' })
        return
      }

      const requester = room.players.get(socket.data.playerId as string | undefined ?? '')
      if (!requester || !requester.connected || requester.socketId !== socket.id) {
        callback({ ok: false, error: 'Session is no longer active.' })
        return
      }

      const cachedAck = getCachedActionAck<{ ok: true } | { ok: false; error: string }>(
        requester,
        'submit-answer',
        payload
      )
      if (cachedAck) {
        callback(cachedAck)
        return
      }

      if (!requester.gamePlayerId) {
        const ack = { ok: false, error: 'Player not found in active game.' } as const
        cacheActionAck(requester, 'submit-answer', payload, ack)
        callback(ack)
        return
      }

      const currentState = room.gameState
      const nextState = submitAnswer(currentState, requester.gamePlayerId, payload.cardIds ?? [])
      if (nextState === currentState) {
        const ack = { ok: false, error: 'Invalid submission for current turn.' } as const
        cacheActionAck(requester, 'submit-answer', payload, ack)
        callback(ack)
        return
      }

      room.gameState = nextState
      persistRooms()

      const ack = { ok: true } as const
      cacheActionAck(requester, 'submit-answer', payload, ack)
      callback(ack)
      broadcastRoom(room)
    }
  )

  socket.on(
    'choose-winner',
    (
      payload: { winnerId?: string; actionId?: string },
      callback: (ack: { ok: true } | { ok: false; error: string }) => void
    ) => {
      const roomCode = socket.data.roomCode as string | undefined
      const room = roomCode ? rooms.get(roomCode) : undefined

      if (!room || room.phase !== 'in-game' || !room.gameState) {
        callback({ ok: false, error: 'Game is not active.' })
        return
      }

      const requester = room.players.get(socket.data.playerId as string | undefined ?? '')
      if (!requester || !requester.connected || requester.socketId !== socket.id) {
        callback({ ok: false, error: 'Session is no longer active.' })
        return
      }

      const cachedAck = getCachedActionAck<{ ok: true } | { ok: false; error: string }>(
        requester,
        'choose-winner',
        payload
      )
      if (cachedAck) {
        callback(cachedAck)
        return
      }

      const judgePlayerId = room.gameState.players[room.gameState.judgeIndex]?.id
      if (!requester.gamePlayerId || requester.gamePlayerId !== judgePlayerId) {
        const ack = { ok: false, error: 'Only the judge can pick a winner.' } as const
        cacheActionAck(requester, 'choose-winner', payload, ack)
        callback(ack)
        return
      }

      if (room.gameState.phase !== 'waiting-for-judge') {
        const ack = { ok: false, error: 'Round is not ready for judging.' } as const
        cacheActionAck(requester, 'choose-winner', payload, ack)
        callback(ack)
        return
      }

      if (!payload.winnerId) {
        const ack = { ok: false, error: 'Winner is required.' } as const
        cacheActionAck(requester, 'choose-winner', payload, ack)
        callback(ack)
        return
      }

      refreshJudgeAnonymization(room)

      const resolvedWinnerId = room.judgeAliasToPlayerId.get(payload.winnerId)
      if (!resolvedWinnerId) {
        const ack = { ok: false, error: 'Winner is invalid.' } as const
        cacheActionAck(requester, 'choose-winner', payload, ack)
        callback(ack)
        return
      }

      const isSubmittedPlayer = room.gameState.submittedAnswers.some(
        (submittedAnswer) => submittedAnswer.playerId === resolvedWinnerId
      )
      if (!isSubmittedPlayer) {
        const ack = { ok: false, error: 'Winner is invalid.' } as const
        cacheActionAck(requester, 'choose-winner', payload, ack)
        callback(ack)
        return
      }

      const nextState = chooseWinner(room.gameState, resolvedWinnerId)
      room.gameState = nextState
      persistRooms()

      const ack = { ok: true } as const
      cacheActionAck(requester, 'choose-winner', payload, ack)
      callback(ack)
      broadcastRoom(room)
    }
  )

  socket.on(
    'end-game',
    (
      payloadOrCallback:
        | { actionId?: string }
        | ((ack: { ok: true } | { ok: false; error: string }) => void),
      maybeCallback?: (ack: { ok: true } | { ok: false; error: string }) => void
    ) => {
      const payload = typeof payloadOrCallback === 'function' ? {} : payloadOrCallback
      const callback = typeof payloadOrCallback === 'function' ? payloadOrCallback : maybeCallback
      if (!callback) {
        return
      }

      const roomCode = socket.data.roomCode as string | undefined
      const room = roomCode ? rooms.get(roomCode) : undefined

      if (!room || room.phase !== 'in-game' || !room.gameState) {
        callback({ ok: false, error: 'Game is not active.' })
        return
      }

      const requester = room.players.get(socket.data.playerId as string | undefined ?? '')
      if (!requester || !requester.connected || requester.socketId !== socket.id) {
        callback({ ok: false, error: 'Session is no longer active.' })
        return
      }

      const cachedAck = getCachedActionAck<{ ok: true } | { ok: false; error: string }>(
        requester,
        'end-game',
        payload
      )
      if (cachedAck) {
        callback(cachedAck)
        return
      }

      if (!requester.isHost) {
        const ack = { ok: false, error: 'Only the host can end the game.' } as const
        cacheActionAck(requester, 'end-game', payload, ack)
        callback(ack)
        return
      }

      if (room.gameState.phase === 'game-over') {
        const ack = { ok: false, error: 'Game has already ended.' } as const
        cacheActionAck(requester, 'end-game', payload, ack)
        callback(ack)
        return
      }

      room.gameState = endGame(room.gameState)
      persistRooms()

      const ack = { ok: true } as const
      cacheActionAck(requester, 'end-game', payload, ack)
      callback(ack)
      broadcastRoom(room)
    }
  )

  socket.on(
    'next-round',
    (
      payloadOrCallback:
        | { actionId?: string }
        | ((ack: { ok: true } | { ok: false; error: string }) => void),
      maybeCallback?: (ack: { ok: true } | { ok: false; error: string }) => void
    ) => {
    const payload = typeof payloadOrCallback === 'function' ? {} : payloadOrCallback
    const callback = typeof payloadOrCallback === 'function' ? payloadOrCallback : maybeCallback
    if (!callback) {
      return
    }

    const roomCode = socket.data.roomCode as string | undefined
    const room = roomCode ? rooms.get(roomCode) : undefined

    if (!room || room.phase !== 'in-game' || !room.gameState) {
      callback({ ok: false, error: 'Game is not active.' })
      return
    }

    const requester = room.players.get(socket.data.playerId as string | undefined ?? '')
    if (!requester || !requester.connected || requester.socketId !== socket.id) {
      callback({ ok: false, error: 'Session is no longer active.' })
      return
    }

    const cachedAck = getCachedActionAck<{ ok: true } | { ok: false; error: string }>(
      requester,
      'next-round',
      payload
    )
    if (cachedAck) {
      callback(cachedAck)
      return
    }

    if (!requester.isHost) {
      const ack = { ok: false, error: 'Only the host can advance rounds.' } as const
      cacheActionAck(requester, 'next-round', payload, ack)
      callback(ack)
      return
    }

    if (room.gameState.phase !== 'round-over') {
      const ack = { ok: false, error: 'Round is not ready to advance.' } as const
      cacheActionAck(requester, 'next-round', payload, ack)
      callback(ack)
      return
    }

    room.gameState = nextRound(room.gameState)
    persistRooms()
    const ack = { ok: true } as const
    cacheActionAck(requester, 'next-round', payload, ack)
    callback(ack)
    broadcastRoom(room)
    }
  )

  socket.on('disconnect', () => {
    leaveCurrentRoom(socket.id, socket.data.roomCode, false)
  })
})

export async function bootstrap() {
  if (bootstrapped) {
    return
  }

  const restoredRooms = await roomStore.load()
  rooms.clear()
  hydrateRooms(restoredRooms)

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject)
    httpServer.listen(PORT, () => {
      httpServer.off('error', reject)
      console.log(`Multiplayer server listening on http://localhost:${PORT}`)
      console.log(
        `Room storage mode: ${process.env.ROOM_STORE?.trim().toLowerCase() || (process.env.REDIS_URL ? 'redis(auto)' : 'file')}`
      )
      console.log(`CORS origin mode: ${Array.isArray(corsOrigins) ? corsOrigins.join(', ') : 'all origins (*)'}`)
      resolve()
    })
  })

  bootstrapped = true
}

export async function shutdown() {
  if (!bootstrapped) {
    return
  }

  await new Promise<void>((resolve, reject) => {
    io.close((ioError) => {
      if (ioError) {
        reject(ioError)
        return
      }

      if (!httpServer.listening) {
        resolve()
        return
      }

      httpServer.close((serverError) => {
        if (serverError) {
          reject(serverError)
          return
        }

        resolve()
      })
    })
  })

  rooms.clear()
  bootstrapped = false
}

if (process.env.NODE_ENV !== 'test') {
  void bootstrap()
}

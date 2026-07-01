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
  nextRound,
  submitAnswer,
  type GameState
} from '../../src/game'
import { createRoomStore, type PersistedRoom } from './storage'
import type { RoomPlayer, RoomSnapshot, SocketAck } from './types'

const PORT = Number(process.env.PORT ?? 3001)
const MAX_PLAYERS = 15
const ROOM_CODE_LENGTH = 6
const ROOMS_STORE_PATH = path.resolve(process.cwd(), 'server', 'data', 'rooms.json')

type RoomPlayerState = {
  id: string
  name: string
  isHost: boolean
  gamePlayerId?: string
  sessionToken: string
  socketId?: string
  connected: boolean
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
        socketId: undefined
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

const app = express()
app.use(
  cors({
    origin: process.env.CORS_ORIGIN?.split(',').map((origin) => origin.trim()) ?? '*'
  })
)
app.get('/health', (_request, response) => {
  response.json({ ok: true })
})

const httpServer = createServer(app)

const io = new Server(httpServer, {
  cors: {
    origin: process.env.CORS_ORIGIN?.split(',').map((origin) => origin.trim()) ?? '*'
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
    connected: true
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
    leaveCurrentRoom(socket.id, socket.data.roomCode, true)
    socket.data.roomCode = undefined
    socket.data.playerId = undefined
  })

  socket.on('start-game', (callback: (ack: SocketAck | { ok: false; error: string }) => void) => {
    const roomCode = socket.data.roomCode as string | undefined
    const room = roomCode ? rooms.get(roomCode) : undefined

    if (!room) {
      callback({ ok: false, error: 'Room not found.' })
      return
    }

    if (room.phase !== 'lobby') {
      callback({ ok: false, error: 'Game has already started.' })
      return
    }

      const requester = room.players.get(socket.data.playerId as string | undefined ?? '')
    if (!requester?.isHost) {
      callback({ ok: false, error: 'Only the host can start the game.' })
      return
    }

    for (const player of [...room.players.values()]) {
      if (!player.connected) {
        room.players.delete(player.id)
      }
    }

      const players = [...room.players.values()].filter((player) => player.connected)
    if (players.length < 2) {
      callback({ ok: false, error: 'At least two players are required.' })
      return
    }

    const gameState = createInitialGameState(players.map((player) => player.name))
      room.gameState = gameState
      assignGamePlayerIds(room)

    room.phase = 'in-game'
    persistRooms()

      callback({
        ok: true,
        room: toRoomSnapshotForPlayer(room, requester),
        playerId: requester.id,
        sessionToken: requester.sessionToken
      })
    broadcastRoom(room)
  })

  socket.on(
    'submit-answer',
    (
      payload: { cardIds?: string[] },
      callback: (ack: { ok: true } | { ok: false; error: string }) => void
    ) => {
      const roomCode = socket.data.roomCode as string | undefined
      const room = roomCode ? rooms.get(roomCode) : undefined

      if (!room || room.phase !== 'in-game' || !room.gameState) {
        callback({ ok: false, error: 'Game is not active.' })
        return
      }

      const requester = room.players.get(socket.data.playerId as string | undefined ?? '')
      if (!requester?.gamePlayerId) {
        callback({ ok: false, error: 'Player not found in active game.' })
        return
      }

      const currentState = room.gameState
      const nextState = submitAnswer(currentState, requester.gamePlayerId, payload.cardIds ?? [])
      if (nextState === currentState) {
        callback({ ok: false, error: 'Invalid submission for current turn.' })
        return
      }

      room.gameState = nextState
      persistRooms()

      callback({ ok: true })
      broadcastRoom(room)
    }
  )

  socket.on(
    'choose-winner',
    (
      payload: { winnerId?: string },
      callback: (ack: { ok: true } | { ok: false; error: string }) => void
    ) => {
      const roomCode = socket.data.roomCode as string | undefined
      const room = roomCode ? rooms.get(roomCode) : undefined

      if (!room || room.phase !== 'in-game' || !room.gameState) {
        callback({ ok: false, error: 'Game is not active.' })
        return
      }

      const requester = room.players.get(socket.data.playerId as string | undefined ?? '')
      const judgePlayerId = room.gameState.players[room.gameState.judgeIndex]?.id
      if (!requester?.gamePlayerId || requester.gamePlayerId !== judgePlayerId) {
        callback({ ok: false, error: 'Only the judge can pick a winner.' })
        return
      }

      if (room.gameState.phase !== 'waiting-for-judge') {
        callback({ ok: false, error: 'Round is not ready for judging.' })
        return
      }

      if (!payload.winnerId) {
        callback({ ok: false, error: 'Winner is required.' })
        return
      }

      const resolvedWinnerId = room.judgeAliasToPlayerId.get(payload.winnerId) ?? payload.winnerId
      const isSubmittedPlayer = room.gameState.submittedAnswers.some(
        (submittedAnswer) => submittedAnswer.playerId === resolvedWinnerId
      )
      if (!isSubmittedPlayer) {
        callback({ ok: false, error: 'Winner is invalid.' })
        return
      }

      const nextState = chooseWinner(room.gameState, resolvedWinnerId)
      room.gameState = nextState
      persistRooms()

      callback({ ok: true })
      broadcastRoom(room)
    }
  )

  socket.on('next-round', (callback: (ack: { ok: true } | { ok: false; error: string }) => void) => {
    const roomCode = socket.data.roomCode as string | undefined
    const room = roomCode ? rooms.get(roomCode) : undefined

    if (!room || room.phase !== 'in-game' || !room.gameState) {
      callback({ ok: false, error: 'Game is not active.' })
      return
    }

    const requester = room.players.get(socket.data.playerId as string | undefined ?? '')
    if (!requester) {
      callback({ ok: false, error: 'Player not found in room.' })
      return
    }

    if (room.gameState.phase !== 'round-over') {
      callback({ ok: false, error: 'Round is not ready to advance.' })
      return
    }

    room.gameState = nextRound(room.gameState)
    persistRooms()
    callback({ ok: true })
    broadcastRoom(room)
  })

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

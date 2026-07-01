import cors from 'cors'
import express from 'express'
import { randomUUID } from 'crypto'
import fs from 'fs'
import { createServer } from 'http'
import path from 'path'
import { Server } from 'socket.io'
import {
  chooseWinner,
  createInitialGameState,
  nextRound,
  submitAnswer,
  type GameState
} from '../../src/game'
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
}

type PersistedRoom = {
  roomCode: string
  players: Array<Omit<RoomPlayerState, 'socketId' | 'connected'> & { connected: boolean }>
  phase: 'lobby' | 'in-game'
  gameState: GameState | null
}

function ensureStoreDirectory() {
  const directory = path.dirname(ROOMS_STORE_PATH)
  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true })
  }
}

function persistRoomsToDisk(rooms: Map<string, Room>) {
  ensureStoreDirectory()

  const payload: PersistedRoom[] = [...rooms.values()].map((room) => ({
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

  fs.writeFileSync(ROOMS_STORE_PATH, JSON.stringify(payload, null, 2), 'utf8')
}

function loadRoomsFromDisk(): Map<string, Room> {
  try {
    if (!fs.existsSync(ROOMS_STORE_PATH)) {
      return new Map<string, Room>()
    }

    const raw = fs.readFileSync(ROOMS_STORE_PATH, 'utf8')
    if (!raw.trim()) {
      return new Map<string, Room>()
    }

    const parsed = JSON.parse(raw) as PersistedRoom[]
    const recoveredRooms = new Map<string, Room>()

    for (const room of parsed) {
      const players = new Map<string, RoomPlayerState>()
      for (const player of room.players) {
        players.set(player.id, {
          ...player,
          connected: false,
          socketId: undefined
        })
      }

      recoveredRooms.set(room.roomCode, {
        roomCode: room.roomCode,
        phase: room.phase,
        gameState: room.gameState,
        players
      })
    }

    return recoveredRooms
  } catch {
    return new Map<string, Room>()
  }
}

const rooms = loadRoomsFromDisk()

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

function maskGameStateForPlayer(gameState: GameState | null, requesterGamePlayerId?: string): GameState | null {
  if (!gameState) {
    return null
  }

  return {
    ...gameState,
    players: gameState.players.map((player) => ({
      ...player,
      hand: requesterGamePlayerId === player.id ? player.hand : []
    }))
  }
}

function toRoomSnapshotForPlayer(room: Room, player: RoomPlayerState): RoomSnapshot {
  const baseSnapshot = toRoomSnapshot(room)

  return {
    ...baseSnapshot,
    gameState: maskGameStateForPlayer(room.gameState, player.gamePlayerId) ?? undefined
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
    persistRoomsToDisk(rooms)
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

  persistRoomsToDisk(rooms)
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
      gameState: null
    }

    const player = createPlayer(playerName, true, socket.id)

    room.players.set(player.id, player)
    rooms.set(roomCode, room)
    persistRoomsToDisk(rooms)

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

      if (room.players.size >= MAX_PLAYERS) {
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
      persistRoomsToDisk(rooms)
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
      persistRoomsToDisk(rooms)

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
    persistRoomsToDisk(rooms)

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

      const nextState = submitAnswer(room.gameState, requester.gamePlayerId, payload.cardIds ?? [])
      room.gameState = nextState
      persistRoomsToDisk(rooms)

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

      if (!payload.winnerId) {
        callback({ ok: false, error: 'Winner is required.' })
        return
      }

      const nextState = chooseWinner(room.gameState, payload.winnerId)
      room.gameState = nextState
      persistRoomsToDisk(rooms)

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
    persistRoomsToDisk(rooms)
    callback({ ok: true })
    broadcastRoom(room)
  })

  socket.on('disconnect', () => {
    leaveCurrentRoom(socket.id, socket.data.roomCode, false)
  })
})

httpServer.listen(PORT, () => {
  console.log(`Multiplayer server listening on http://localhost:${PORT}`)
})

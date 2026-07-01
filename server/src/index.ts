import cors from 'cors'
import express from 'express'
import { createServer } from 'http'
import { Server } from 'socket.io'
import type { RoomPlayer, RoomSnapshot, SocketAck } from './types'

const PORT = Number(process.env.PORT ?? 3001)
const MAX_PLAYERS = 15
const ROOM_CODE_LENGTH = 6

type Room = {
  roomCode: string
  players: Map<string, RoomPlayer>
}

const rooms = new Map<string, Room>()

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
  return {
    roomCode: room.roomCode,
    players: [...room.players.values()],
    phase: 'lobby'
  }
}

function broadcastRoom(room: Room) {
  io.to(room.roomCode).emit('room-updated', toRoomSnapshot(room))
}

function leaveCurrentRoom(socketId: string, roomCode: string | undefined) {
  if (!roomCode) {
    return
  }

  const room = rooms.get(roomCode)
  if (!room) {
    return
  }

  const removedPlayer = room.players.get(socketId)
  if (!removedPlayer) {
    return
  }

  room.players.delete(socketId)

  if (room.players.size === 0) {
    rooms.delete(roomCode)
    return
  }

  if (removedPlayer.isHost) {
    const nextHost = room.players.values().next().value as RoomPlayer | undefined
    if (nextHost) {
      nextHost.isHost = true
      room.players.set(nextHost.id, nextHost)
    }
  }

  broadcastRoom(room)
}

io.on('connection', (socket) => {
  socket.on('create-room', (payload: { playerName?: string }, callback: (ack: SocketAck) => void) => {
    const playerName = payload.playerName?.trim()
    if (!playerName) {
      callback({ ok: false, error: 'Please enter a player name.' })
      return
    }

    leaveCurrentRoom(socket.id, socket.data.roomCode)

    const roomCode = createUniqueRoomCode()
    const room: Room = {
      roomCode,
      players: new Map()
    }

    const player: RoomPlayer = {
      id: socket.id,
      name: playerName,
      isHost: true
    }

    room.players.set(socket.id, player)
    rooms.set(roomCode, room)

    socket.data.roomCode = roomCode
    void socket.join(roomCode)

    const snapshot = toRoomSnapshot(room)
    callback({ ok: true, room: snapshot, playerId: socket.id })
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

      const hasNameConflict = [...room.players.values()].some(
        (player) => player.name.toLowerCase() === playerName.toLowerCase()
      )
      if (hasNameConflict) {
        callback({ ok: false, error: 'That player name is already in this room.' })
        return
      }

      leaveCurrentRoom(socket.id, socket.data.roomCode)

      const player: RoomPlayer = {
        id: socket.id,
        name: playerName,
        isHost: false
      }

      room.players.set(socket.id, player)
      socket.data.roomCode = roomCode
      void socket.join(roomCode)

      const snapshot = toRoomSnapshot(room)
      callback({ ok: true, room: snapshot, playerId: socket.id })
      broadcastRoom(room)
    }
  )

  socket.on('leave-room', () => {
    leaveCurrentRoom(socket.id, socket.data.roomCode)
    socket.data.roomCode = undefined
  })

  socket.on('disconnect', () => {
    leaveCurrentRoom(socket.id, socket.data.roomCode)
  })
})

httpServer.listen(PORT, () => {
  console.log(`Multiplayer server listening on http://localhost:${PORT}`)
})

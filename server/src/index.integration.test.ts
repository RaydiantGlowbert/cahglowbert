// @vitest-environment node

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { io as createClient, type Socket } from 'socket.io-client'
import type { RoomSnapshot, SocketAck } from './types'

process.env.NODE_ENV = 'test'
process.env.PORT = '3011'
process.env.ROOM_STORE = 'memory'

const { bootstrap, shutdown } = await import('./index')

const SERVER_URL = 'http://localhost:3011'

type BoolAck = { ok: true } | { ok: false; error: string }

function connectClient(): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createClient(SERVER_URL, {
      transports: ['websocket'],
      forceNew: true
    })

    socket.once('connect', () => resolve(socket))
    socket.once('connect_error', reject)
  })
}

function emitAck<TAck>(socket: Socket, event: string, payload?: unknown): Promise<TAck> {
  return new Promise((resolve) => {
    if (payload === undefined) {
      socket.emit(event, (ack: TAck) => resolve(ack))
      return
    }

    socket.emit(event, payload, (ack: TAck) => resolve(ack))
  })
}

function waitForRoomUpdated(socket: Socket, predicate: (room: RoomSnapshot) => boolean): Promise<RoomSnapshot> {
  return new Promise((resolve) => {
    const handler = (room: RoomSnapshot) => {
      if (!predicate(room)) {
        return
      }

      socket.off('room-updated', handler)
      resolve(room)
    }

    socket.on('room-updated', handler)
  })
}

describe('remote multiplayer server integration', () => {
  beforeAll(async () => {
    await bootstrap()
  })

  afterAll(async () => {
    await shutdown()
  })

  it('enforces host-only start game', async () => {
    const host = await connectClient()
    const guest = await connectClient()

    try {
      const createAck = await emitAck<SocketAck>(host, 'create-room', { playerName: 'Host' })
      expect(createAck.ok).toBe(true)
      if (!createAck.ok) {
        return
      }

      const joinAck = await emitAck<SocketAck>(guest, 'join-room', {
        roomCode: createAck.room.roomCode,
        playerName: 'Guest'
      })
      expect(joinAck.ok).toBe(true)

      const startByGuest = await emitAck<SocketAck | { ok: false; error: string }>(guest, 'start-game')
      expect(startByGuest.ok).toBe(false)
      if (startByGuest.ok) {
        return
      }

      expect(startByGuest.error).toContain('Only the host')
    } finally {
      host.disconnect()
      guest.disconnect()
    }
  })

  it(
    'keeps judge submissions anonymous and resolves winner aliases server-side',
    async () => {
    const host = await connectClient()
    const guest = await connectClient()

    try {
      const createAck = await emitAck<SocketAck>(host, 'create-room', { playerName: 'Host' })
      expect(createAck.ok).toBe(true)
      if (!createAck.ok) {
        return
      }

      const joinAck = await emitAck<SocketAck>(guest, 'join-room', {
        roomCode: createAck.room.roomCode,
        playerName: 'Guest'
      })
      expect(joinAck.ok).toBe(true)
      if (!joinAck.ok) {
        return
      }

      const hostInGamePromise = waitForRoomUpdated(
        host,
        (room) => room.phase === 'in-game' && Boolean(room.gameState)
      )
      const guestInGamePromise = waitForRoomUpdated(
        guest,
        (room) => room.phase === 'in-game' && Boolean(room.gameState)
      )

      const startAck = await emitAck<SocketAck | { ok: false; error: string }>(host, 'start-game')
      expect(startAck.ok).toBe(true)

      const hostInGame = await hostInGamePromise
      const guestInGame = await guestInGamePromise

      const hostPlayer = hostInGame.players.find((player) => player.id === createAck.playerId)
      const guestPlayer = guestInGame.players.find((player) => player.id === joinAck.playerId)

      expect(hostPlayer?.gamePlayerId).toBeTruthy()
      expect(guestPlayer?.gamePlayerId).toBeTruthy()
      if (!hostPlayer?.gamePlayerId || !guestPlayer?.gamePlayerId || !hostInGame.gameState || !guestInGame.gameState) {
        return
      }

      const judgePlayerId = hostInGame.gameState.players[hostInGame.gameState.judgeIndex]?.id
      const answeringPlayerId = hostInGame.gameState.answeringPlayerId
      expect(judgePlayerId).toBeTruthy()
      expect(answeringPlayerId).toBeTruthy()
      if (!judgePlayerId || !answeringPlayerId) {
        return
      }

      const answeringSocket = hostPlayer.gamePlayerId === answeringPlayerId ? host : guest
      const answeringRoom = hostPlayer.gamePlayerId === answeringPlayerId ? hostInGame : guestInGame
      const answeringGamePlayer = answeringRoom.gameState.players.find((player) => player.id === answeringPlayerId)

      expect(answeringGamePlayer?.hand.length).toBeGreaterThan(0)
      if (!answeringGamePlayer?.hand.length) {
        return
      }

      const judgeSocket = hostPlayer.gamePlayerId === judgePlayerId ? host : guest
      const nonJudgeSocket = judgeSocket === host ? guest : host

      const judgeViewPromise = waitForRoomUpdated(
        judgeSocket,
        (room) => room.gameState?.phase === 'waiting-for-judge' && Boolean(room.gameState.submittedAnswers.length)
      )

      const submitAck = await emitAck<BoolAck>(answeringSocket, 'submit-answer', {
        cardIds: [answeringGamePlayer.hand[0].id]
      })
      expect(submitAck.ok).toBe(true)

      const judgeView = await judgeViewPromise

      expect(judgeView.gameState?.submittedAnswers.length).toBe(1)
      const aliasId = judgeView.gameState?.submittedAnswers[0]?.playerId
      expect(aliasId).toMatch(/^submission-\d+$/)
      expect(aliasId).not.toBe(answeringPlayerId)
      if (!aliasId) {
        return
      }

      const nonJudgePickAck = await emitAck<BoolAck>(nonJudgeSocket, 'choose-winner', { winnerId: aliasId })
      expect(nonJudgePickAck.ok).toBe(false)

      const roundOverPromise = waitForRoomUpdated(
        judgeSocket,
        (room) => room.gameState?.phase === 'round-over' && Boolean(room.gameState.winnerId)
      )

      const judgePickAck = await emitAck<BoolAck>(judgeSocket, 'choose-winner', { winnerId: aliasId })
      expect(judgePickAck.ok).toBe(true)

      const roundOverView = await roundOverPromise

      expect(roundOverView.gameState?.winnerId).toBe(answeringPlayerId)
    } finally {
      host.disconnect()
      guest.disconnect()
    }
    },
    15000
  )

  it('allows in-game rejoin by session token and preserves hand privacy', async () => {
    const host = await connectClient()
    const guest = await connectClient()

    try {
      const createAck = await emitAck<SocketAck>(host, 'create-room', { playerName: 'Host' })
      expect(createAck.ok).toBe(true)
      if (!createAck.ok) {
        return
      }

      const joinAck = await emitAck<SocketAck>(guest, 'join-room', {
        roomCode: createAck.room.roomCode,
        playerName: 'Guest'
      })
      expect(joinAck.ok).toBe(true)
      if (!joinAck.ok) {
        return
      }

      const hostInGamePromise = waitForRoomUpdated(
        host,
        (room) => room.phase === 'in-game' && Boolean(room.gameState)
      )

      const startAck = await emitAck<SocketAck | { ok: false; error: string }>(host, 'start-game')
      expect(startAck.ok).toBe(true)

      const hostInGame = await hostInGamePromise
      const hostPlayer = hostInGame.players.find((player) => player.id === createAck.playerId)
      const guestPlayer = hostInGame.players.find((player) => player.id === joinAck.playerId)

      expect(hostPlayer?.gamePlayerId).toBeTruthy()
      expect(guestPlayer?.gamePlayerId).toBeTruthy()
      expect(hostInGame.gameState).toBeTruthy()
      if (!hostPlayer?.gamePlayerId || !guestPlayer?.gamePlayerId || !hostInGame.gameState) {
        return
      }

      const guestGamePlayerInHostView = hostInGame.gameState.players.find(
        (player) => player.id === guestPlayer.gamePlayerId
      )

      expect(guestGamePlayerInHostView?.hand).toEqual([])

      guest.disconnect()

      const guestRejoinSocket = await connectClient()
      try {
        const rejoinAck = await emitAck<SocketAck>(guestRejoinSocket, 'rejoin-room', {
          roomCode: createAck.room.roomCode,
          sessionToken: joinAck.sessionToken
        })

        expect(rejoinAck.ok).toBe(true)
        if (!rejoinAck.ok) {
          return
        }

        expect(rejoinAck.playerId).toBe(joinAck.playerId)
        const rejoinGuestPlayer = rejoinAck.room.players.find((player) => player.id === joinAck.playerId)
        expect(rejoinGuestPlayer?.connected).toBe(true)
        expect(rejoinGuestPlayer?.gamePlayerId).toBe(guestPlayer.gamePlayerId)

        const rejoinGameState = rejoinAck.room.gameState
        expect(rejoinGameState).toBeTruthy()
        if (!rejoinGameState) {
          return
        }

        const rejoinSelf = rejoinGameState.players.find((player) => player.id === guestPlayer.gamePlayerId)
        const rejoinHost = rejoinGameState.players.find((player) => player.id === hostPlayer.gamePlayerId)

        expect(rejoinSelf?.hand.length).toBeGreaterThan(0)
        expect(rejoinHost?.hand).toEqual([])
      } finally {
        guestRejoinSocket.disconnect()
      }
    } finally {
      host.disconnect()
      guest.disconnect()
    }
  })
})

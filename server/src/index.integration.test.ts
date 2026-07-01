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

  it('transfers host in lobby and only the new host can start', async () => {
    const host = await connectClient()
    const guestOne = await connectClient()
    const guestTwo = await connectClient()

    try {
      const createAck = await emitAck<SocketAck>(host, 'create-room', { playerName: 'Host' })
      expect(createAck.ok).toBe(true)
      if (!createAck.ok) {
        return
      }

      const joinOneAck = await emitAck<SocketAck>(guestOne, 'join-room', {
        roomCode: createAck.room.roomCode,
        playerName: 'Guest One'
      })
      expect(joinOneAck.ok).toBe(true)
      if (!joinOneAck.ok) {
        return
      }

      const joinTwoAck = await emitAck<SocketAck>(guestTwo, 'join-room', {
        roomCode: createAck.room.roomCode,
        playerName: 'Guest Two'
      })
      expect(joinTwoAck.ok).toBe(true)
      if (!joinTwoAck.ok) {
        return
      }

      const hostTransferredPromise = waitForRoomUpdated(guestOne, (room) => {
        if (room.phase !== 'lobby') {
          return false
        }

        const guestOnePlayer = room.players.find((player) => player.id === joinOneAck.playerId)
        return Boolean(guestOnePlayer?.isHost)
      })

      host.disconnect()

      const transferredRoom = await hostTransferredPromise
      const transferredHost = transferredRoom.players.find((player) => player.id === joinOneAck.playerId)
      const otherGuest = transferredRoom.players.find((player) => player.id === joinTwoAck.playerId)

      expect(transferredHost?.isHost).toBe(true)
      expect(otherGuest?.isHost).toBe(false)

      const startByNonHost = await emitAck<SocketAck | { ok: false; error: string }>(guestTwo, 'start-game')
      expect(startByNonHost.ok).toBe(false)

      const startByNewHost = await emitAck<SocketAck | { ok: false; error: string }>(guestOne, 'start-game')
      expect(startByNewHost.ok).toBe(true)
    } finally {
      host.disconnect()
      guestOne.disconnect()
      guestTwo.disconnect()
    }
  })

  it('transfers host in-game when the host disconnects', async () => {
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

      const inGamePromise = waitForRoomUpdated(guest, (room) => room.phase === 'in-game' && Boolean(room.gameState))
      const startAck = await emitAck<SocketAck | { ok: false; error: string }>(host, 'start-game')
      expect(startAck.ok).toBe(true)
      await inGamePromise

      const hostTransferredPromise = waitForRoomUpdated(guest, (room) => {
        if (room.phase !== 'in-game') {
          return false
        }

        const guestPlayer = room.players.find((player) => player.id === joinAck.playerId)
        return Boolean(guestPlayer?.isHost)
      })

      host.disconnect()

      const transferredRoom = await hostTransferredPromise
      const guestPlayer = transferredRoom.players.find((player) => player.id === joinAck.playerId)
      expect(guestPlayer?.isHost).toBe(true)
      expect(transferredRoom.phase).toBe('in-game')
      expect(transferredRoom.gameState).toBeTruthy()
    } finally {
      host.disconnect()
      guest.disconnect()
    }
  })

  it(
    'shows only anonymous aliases to judge with multiple submissions',
    async () => {
      const host = await connectClient()
      const guestOne = await connectClient()
      const guestTwo = await connectClient()

      try {
        const createAck = await emitAck<SocketAck>(host, 'create-room', { playerName: 'Host' })
        expect(createAck.ok).toBe(true)
        if (!createAck.ok) {
          return
        }

        const joinOneAck = await emitAck<SocketAck>(guestOne, 'join-room', {
          roomCode: createAck.room.roomCode,
          playerName: 'Guest One'
        })
        expect(joinOneAck.ok).toBe(true)
        if (!joinOneAck.ok) {
          return
        }

        const joinTwoAck = await emitAck<SocketAck>(guestTwo, 'join-room', {
          roomCode: createAck.room.roomCode,
          playerName: 'Guest Two'
        })
        expect(joinTwoAck.ok).toBe(true)
        if (!joinTwoAck.ok) {
          return
        }

        const hostInGamePromise = waitForRoomUpdated(
          host,
          (room) => room.phase === 'in-game' && Boolean(room.gameState)
        )
        const guestOneInGamePromise = waitForRoomUpdated(
          guestOne,
          (room) => room.phase === 'in-game' && Boolean(room.gameState)
        )
        const guestTwoInGamePromise = waitForRoomUpdated(
          guestTwo,
          (room) => room.phase === 'in-game' && Boolean(room.gameState)
        )

        const startAck = await emitAck<SocketAck | { ok: false; error: string }>(host, 'start-game')
        expect(startAck.ok).toBe(true)

        const hostInGame = await hostInGamePromise
        const guestOneInGame = await guestOneInGamePromise
        const guestTwoInGame = await guestTwoInGamePromise

        expect(hostInGame.gameState).toBeTruthy()
        if (!hostInGame.gameState) {
          return
        }

        const playerToSocket = new Map<string, Socket>([
          [createAck.playerId, host],
          [joinOneAck.playerId, guestOne],
          [joinTwoAck.playerId, guestTwo]
        ])
        const playerToSelfView = new Map<string, RoomSnapshot>([
          [createAck.playerId, hostInGame],
          [joinOneAck.playerId, guestOneInGame],
          [joinTwoAck.playerId, guestTwoInGame]
        ])
        const playerToGamePlayerId = new Map<string, string>()

        for (const roomPlayer of hostInGame.players) {
          if (roomPlayer.gamePlayerId) {
            playerToGamePlayerId.set(roomPlayer.id, roomPlayer.gamePlayerId)
          }
        }

        const judgePlayerId = hostInGame.gameState.players[hostInGame.gameState.judgeIndex]?.id
        const firstAnsweringPlayerId = hostInGame.gameState.answeringPlayerId

        expect(judgePlayerId).toBeTruthy()
        expect(firstAnsweringPlayerId).toBeTruthy()
        if (!judgePlayerId || !firstAnsweringPlayerId) {
          return
        }

        const findRoomPlayerIdByGamePlayerId = (gamePlayerId: string) =>
          [...playerToGamePlayerId.entries()].find((entry) => entry[1] === gamePlayerId)?.[0]

        const firstAnsweringRoomPlayerId = findRoomPlayerIdByGamePlayerId(firstAnsweringPlayerId)
        expect(firstAnsweringRoomPlayerId).toBeTruthy()
        if (!firstAnsweringRoomPlayerId) {
          return
        }

        const firstAnsweringSocket = playerToSocket.get(firstAnsweringRoomPlayerId)
        const firstAnsweringView = playerToSelfView.get(firstAnsweringRoomPlayerId)
        const firstAnsweringHand = firstAnsweringView?.gameState?.players.find(
          (player) => player.id === firstAnsweringPlayerId
        )?.hand

        expect(firstAnsweringSocket).toBeTruthy()
        expect(firstAnsweringHand?.length).toBeGreaterThan(0)
        if (!firstAnsweringSocket || !firstAnsweringHand || firstAnsweringHand.length === 0) {
          return
        }

        const secondAnswerTurnPromise = waitForRoomUpdated(
          host,
          (room) =>
            room.gameState?.phase === 'waiting-for-answers' &&
            room.gameState.submittedAnswers.length === 1 &&
            Boolean(room.gameState.answeringPlayerId)
        )

        const firstSubmitAck = await emitAck<BoolAck>(firstAnsweringSocket, 'submit-answer', {
          cardIds: [firstAnsweringHand[0].id]
        })
        expect(firstSubmitAck.ok).toBe(true)

        const secondTurnRoom = await secondAnswerTurnPromise
        const secondAnsweringPlayerId = secondTurnRoom.gameState?.answeringPlayerId
        expect(secondAnsweringPlayerId).toBeTruthy()
        if (!secondAnsweringPlayerId) {
          return
        }

        const secondAnsweringRoomPlayerId = findRoomPlayerIdByGamePlayerId(secondAnsweringPlayerId)
        expect(secondAnsweringRoomPlayerId).toBeTruthy()
        if (!secondAnsweringRoomPlayerId) {
          return
        }

        const secondAnsweringSocket = playerToSocket.get(secondAnsweringRoomPlayerId)
        const secondAnsweringView = playerToSelfView.get(secondAnsweringRoomPlayerId)
        const secondAnsweringHand = secondAnsweringView?.gameState?.players.find(
          (player) => player.id === secondAnsweringPlayerId
        )?.hand

        expect(secondAnsweringSocket).toBeTruthy()
        expect(secondAnsweringHand?.length).toBeGreaterThan(0)
        if (!secondAnsweringSocket || !secondAnsweringHand || secondAnsweringHand.length === 0) {
          return
        }

        const judgeRoomPlayerId = findRoomPlayerIdByGamePlayerId(judgePlayerId)
        expect(judgeRoomPlayerId).toBeTruthy()
        if (!judgeRoomPlayerId) {
          return
        }

        const judgeSocket = playerToSocket.get(judgeRoomPlayerId)
        expect(judgeSocket).toBeTruthy()
        if (!judgeSocket) {
          return
        }

        const judgeViewPromise = waitForRoomUpdated(
          judgeSocket,
          (room) => room.gameState?.phase === 'waiting-for-judge' && room.gameState.submittedAnswers.length === 2
        )

        const secondSubmitAck = await emitAck<BoolAck>(secondAnsweringSocket, 'submit-answer', {
          cardIds: [secondAnsweringHand[0].id]
        })
        expect(secondSubmitAck.ok).toBe(true)

        const judgeView = await judgeViewPromise
        const judgeSubmittedAnswers = judgeView.gameState?.submittedAnswers ?? []
        const aliasIds = judgeSubmittedAnswers.map((entry) => entry.playerId)
        const realAnsweringIds = [firstAnsweringPlayerId, secondAnsweringPlayerId]

        expect(aliasIds).toHaveLength(2)
        expect(new Set(aliasIds).size).toBe(2)
        expect(aliasIds.every((id) => /^submission-\d+$/.test(id))).toBe(true)
        expect(aliasIds.some((id) => realAnsweringIds.includes(id))).toBe(false)
      } finally {
        host.disconnect()
        guestOne.disconnect()
        guestTwo.disconnect()
      }
    },
    20000
  )
})

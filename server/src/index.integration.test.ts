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
type SuccessSocketAck = Extract<SocketAck, { ok: true }>
type TwoPlayerSetup = {
  host: Socket
  guest: Socket
  createAck: SuccessSocketAck
  joinAck: SuccessSocketAck
  hostInGame?: RoomSnapshot
  guestInGame?: RoomSnapshot
}

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

function requireOkAck(ack: SocketAck): SuccessSocketAck {
  expect(ack.ok).toBe(true)
  if (!ack.ok) {
    throw new Error(ack.error)
  }

  return ack
}

function disconnectSockets(...sockets: Socket[]) {
  for (const socket of sockets) {
    socket.disconnect()
  }
}

async function setupTwoPlayerRoom(options?: { startGame?: boolean }): Promise<TwoPlayerSetup> {
  const startGame = options?.startGame ?? true
  const host = await connectClient()
  const guest = await connectClient()

  const createAck = requireOkAck(await emitAck<SocketAck>(host, 'create-room', { playerName: 'Host' }))
  const joinAck = requireOkAck(
    await emitAck<SocketAck>(guest, 'join-room', {
      roomCode: createAck.room.roomCode,
      playerName: 'Guest'
    })
  )

  if (!startGame) {
    return {
      host,
      guest,
      createAck,
      joinAck
    }
  }

  const hostInGamePromise = waitForRoomUpdated(host, (room) => room.phase === 'in-game' && Boolean(room.gameState))
  const guestInGamePromise = waitForRoomUpdated(
    guest,
    (room) => room.phase === 'in-game' && Boolean(room.gameState)
  )

  const startAck = await emitAck<SocketAck | { ok: false; error: string }>(host, 'start-game')
  expect(startAck.ok).toBe(true)

  return {
    host,
    guest,
    createAck,
    joinAck,
    hostInGame: await hostInGamePromise,
    guestInGame: await guestInGamePromise
  }
}

type ThreePlayerJudgePhaseSetup = {
  host: Socket
  guestOne: Socket
  guestTwo: Socket
  createAck: SuccessSocketAck
  judgeSocket: Socket
  judgeView: RoomSnapshot
  aliasIds: string[]
  realAnsweringIds: string[]
}

async function setupThreePlayerJudgePhase(): Promise<ThreePlayerJudgePhaseSetup> {
  const host = await connectClient()
  const guestOne = await connectClient()
  const guestTwo = await connectClient()

  const createAck = requireOkAck(await emitAck<SocketAck>(host, 'create-room', { playerName: 'Host' }))
  const joinOneAck = requireOkAck(
    await emitAck<SocketAck>(guestOne, 'join-room', {
      roomCode: createAck.room.roomCode,
      playerName: 'Guest One'
    })
  )
  const joinTwoAck = requireOkAck(
    await emitAck<SocketAck>(guestTwo, 'join-room', {
      roomCode: createAck.room.roomCode,
      playerName: 'Guest Two'
    })
  )

  const hostInGamePromise = waitForRoomUpdated(host, (room) => room.phase === 'in-game' && Boolean(room.gameState))
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
    throw new Error('Missing game state after start-game')
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
    throw new Error('Missing judge or first answering player')
  }

  const findRoomPlayerIdByGamePlayerId = (gamePlayerId: string) =>
    [...playerToGamePlayerId.entries()].find((entry) => entry[1] === gamePlayerId)?.[0]

  const firstAnsweringRoomPlayerId = findRoomPlayerIdByGamePlayerId(firstAnsweringPlayerId)
  expect(firstAnsweringRoomPlayerId).toBeTruthy()
  if (!firstAnsweringRoomPlayerId) {
    throw new Error('Missing first answering room player')
  }

  const firstAnsweringSocket = playerToSocket.get(firstAnsweringRoomPlayerId)
  const firstAnsweringView = playerToSelfView.get(firstAnsweringRoomPlayerId)
  const firstAnsweringHand = firstAnsweringView?.gameState?.players.find(
    (player) => player.id === firstAnsweringPlayerId
  )?.hand
  expect(firstAnsweringSocket).toBeTruthy()
  expect(firstAnsweringHand?.length).toBeGreaterThan(0)
  if (!firstAnsweringSocket || !firstAnsweringHand || firstAnsweringHand.length === 0) {
    throw new Error('Missing first answering hand or socket')
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
    throw new Error('Missing second answering player')
  }

  const secondAnsweringRoomPlayerId = findRoomPlayerIdByGamePlayerId(secondAnsweringPlayerId)
  expect(secondAnsweringRoomPlayerId).toBeTruthy()
  if (!secondAnsweringRoomPlayerId) {
    throw new Error('Missing second answering room player')
  }

  const secondAnsweringSocket = playerToSocket.get(secondAnsweringRoomPlayerId)
  const secondAnsweringView = playerToSelfView.get(secondAnsweringRoomPlayerId)
  const secondAnsweringHand = secondAnsweringView?.gameState?.players.find(
    (player) => player.id === secondAnsweringPlayerId
  )?.hand
  expect(secondAnsweringSocket).toBeTruthy()
  expect(secondAnsweringHand?.length).toBeGreaterThan(0)
  if (!secondAnsweringSocket || !secondAnsweringHand || secondAnsweringHand.length === 0) {
    throw new Error('Missing second answering hand or socket')
  }

  const judgeRoomPlayerId = findRoomPlayerIdByGamePlayerId(judgePlayerId)
  expect(judgeRoomPlayerId).toBeTruthy()
  if (!judgeRoomPlayerId) {
    throw new Error('Missing judge room player')
  }

  const judgeSocket = playerToSocket.get(judgeRoomPlayerId)
  expect(judgeSocket).toBeTruthy()
  if (!judgeSocket) {
    throw new Error('Missing judge socket')
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
  const aliasIds = (judgeView.gameState?.submittedAnswers ?? []).map((entry) => entry.playerId)

  expect(aliasIds).toHaveLength(2)
  expect(aliasIds.every((id) => /^submission-\d+$/.test(id))).toBe(true)

  return {
    host,
    guestOne,
    guestTwo,
    createAck,
    judgeSocket,
    judgeView,
    aliasIds,
    realAnsweringIds: [firstAnsweringPlayerId, secondAnsweringPlayerId]
  }
}

describe('remote multiplayer server integration', () => {
  beforeAll(async () => {
    await bootstrap()
  })

  afterAll(async () => {
    await shutdown()
  })

  it('enforces host-only start game', async () => {
    const setup = await setupTwoPlayerRoom({ startGame: false })
    try {
      const startByGuest = await emitAck<SocketAck | { ok: false; error: string }>(setup.guest, 'start-game')
      expect(startByGuest.ok).toBe(false)
      if (startByGuest.ok) {
        return
      }

      expect(startByGuest.error).toContain('Only the host')
    } finally {
      disconnectSockets(setup.host, setup.guest)
    }
  })

  it('rejects rejoin when session token is invalid', async () => {
    const setup = await setupTwoPlayerRoom({ startGame: false })
    const outsider = await connectClient()

    try {
      const rejoinAck = await emitAck<SocketAck>(outsider, 'rejoin-room', {
        roomCode: setup.createAck.room.roomCode,
        sessionToken: 'not-a-real-session-token'
      })

      expect(rejoinAck.ok).toBe(false)
      if (rejoinAck.ok) {
        return
      }

      expect(rejoinAck.error).toBe('Session expired for this room.')
    } finally {
      disconnectSockets(setup.host, setup.guest, outsider)
    }
  })

  it(
    'keeps judge submissions anonymous and resolves winner aliases server-side',
    async () => {
    const setup = await setupTwoPlayerRoom()
    try {
      const hostInGame = setup.hostInGame
      const guestInGame = setup.guestInGame

      expect(hostInGame).toBeTruthy()
      expect(guestInGame).toBeTruthy()
      if (!hostInGame || !guestInGame) {
        return
      }

      const hostPlayer = hostInGame.players.find((player) => player.id === setup.createAck.playerId)
      const guestPlayer = guestInGame.players.find((player) => player.id === setup.joinAck.playerId)

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

      const answeringSocket = hostPlayer.gamePlayerId === answeringPlayerId ? setup.host : setup.guest
      const answeringRoom = hostPlayer.gamePlayerId === answeringPlayerId ? hostInGame : guestInGame
      const answeringGamePlayer = answeringRoom.gameState.players.find((player) => player.id === answeringPlayerId)

      expect(answeringGamePlayer?.hand.length).toBeGreaterThan(0)
      if (!answeringGamePlayer?.hand.length) {
        return
      }

      const judgeSocket = hostPlayer.gamePlayerId === judgePlayerId ? setup.host : setup.guest
      const nonJudgeSocket = judgeSocket === setup.host ? setup.guest : setup.host

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
      disconnectSockets(setup.host, setup.guest)
    }
    },
    15000
  )

  it('allows in-game rejoin by session token and preserves hand privacy', async () => {
    const setup = await setupTwoPlayerRoom()
    try {
      const hostInGame = setup.hostInGame
      expect(hostInGame).toBeTruthy()
      if (!hostInGame) {
        return
      }

      const hostPlayer = hostInGame.players.find((player) => player.id === setup.createAck.playerId)
      const guestPlayer = hostInGame.players.find((player) => player.id === setup.joinAck.playerId)

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

      setup.guest.disconnect()

      const guestRejoinSocket = await connectClient()
      try {
        const rejoinAck = await emitAck<SocketAck>(guestRejoinSocket, 'rejoin-room', {
          roomCode: setup.createAck.room.roomCode,
          sessionToken: setup.joinAck.sessionToken
        })

        expect(rejoinAck.ok).toBe(true)
        if (!rejoinAck.ok) {
          return
        }

        expect(rejoinAck.playerId).toBe(setup.joinAck.playerId)
        const rejoinGuestPlayer = rejoinAck.room.players.find((player) => player.id === setup.joinAck.playerId)
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
      disconnectSockets(setup.host, setup.guest)
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
    const setup = await setupTwoPlayerRoom()
    try {
      const hostTransferredPromise = waitForRoomUpdated(setup.guest, (room) => {
        if (room.phase !== 'in-game') {
          return false
        }

        const guestPlayer = room.players.find((player) => player.id === setup.joinAck.playerId)
        return Boolean(guestPlayer?.isHost)
      })

      setup.host.disconnect()

      const transferredRoom = await hostTransferredPromise
      const guestPlayer = transferredRoom.players.find((player) => player.id === setup.joinAck.playerId)
      expect(guestPlayer?.isHost).toBe(true)
      expect(transferredRoom.phase).toBe('in-game')
      expect(transferredRoom.gameState).toBeTruthy()
    } finally {
      disconnectSockets(setup.host, setup.guest)
    }
  })

  it(
    'shows only anonymous aliases to judge with multiple submissions',
    async () => {
      const setup = await setupThreePlayerJudgePhase()
      try {
        expect(setup.aliasIds).toHaveLength(2)
        expect(new Set(setup.aliasIds).size).toBe(2)
        expect(setup.aliasIds.every((id) => /^submission-\d+$/.test(id))).toBe(true)
        expect(setup.aliasIds.some((id) => setup.realAnsweringIds.includes(id))).toBe(false)
      } finally {
        disconnectSockets(setup.host, setup.guestOne, setup.guestTwo)
      }
    },
    20000
  )

  it(
    'preserves anonymous aliases when judge rejoins during judge phase',
    async () => {
      const setup = await setupThreePlayerJudgePhase()
      try {
        const initialAliasIds = setup.aliasIds
        expect(initialAliasIds).toHaveLength(2)
        expect(initialAliasIds.every((id) => /^submission-\d+$/.test(id))).toBe(true)

        setup.judgeSocket.disconnect()

        const rejoinedJudgeSocket = await connectClient()
        try {
          const rejoinAck = await emitAck<SocketAck>(rejoinedJudgeSocket, 'rejoin-room', {
            roomCode: setup.createAck.room.roomCode,
            sessionToken: setup.createAck.sessionToken
          })

          expect(rejoinAck.ok).toBe(true)
          if (!rejoinAck.ok) {
            return
          }

          expect(rejoinAck.playerId).toBe(setup.createAck.playerId)
          expect(rejoinAck.room.gameState?.phase).toBe('waiting-for-judge')

          const rejoinAliasIds = (rejoinAck.room.gameState?.submittedAnswers ?? []).map((entry) => entry.playerId)
          expect(rejoinAliasIds).toEqual(initialAliasIds)

          const roundOverPromise = waitForRoomUpdated(
            rejoinedJudgeSocket,
            (room) => room.gameState?.phase === 'round-over' && Boolean(room.gameState.winnerId)
          )

          const pickAck = await emitAck<BoolAck>(rejoinedJudgeSocket, 'choose-winner', {
            winnerId: initialAliasIds[0]
          })
          expect(pickAck.ok).toBe(true)

          const roundOverView = await roundOverPromise
          const winnerId = roundOverView.gameState?.winnerId

          expect(winnerId).toBeTruthy()
          expect(typeof winnerId).toBe('string')
          expect(/^submission-\d+$/.test(winnerId ?? '')).toBe(false)
        } finally {
          rejoinedJudgeSocket.disconnect()
        }
      } finally {
        disconnectSockets(setup.host, setup.guestOne, setup.guestTwo)
      }
    },
    25000
  )
})

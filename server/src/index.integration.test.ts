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

  it('accepts only one start-game when host triggers it repeatedly', async () => {
    const setup = await setupTwoPlayerRoom({ startGame: false })

    try {
      const firstStart = emitAck<SocketAck | { ok: false; error: string }>(setup.host, 'start-game')
      const secondStart = emitAck<SocketAck | { ok: false; error: string }>(setup.host, 'start-game')
      const [firstStartAck, secondStartAck] = await Promise.all([firstStart, secondStart])

      const successCount = Number(firstStartAck.ok) + Number(secondStartAck.ok)
      expect(successCount).toBe(1)

      const failedStart = firstStartAck.ok ? secondStartAck : firstStartAck
      expect(failedStart.error).toBe('Game has already started.')
    } finally {
      disconnectSockets(setup.host, setup.guest)
    }
  })

  it('replays start-game acknowledgement for duplicate actionId', async () => {
    const setup = await setupTwoPlayerRoom({ startGame: false })

    try {
      const actionId = 'start-replay-1'
      const firstStartAck = await emitAck<SocketAck | { ok: false; error: string }>(setup.host, 'start-game', {
        actionId
      })
      expect(firstStartAck.ok).toBe(true)

      const secondStartAck = await emitAck<SocketAck | { ok: false; error: string }>(setup.host, 'start-game', {
        actionId
      })
      expect(secondStartAck.ok).toBe(true)
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

  it('rejects join when room code does not exist', async () => {
    const player = await connectClient()

    try {
      const joinAck = await emitAck<SocketAck>(player, 'join-room', {
        roomCode: 'ZZZZZZ',
        playerName: 'Player'
      })

      expect(joinAck.ok).toBe(false)
      if (joinAck.ok) {
        return
      }

      expect(joinAck.error).toBe('Room not found.')
    } finally {
      disconnectSockets(player)
    }
  })

  it('rejects rejoin when room code does not exist', async () => {
    const player = await connectClient()

    try {
      const rejoinAck = await emitAck<SocketAck>(player, 'rejoin-room', {
        roomCode: 'ZZZZZZ',
        sessionToken: 'fake-token'
      })

      expect(rejoinAck.ok).toBe(false)
      if (rejoinAck.ok) {
        return
      }

      expect(rejoinAck.error).toBe('Room not found.')
    } finally {
      disconnectSockets(player)
    }
  })

  it('rejects joining when room is full at 15 players', async () => {
    const sockets: Socket[] = []

    try {
      const host = await connectClient()
      sockets.push(host)

      const createAck = requireOkAck(await emitAck<SocketAck>(host, 'create-room', { playerName: 'Host' }))

      for (let index = 0; index < 14; index += 1) {
        const player = await connectClient()
        sockets.push(player)

        const joinAck = await emitAck<SocketAck>(player, 'join-room', {
          roomCode: createAck.room.roomCode,
          playerName: `Player ${index + 1}`
        })

        expect(joinAck.ok).toBe(true)
      }

      const overflowPlayer = await connectClient()
      sockets.push(overflowPlayer)

      const overflowAck = await emitAck<SocketAck>(overflowPlayer, 'join-room', {
        roomCode: createAck.room.roomCode,
        playerName: 'Player 16'
      })

      expect(overflowAck.ok).toBe(false)
      if (overflowAck.ok) {
        return
      }

      expect(overflowAck.error).toBe('Room is full.')
    } finally {
      disconnectSockets(...sockets)
    }
  })

  it('allows joining when a previously connected player disconnects from a full room', async () => {
    const sockets: Socket[] = []

    try {
      const host = await connectClient()
      sockets.push(host)

      const createAck = requireOkAck(await emitAck<SocketAck>(host, 'create-room', { playerName: 'Host' }))

      const playersByName = new Map<string, Socket>()

      for (let index = 0; index < 14; index += 1) {
        const player = await connectClient()
        sockets.push(player)

        const name = `Player ${index + 1}`
        const joinAck = await emitAck<SocketAck>(player, 'join-room', {
          roomCode: createAck.room.roomCode,
          playerName: name
        })

        expect(joinAck.ok).toBe(true)
        playersByName.set(name, player)
      }

      const disconnectedSeenByHost = waitForRoomUpdated(host, (room) => {
        const disconnectedPlayer = room.players.find((player) => player.name === 'Player 1')
        return Boolean(disconnectedPlayer && !disconnectedPlayer.connected)
      })

      playersByName.get('Player 1')?.disconnect()
      await disconnectedSeenByHost

      const replacement = await connectClient()
      sockets.push(replacement)

      const replacementJoinAck = await emitAck<SocketAck>(replacement, 'join-room', {
        roomCode: createAck.room.roomCode,
        playerName: 'Replacement Player'
      })

      expect(replacementJoinAck.ok).toBe(true)
    } finally {
      disconnectSockets(...sockets)
    }
  })

  it('rejects case-insensitive duplicate player names for connected players', async () => {
    const sockets: Socket[] = []

    try {
      const host = await connectClient()
      sockets.push(host)

      const createAck = requireOkAck(await emitAck<SocketAck>(host, 'create-room', { playerName: 'Host' }))

      const guestOne = await connectClient()
      sockets.push(guestOne)
      const joinOneAck = await emitAck<SocketAck>(guestOne, 'join-room', {
        roomCode: createAck.room.roomCode,
        playerName: 'Guest'
      })
      expect(joinOneAck.ok).toBe(true)

      const guestTwo = await connectClient()
      sockets.push(guestTwo)
      const joinTwoAck = await emitAck<SocketAck>(guestTwo, 'join-room', {
        roomCode: createAck.room.roomCode,
        playerName: 'gUeSt'
      })

      expect(joinTwoAck.ok).toBe(false)
      if (joinTwoAck.ok) {
        return
      }

      expect(joinTwoAck.error).toBe('That player name is already in this room.')
    } finally {
      disconnectSockets(...sockets)
    }
  })

  it('allows reusing a player name after that player disconnects', async () => {
    const sockets: Socket[] = []

    try {
      const host = await connectClient()
      sockets.push(host)

      const createAck = requireOkAck(await emitAck<SocketAck>(host, 'create-room', { playerName: 'Host' }))

      const guestOne = await connectClient()
      sockets.push(guestOne)
      const joinOneAck = requireOkAck(
        await emitAck<SocketAck>(guestOne, 'join-room', {
          roomCode: createAck.room.roomCode,
          playerName: 'Guest'
        })
      )

      const disconnectedGuestSeenByHost = waitForRoomUpdated(host, (room) => {
        const guest = room.players.find((player) => player.id === joinOneAck.playerId)
        return Boolean(guest && !guest.connected)
      })

      guestOne.disconnect()
      await disconnectedGuestSeenByHost

      const replacementGuest = await connectClient()
      sockets.push(replacementGuest)
      const replacementJoinAck = await emitAck<SocketAck>(replacementGuest, 'join-room', {
        roomCode: createAck.room.roomCode,
        playerName: 'gUeSt'
      })

      expect(replacementJoinAck.ok).toBe(true)
    } finally {
      disconnectSockets(...sockets)
    }
  })

  it('rejects rejoin when using a session token from a different room', async () => {
    const sockets: Socket[] = []

    try {
      const roomOneHost = await connectClient()
      sockets.push(roomOneHost)
      const roomOneCreateAck = requireOkAck(
        await emitAck<SocketAck>(roomOneHost, 'create-room', { playerName: 'Room One Host' })
      )

      const roomOneGuest = await connectClient()
      sockets.push(roomOneGuest)
      const roomOneJoinAck = requireOkAck(
        await emitAck<SocketAck>(roomOneGuest, 'join-room', {
          roomCode: roomOneCreateAck.room.roomCode,
          playerName: 'Room One Guest'
        })
      )

      const roomTwoHost = await connectClient()
      sockets.push(roomTwoHost)
      const roomTwoCreateAck = requireOkAck(
        await emitAck<SocketAck>(roomTwoHost, 'create-room', { playerName: 'Room Two Host' })
      )

      const outsider = await connectClient()
      sockets.push(outsider)
      const crossRoomRejoinAck = await emitAck<SocketAck>(outsider, 'rejoin-room', {
        roomCode: roomTwoCreateAck.room.roomCode,
        sessionToken: roomOneJoinAck.sessionToken
      })

      expect(crossRoomRejoinAck.ok).toBe(false)
      if (crossRoomRejoinAck.ok) {
        return
      }

      expect(crossRoomRejoinAck.error).toBe('Session expired for this room.')
    } finally {
      disconnectSockets(...sockets)
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

  it('rejects invalid winner id from judge and keeps round playable', async () => {
    const setup = await setupTwoPlayerRoom()
    try {
      const hostInGame = setup.hostInGame
      const guestInGame = setup.guestInGame

      expect(hostInGame).toBeTruthy()
      expect(guestInGame).toBeTruthy()
      if (!hostInGame || !guestInGame || !hostInGame.gameState || !guestInGame.gameState) {
        return
      }

      const hostPlayer = hostInGame.players.find((player) => player.id === setup.createAck.playerId)
      const guestPlayer = guestInGame.players.find((player) => player.id === setup.joinAck.playerId)

      expect(hostPlayer?.gamePlayerId).toBeTruthy()
      expect(guestPlayer?.gamePlayerId).toBeTruthy()
      if (!hostPlayer?.gamePlayerId || !guestPlayer?.gamePlayerId) {
        return
      }

      const judgePlayerId = hostInGame.gameState.players[hostInGame.gameState.judgeIndex]?.id
      const answeringPlayerId = hostInGame.gameState.answeringPlayerId
      expect(judgePlayerId).toBeTruthy()
      expect(answeringPlayerId).toBeTruthy()
      if (!judgePlayerId || !answeringPlayerId) {
        return
      }

      const judgeSocket = hostPlayer.gamePlayerId === judgePlayerId ? setup.host : setup.guest
      const answeringSocket = hostPlayer.gamePlayerId === answeringPlayerId ? setup.host : setup.guest
      const answeringRoom = hostPlayer.gamePlayerId === answeringPlayerId ? hostInGame : guestInGame
      const answeringHand = answeringRoom.gameState.players.find((player) => player.id === answeringPlayerId)?.hand

      expect(answeringHand?.length).toBeGreaterThan(0)
      if (!answeringHand || answeringHand.length === 0) {
        return
      }

      const judgeViewPromise = waitForRoomUpdated(
        judgeSocket,
        (room) => room.gameState?.phase === 'waiting-for-judge' && room.gameState.submittedAnswers.length === 1
      )

      const submitAck = await emitAck<BoolAck>(answeringSocket, 'submit-answer', {
        cardIds: [answeringHand[0].id]
      })
      expect(submitAck.ok).toBe(true)

      const judgeView = await judgeViewPromise
      const validAlias = judgeView.gameState?.submittedAnswers[0]?.playerId
      expect(validAlias).toBeTruthy()
      if (!validAlias) {
        return
      }

      const invalidPickAck = await emitAck<BoolAck>(judgeSocket, 'choose-winner', {
        winnerId: 'submission-999'
      })
      expect(invalidPickAck.ok).toBe(false)
      if (invalidPickAck.ok) {
        return
      }

      expect(invalidPickAck.error).toBe('Winner is invalid.')

      const rawPlayerPickAck = await emitAck<BoolAck>(judgeSocket, 'choose-winner', {
        winnerId: answeringPlayerId
      })
      expect(rawPlayerPickAck.ok).toBe(false)
      if (rawPlayerPickAck.ok) {
        return
      }

      expect(rawPlayerPickAck.error).toBe('Winner is invalid.')

      const roundOverPromise = waitForRoomUpdated(
        judgeSocket,
        (room) => room.gameState?.phase === 'round-over' && Boolean(room.gameState.winnerId)
      )

      const validPickAck = await emitAck<BoolAck>(judgeSocket, 'choose-winner', {
        winnerId: validAlias
      })
      expect(validPickAck.ok).toBe(true)

      const roundOverView = await roundOverPromise
      expect(roundOverView.gameState?.phase).toBe('round-over')
    } finally {
      disconnectSockets(setup.host, setup.guest)
    }
  })

  it('rejects submit-answer from the judge', async () => {
    const setup = await setupTwoPlayerRoom()
    try {
      const hostInGame = setup.hostInGame
      const guestInGame = setup.guestInGame

      expect(hostInGame).toBeTruthy()
      expect(guestInGame).toBeTruthy()
      if (!hostInGame || !guestInGame || !hostInGame.gameState || !guestInGame.gameState) {
        return
      }

      const hostPlayer = hostInGame.players.find((player) => player.id === setup.createAck.playerId)
      const guestPlayer = guestInGame.players.find((player) => player.id === setup.joinAck.playerId)

      expect(hostPlayer?.gamePlayerId).toBeTruthy()
      expect(guestPlayer?.gamePlayerId).toBeTruthy()
      if (!hostPlayer?.gamePlayerId || !guestPlayer?.gamePlayerId) {
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
      const judgeSocket = hostPlayer.gamePlayerId === judgePlayerId ? setup.host : setup.guest
      const judgeView = judgeSocket === setup.host ? hostInGame : guestInGame
      const answeringView = answeringSocket === setup.host ? hostInGame : guestInGame

      const judgeHand = judgeView.gameState.players.find(
        (player) => player.id === judgePlayerId
      )?.hand
      const answeringHand = answeringView.gameState.players.find(
        (player) => player.id === answeringPlayerId
      )?.hand

      expect(judgeHand?.length).toBeGreaterThan(0)
      expect(answeringHand?.length).toBeGreaterThan(0)
      if (!judgeHand || !answeringHand || judgeHand.length === 0 || answeringHand.length === 0) {
        return
      }

      const invalidSubmitAck = await emitAck<BoolAck>(judgeSocket, 'submit-answer', {
        cardIds: [judgeHand[0].id]
      })
      expect(invalidSubmitAck.ok).toBe(false)
      if (invalidSubmitAck.ok) {
        return
      }

      expect(invalidSubmitAck.error).toBe('Invalid submission for current turn.')

      const judgeViewPromise = waitForRoomUpdated(
        setup.host,
        (room) => room.gameState?.phase === 'waiting-for-judge' && room.gameState.submittedAnswers.length === 1
      )

      const validSubmitAck = await emitAck<BoolAck>(answeringSocket, 'submit-answer', {
        cardIds: [answeringHand[0].id]
      })
      expect(validSubmitAck.ok).toBe(true)

      const judgePhaseView = await judgeViewPromise
      expect(judgePhaseView.gameState?.phase).toBe('waiting-for-judge')
    } finally {
      disconnectSockets(setup.host, setup.guest)
    }
  })

  it('accepts only one submit-answer when active player submits repeatedly', async () => {
    const setup = await setupTwoPlayerRoom()

    try {
      const hostInGame = setup.hostInGame
      const guestInGame = setup.guestInGame

      expect(hostInGame).toBeTruthy()
      expect(guestInGame).toBeTruthy()
      if (!hostInGame || !guestInGame || !hostInGame.gameState || !guestInGame.gameState) {
        return
      }

      const hostPlayer = hostInGame.players.find((player) => player.id === setup.createAck.playerId)
      const guestPlayer = guestInGame.players.find((player) => player.id === setup.joinAck.playerId)

      expect(hostPlayer?.gamePlayerId).toBeTruthy()
      expect(guestPlayer?.gamePlayerId).toBeTruthy()
      if (!hostPlayer?.gamePlayerId || !guestPlayer?.gamePlayerId) {
        return
      }

      const answeringPlayerId = hostInGame.gameState.answeringPlayerId
      expect(answeringPlayerId).toBeTruthy()
      if (!answeringPlayerId) {
        return
      }

      const answeringSocket = hostPlayer.gamePlayerId === answeringPlayerId ? setup.host : setup.guest
      const answeringRoom = answeringSocket === setup.host ? hostInGame : guestInGame
      const answeringHand = answeringRoom.gameState.players.find((player) => player.id === answeringPlayerId)?.hand

      expect(answeringHand?.length).toBeGreaterThan(0)
      if (!answeringHand || answeringHand.length === 0) {
        return
      }

      const firstSubmit = emitAck<BoolAck>(answeringSocket, 'submit-answer', {
        cardIds: [answeringHand[0].id]
      })
      const secondSubmit = emitAck<BoolAck>(answeringSocket, 'submit-answer', {
        cardIds: [answeringHand[0].id]
      })
      const [firstSubmitAck, secondSubmitAck] = await Promise.all([firstSubmit, secondSubmit])

      const successCount = Number(firstSubmitAck.ok) + Number(secondSubmitAck.ok)
      expect(successCount).toBe(1)

      const failedSubmit = firstSubmitAck.ok ? secondSubmitAck : firstSubmitAck
      expect(failedSubmit.ok).toBe(false)
      if (failedSubmit.ok) {
        return
      }

      expect(failedSubmit.error).toBe('Invalid submission for current turn.')
    } finally {
      disconnectSockets(setup.host, setup.guest)
    }
  })

  it('replays submit-answer acknowledgement for duplicate actionId', async () => {
    const setup = await setupTwoPlayerRoom()

    try {
      const hostInGame = setup.hostInGame
      const guestInGame = setup.guestInGame

      expect(hostInGame).toBeTruthy()
      expect(guestInGame).toBeTruthy()
      if (!hostInGame || !guestInGame || !hostInGame.gameState || !guestInGame.gameState) {
        return
      }

      const hostPlayer = hostInGame.players.find((player) => player.id === setup.createAck.playerId)
      const guestPlayer = guestInGame.players.find((player) => player.id === setup.joinAck.playerId)

      expect(hostPlayer?.gamePlayerId).toBeTruthy()
      expect(guestPlayer?.gamePlayerId).toBeTruthy()
      if (!hostPlayer?.gamePlayerId || !guestPlayer?.gamePlayerId) {
        return
      }

      const answeringPlayerId = hostInGame.gameState.answeringPlayerId
      expect(answeringPlayerId).toBeTruthy()
      if (!answeringPlayerId) {
        return
      }

      const answeringSocket = hostPlayer.gamePlayerId === answeringPlayerId ? setup.host : setup.guest
      const answeringRoom = answeringSocket === setup.host ? hostInGame : guestInGame
      const answeringHand = answeringRoom.gameState.players.find((player) => player.id === answeringPlayerId)?.hand

      expect(answeringHand?.length).toBeGreaterThan(0)
      if (!answeringHand || answeringHand.length === 0) {
        return
      }

      const actionId = 'submit-replay-1'
      const firstSubmitAck = await emitAck<BoolAck>(answeringSocket, 'submit-answer', {
        cardIds: [answeringHand[0].id],
        actionId
      })
      expect(firstSubmitAck.ok).toBe(true)

      const secondSubmitAck = await emitAck<BoolAck>(answeringSocket, 'submit-answer', {
        cardIds: [answeringHand[0].id],
        actionId
      })
      expect(secondSubmitAck.ok).toBe(true)
    } finally {
      disconnectSockets(setup.host, setup.guest)
    }
  })

  it('rejects start-game when room is already in-game', async () => {
    const setup = await setupTwoPlayerRoom()

    try {
      const restartAck = await emitAck<SocketAck | { ok: false; error: string }>(setup.host, 'start-game')
      expect(restartAck.ok).toBe(false)
      if (restartAck.ok) {
        return
      }

      expect(restartAck.error).toBe('Game has already started.')
    } finally {
      disconnectSockets(setup.host, setup.guest)
    }
  })

  it('allows only host to advance to next round', async () => {
    const setup = await setupTwoPlayerRoom()

    try {
      const hostInGame = setup.hostInGame
      const guestInGame = setup.guestInGame

      expect(hostInGame).toBeTruthy()
      expect(guestInGame).toBeTruthy()
      if (!hostInGame || !guestInGame || !hostInGame.gameState || !guestInGame.gameState) {
        return
      }

      const hostPlayer = hostInGame.players.find((player) => player.id === setup.createAck.playerId)
      const guestPlayer = guestInGame.players.find((player) => player.id === setup.joinAck.playerId)

      expect(hostPlayer?.gamePlayerId).toBeTruthy()
      expect(guestPlayer?.gamePlayerId).toBeTruthy()
      if (!hostPlayer?.gamePlayerId || !guestPlayer?.gamePlayerId) {
        return
      }

      const judgePlayerId = hostInGame.gameState.players[hostInGame.gameState.judgeIndex]?.id
      const answeringPlayerId = hostInGame.gameState.answeringPlayerId
      expect(judgePlayerId).toBeTruthy()
      expect(answeringPlayerId).toBeTruthy()
      if (!judgePlayerId || !answeringPlayerId) {
        return
      }

      const judgeSocket = hostPlayer.gamePlayerId === judgePlayerId ? setup.host : setup.guest
      const answeringSocket = hostPlayer.gamePlayerId === answeringPlayerId ? setup.host : setup.guest
      const nonHostSocket = setup.guest
      const answeringRoom = answeringSocket === setup.host ? hostInGame : guestInGame
      const answeringHand = answeringRoom.gameState.players.find((player) => player.id === answeringPlayerId)?.hand

      expect(answeringHand?.length).toBeGreaterThan(0)
      if (!answeringHand || answeringHand.length === 0) {
        return
      }

      const judgeViewPromise = waitForRoomUpdated(
        judgeSocket,
        (room) => room.gameState?.phase === 'waiting-for-judge' && room.gameState.submittedAnswers.length === 1
      )

      const submitAck = await emitAck<BoolAck>(answeringSocket, 'submit-answer', {
        cardIds: [answeringHand[0].id]
      })
      expect(submitAck.ok).toBe(true)

      const judgeView = await judgeViewPromise
      const winnerAlias = judgeView.gameState?.submittedAnswers[0]?.playerId
      expect(winnerAlias).toBeTruthy()
      if (!winnerAlias) {
        return
      }

      const roundOverPromise = waitForRoomUpdated(
        setup.host,
        (room) => room.gameState?.phase === 'round-over' && Boolean(room.gameState.winnerId)
      )

      const chooseAck = await emitAck<BoolAck>(judgeSocket, 'choose-winner', {
        winnerId: winnerAlias
      })
      expect(chooseAck.ok).toBe(true)

      await roundOverPromise

      const nonHostNextRoundAck = await emitAck<BoolAck>(nonHostSocket, 'next-round')
      expect(nonHostNextRoundAck.ok).toBe(false)
      if (nonHostNextRoundAck.ok) {
        return
      }

      expect(nonHostNextRoundAck.error).toBe('Only the host can advance rounds.')

      const nextRoundViewPromise = waitForRoomUpdated(
        setup.host,
        (room) => room.gameState?.phase === 'waiting-for-answers' && room.gameState.round === 2
      )

      const hostNextRoundAck = await emitAck<BoolAck>(setup.host, 'next-round')
      expect(hostNextRoundAck.ok).toBe(true)

      const nextRoundView = await nextRoundViewPromise
      expect(nextRoundView.gameState?.round).toBe(2)
      expect(nextRoundView.gameState?.phase).toBe('waiting-for-answers')
    } finally {
      disconnectSockets(setup.host, setup.guest)
    }
  })

  it('accepts only one next-round when host advances repeatedly', async () => {
    const setup = await setupTwoPlayerRoom()

    try {
      const hostInGame = setup.hostInGame
      const guestInGame = setup.guestInGame

      expect(hostInGame).toBeTruthy()
      expect(guestInGame).toBeTruthy()
      if (!hostInGame || !guestInGame || !hostInGame.gameState || !guestInGame.gameState) {
        return
      }

      const hostPlayer = hostInGame.players.find((player) => player.id === setup.createAck.playerId)
      const guestPlayer = guestInGame.players.find((player) => player.id === setup.joinAck.playerId)

      expect(hostPlayer?.gamePlayerId).toBeTruthy()
      expect(guestPlayer?.gamePlayerId).toBeTruthy()
      if (!hostPlayer?.gamePlayerId || !guestPlayer?.gamePlayerId) {
        return
      }

      const judgePlayerId = hostInGame.gameState.players[hostInGame.gameState.judgeIndex]?.id
      const answeringPlayerId = hostInGame.gameState.answeringPlayerId
      expect(judgePlayerId).toBeTruthy()
      expect(answeringPlayerId).toBeTruthy()
      if (!judgePlayerId || !answeringPlayerId) {
        return
      }

      const judgeSocket = hostPlayer.gamePlayerId === judgePlayerId ? setup.host : setup.guest
      const answeringSocket = hostPlayer.gamePlayerId === answeringPlayerId ? setup.host : setup.guest
      const answeringRoom = answeringSocket === setup.host ? hostInGame : guestInGame
      const answeringHand = answeringRoom.gameState.players.find((player) => player.id === answeringPlayerId)?.hand

      expect(answeringHand?.length).toBeGreaterThan(0)
      if (!answeringHand || answeringHand.length === 0) {
        return
      }

      const judgeViewPromise = waitForRoomUpdated(
        judgeSocket,
        (room) => room.gameState?.phase === 'waiting-for-judge' && room.gameState.submittedAnswers.length === 1
      )

      const submitAck = await emitAck<BoolAck>(answeringSocket, 'submit-answer', {
        cardIds: [answeringHand[0].id]
      })
      expect(submitAck.ok).toBe(true)

      const judgeView = await judgeViewPromise
      const winnerAlias = judgeView.gameState?.submittedAnswers[0]?.playerId
      expect(winnerAlias).toBeTruthy()
      if (!winnerAlias) {
        return
      }

      const roundOverPromise = waitForRoomUpdated(
        setup.host,
        (room) => room.gameState?.phase === 'round-over' && Boolean(room.gameState.winnerId)
      )

      const chooseAck = await emitAck<BoolAck>(judgeSocket, 'choose-winner', {
        winnerId: winnerAlias
      })
      expect(chooseAck.ok).toBe(true)

      await roundOverPromise

      const firstNextRound = emitAck<BoolAck>(setup.host, 'next-round')
      const secondNextRound = emitAck<BoolAck>(setup.host, 'next-round')
      const [firstNextRoundAck, secondNextRoundAck] = await Promise.all([firstNextRound, secondNextRound])

      const successCount = Number(firstNextRoundAck.ok) + Number(secondNextRoundAck.ok)
      expect(successCount).toBe(1)

      const failedAdvance = firstNextRoundAck.ok ? secondNextRoundAck : firstNextRoundAck
      expect(failedAdvance.ok).toBe(false)
      if (failedAdvance.ok) {
        return
      }

      expect(failedAdvance.error).toBe('Round is not ready to advance.')
    } finally {
      disconnectSockets(setup.host, setup.guest)
    }
  })

  it('replays next-round acknowledgement for duplicate actionId', async () => {
    const setup = await setupTwoPlayerRoom()

    try {
      const hostInGame = setup.hostInGame
      const guestInGame = setup.guestInGame

      expect(hostInGame).toBeTruthy()
      expect(guestInGame).toBeTruthy()
      if (!hostInGame || !guestInGame || !hostInGame.gameState || !guestInGame.gameState) {
        return
      }

      const hostPlayer = hostInGame.players.find((player) => player.id === setup.createAck.playerId)
      const guestPlayer = guestInGame.players.find((player) => player.id === setup.joinAck.playerId)

      expect(hostPlayer?.gamePlayerId).toBeTruthy()
      expect(guestPlayer?.gamePlayerId).toBeTruthy()
      if (!hostPlayer?.gamePlayerId || !guestPlayer?.gamePlayerId) {
        return
      }

      const judgePlayerId = hostInGame.gameState.players[hostInGame.gameState.judgeIndex]?.id
      const answeringPlayerId = hostInGame.gameState.answeringPlayerId
      expect(judgePlayerId).toBeTruthy()
      expect(answeringPlayerId).toBeTruthy()
      if (!judgePlayerId || !answeringPlayerId) {
        return
      }

      const judgeSocket = hostPlayer.gamePlayerId === judgePlayerId ? setup.host : setup.guest
      const answeringSocket = hostPlayer.gamePlayerId === answeringPlayerId ? setup.host : setup.guest
      const answeringRoom = answeringSocket === setup.host ? hostInGame : guestInGame
      const answeringHand = answeringRoom.gameState.players.find((player) => player.id === answeringPlayerId)?.hand

      expect(answeringHand?.length).toBeGreaterThan(0)
      if (!answeringHand || answeringHand.length === 0) {
        return
      }

      const judgeViewPromise = waitForRoomUpdated(
        judgeSocket,
        (room) => room.gameState?.phase === 'waiting-for-judge' && room.gameState.submittedAnswers.length === 1
      )

      const submitAck = await emitAck<BoolAck>(answeringSocket, 'submit-answer', {
        cardIds: [answeringHand[0].id]
      })
      expect(submitAck.ok).toBe(true)

      const judgeView = await judgeViewPromise
      const winnerAlias = judgeView.gameState?.submittedAnswers[0]?.playerId
      expect(winnerAlias).toBeTruthy()
      if (!winnerAlias) {
        return
      }

      const roundOverPromise = waitForRoomUpdated(
        setup.host,
        (room) => room.gameState?.phase === 'round-over' && Boolean(room.gameState.winnerId)
      )

      const chooseAck = await emitAck<BoolAck>(judgeSocket, 'choose-winner', {
        winnerId: winnerAlias
      })
      expect(chooseAck.ok).toBe(true)
      await roundOverPromise

      const actionId = 'advance-replay-1'
      const firstAdvanceAck = await emitAck<BoolAck>(setup.host, 'next-round', { actionId })
      expect(firstAdvanceAck.ok).toBe(true)

      const secondAdvanceAck = await emitAck<BoolAck>(setup.host, 'next-round', { actionId })
      expect(secondAdvanceAck.ok).toBe(true)
    } finally {
      disconnectSockets(setup.host, setup.guest)
    }
  })

  it('allows transferred host to advance round after original host disconnects', async () => {
    const setup = await setupTwoPlayerRoom()

    try {
      const hostInGame = setup.hostInGame
      const guestInGame = setup.guestInGame

      expect(hostInGame).toBeTruthy()
      expect(guestInGame).toBeTruthy()
      if (!hostInGame || !guestInGame || !hostInGame.gameState || !guestInGame.gameState) {
        return
      }

      const hostPlayer = hostInGame.players.find((player) => player.id === setup.createAck.playerId)
      const guestPlayer = guestInGame.players.find((player) => player.id === setup.joinAck.playerId)

      expect(hostPlayer?.gamePlayerId).toBeTruthy()
      expect(guestPlayer?.gamePlayerId).toBeTruthy()
      if (!hostPlayer?.gamePlayerId || !guestPlayer?.gamePlayerId) {
        return
      }

      const judgePlayerId = hostInGame.gameState.players[hostInGame.gameState.judgeIndex]?.id
      const answeringPlayerId = hostInGame.gameState.answeringPlayerId
      expect(judgePlayerId).toBeTruthy()
      expect(answeringPlayerId).toBeTruthy()
      if (!judgePlayerId || !answeringPlayerId) {
        return
      }

      const judgeSocket = hostPlayer.gamePlayerId === judgePlayerId ? setup.host : setup.guest
      const answeringSocket = hostPlayer.gamePlayerId === answeringPlayerId ? setup.host : setup.guest
      const answeringRoom = answeringSocket === setup.host ? hostInGame : guestInGame
      const answeringHand = answeringRoom.gameState.players.find((player) => player.id === answeringPlayerId)?.hand

      expect(answeringHand?.length).toBeGreaterThan(0)
      if (!answeringHand || answeringHand.length === 0) {
        return
      }

      const judgeViewPromise = waitForRoomUpdated(
        judgeSocket,
        (room) => room.gameState?.phase === 'waiting-for-judge' && room.gameState.submittedAnswers.length === 1
      )

      const submitAck = await emitAck<BoolAck>(answeringSocket, 'submit-answer', {
        cardIds: [answeringHand[0].id]
      })
      expect(submitAck.ok).toBe(true)

      const judgeView = await judgeViewPromise
      const winnerAlias = judgeView.gameState?.submittedAnswers[0]?.playerId
      expect(winnerAlias).toBeTruthy()
      if (!winnerAlias) {
        return
      }

      const roundOverPromise = waitForRoomUpdated(
        setup.guest,
        (room) => room.gameState?.phase === 'round-over' && Boolean(room.gameState.winnerId)
      )

      const chooseAck = await emitAck<BoolAck>(judgeSocket, 'choose-winner', {
        winnerId: winnerAlias
      })
      expect(chooseAck.ok).toBe(true)

      await roundOverPromise

      const guestBecomesHostPromise = waitForRoomUpdated(setup.guest, (room) => {
        const guestEntry = room.players.find((player) => player.id === setup.joinAck.playerId)
        return Boolean(guestEntry?.isHost)
      })

      setup.host.disconnect()
      await guestBecomesHostPromise

      const nextRoundViewPromise = waitForRoomUpdated(
        setup.guest,
        (room) => room.gameState?.phase === 'waiting-for-answers' && room.gameState.round === 2
      )

      const nextRoundAck = await emitAck<BoolAck>(setup.guest, 'next-round')
      expect(nextRoundAck.ok).toBe(true)

      const nextRoundView = await nextRoundViewPromise
      expect(nextRoundView.gameState?.round).toBe(2)
      expect(nextRoundView.gameState?.phase).toBe('waiting-for-answers')
    } finally {
      disconnectSockets(setup.host, setup.guest)
    }
  })

  it('rejects join-room when game is already in progress', async () => {
    const setup = await setupTwoPlayerRoom()
    const newcomer = await connectClient()

    try {
      const joinAck = await emitAck<SocketAck>(newcomer, 'join-room', {
        roomCode: setup.createAck.room.roomCode,
        playerName: 'Late Joiner'
      })

      expect(joinAck.ok).toBe(false)
      if (joinAck.ok) {
        return
      }

      expect(joinAck.error).toBe('Game already in progress.')
    } finally {
      disconnectSockets(setup.host, setup.guest, newcomer)
    }
  })

  it('allows valid session rejoin while game is already in progress', async () => {
    const setup = await setupTwoPlayerRoom()

    try {
      setup.guest.disconnect()

      const rejoinClient = await connectClient()
      try {
        const rejoinAck = await emitAck<SocketAck>(rejoinClient, 'rejoin-room', {
          roomCode: setup.createAck.room.roomCode,
          sessionToken: setup.joinAck.sessionToken
        })

        expect(rejoinAck.ok).toBe(true)
        if (!rejoinAck.ok) {
          return
        }

        expect(rejoinAck.room.phase).toBe('in-game')
        expect(rejoinAck.playerId).toBe(setup.joinAck.playerId)
      } finally {
        rejoinClient.disconnect()
      }
    } finally {
      disconnectSockets(setup.host, setup.guest)
    }
  })

  it('marks in-game leave-room player disconnected and allows token rejoin', async () => {
    const setup = await setupTwoPlayerRoom()

    try {
      const guestDisconnectedPromise = waitForRoomUpdated(setup.host, (room) => {
        const guestEntry = room.players.find((player) => player.id === setup.joinAck.playerId)
        return Boolean(guestEntry && !guestEntry.connected)
      })

      setup.guest.emit('leave-room')

      const hostViewAfterLeave = await guestDisconnectedPromise
      const guestEntryAfterLeave = hostViewAfterLeave.players.find((player) => player.id === setup.joinAck.playerId)

      expect(hostViewAfterLeave.phase).toBe('in-game')
      expect(hostViewAfterLeave.players.some((player) => player.id === setup.joinAck.playerId)).toBe(true)
      expect(guestEntryAfterLeave?.connected).toBe(false)

      const rejoinClient = await connectClient()
      try {
        const rejoinAck = await emitAck<SocketAck>(rejoinClient, 'rejoin-room', {
          roomCode: setup.createAck.room.roomCode,
          sessionToken: setup.joinAck.sessionToken
        })

        expect(rejoinAck.ok).toBe(true)
        if (!rejoinAck.ok) {
          return
        }

        const guestAfterRejoin = rejoinAck.room.players.find((player) => player.id === setup.joinAck.playerId)
        expect(rejoinAck.room.phase).toBe('in-game')
        expect(guestAfterRejoin?.connected).toBe(true)
      } finally {
        rejoinClient.disconnect()
      }
    } finally {
      disconnectSockets(setup.host, setup.guest)
    }
  })

  it('rejects actions from stale socket after token rejoin takeover', async () => {
    const setup = await setupTwoPlayerRoom()
    const attacker = await connectClient()

    try {
      const takeoverAck = await emitAck<SocketAck>(attacker, 'rejoin-room', {
        roomCode: setup.createAck.room.roomCode,
        sessionToken: setup.joinAck.sessionToken
      })

      expect(takeoverAck.ok).toBe(true)
      if (!takeoverAck.ok) {
        return
      }

      const staleActionAck = await emitAck<BoolAck>(setup.guest, 'submit-answer', {
        cardIds: []
      })
      expect(staleActionAck.ok).toBe(false)
      if (staleActionAck.ok) {
        return
      }

      expect(staleActionAck.error).toBe('Session is no longer active.')
    } finally {
      disconnectSockets(setup.host, setup.guest, attacker)
    }
  })

  it('rejects stale host start-game after host token rejoin takeover in lobby', async () => {
    const host = await connectClient()
    const guest = await connectClient()
    const hostTakeover = await connectClient()

    try {
      const createAck = requireOkAck(await emitAck<SocketAck>(host, 'create-room', { playerName: 'Host' }))
      requireOkAck(
        await emitAck<SocketAck>(guest, 'join-room', {
          roomCode: createAck.room.roomCode,
          playerName: 'Guest'
        })
      )

      const hostRejoinAck = await emitAck<SocketAck>(hostTakeover, 'rejoin-room', {
        roomCode: createAck.room.roomCode,
        sessionToken: createAck.sessionToken
      })
      expect(hostRejoinAck.ok).toBe(true)

      const staleStartAck = await emitAck<SocketAck | { ok: false; error: string }>(host, 'start-game')
      expect(staleStartAck.ok).toBe(false)
      if (staleStartAck.ok) {
        return
      }

      expect(staleStartAck.error).toBe('Session is no longer active.')

      const activeStartAck = await emitAck<SocketAck | { ok: false; error: string }>(hostTakeover, 'start-game')
      expect(activeStartAck.ok).toBe(true)
    } finally {
      disconnectSockets(host, guest, hostTakeover)
    }
  })

  it('rejects stale host choose-winner and next-round after in-game token takeover', async () => {
    const setup = await setupTwoPlayerRoom()
    const hostTakeover = await connectClient()

    try {
      const hostRejoinAck = await emitAck<SocketAck>(hostTakeover, 'rejoin-room', {
        roomCode: setup.createAck.room.roomCode,
        sessionToken: setup.createAck.sessionToken
      })
      expect(hostRejoinAck.ok).toBe(true)
      if (!hostRejoinAck.ok) {
        return
      }

      const hostInGame = setup.hostInGame
      const guestInGame = setup.guestInGame

      expect(hostInGame).toBeTruthy()
      expect(guestInGame).toBeTruthy()
      if (!hostInGame || !guestInGame || !hostInGame.gameState) {
        return
      }

      const hostPlayer = hostInGame.players.find((player) => player.id === setup.createAck.playerId)
      const guestPlayer = guestInGame.players.find((player) => player.id === setup.joinAck.playerId)

      expect(hostPlayer?.gamePlayerId).toBeTruthy()
      expect(guestPlayer?.gamePlayerId).toBeTruthy()
      if (!hostPlayer?.gamePlayerId || !guestPlayer?.gamePlayerId) {
        return
      }

      const answeringPlayerId = hostInGame.gameState.answeringPlayerId
      expect(answeringPlayerId).toBeTruthy()
      if (!answeringPlayerId) {
        return
      }

      const answeringSocket = hostPlayer.gamePlayerId === answeringPlayerId ? setup.host : setup.guest
      const answeringRoom = answeringSocket === setup.host ? hostInGame : guestInGame
      const answeringHand = answeringRoom.gameState.players.find((player) => player.id === answeringPlayerId)?.hand

      expect(answeringHand?.length).toBeGreaterThan(0)
      if (!answeringHand || answeringHand.length === 0) {
        return
      }

      const judgeViewPromise = waitForRoomUpdated(
        hostTakeover,
        (room) => room.gameState?.phase === 'waiting-for-judge' && room.gameState.submittedAnswers.length === 1
      )

      const submitAck = await emitAck<BoolAck>(answeringSocket, 'submit-answer', {
        cardIds: [answeringHand[0].id]
      })
      expect(submitAck.ok).toBe(true)

      const judgeView = await judgeViewPromise
      const winnerAlias = judgeView.gameState?.submittedAnswers[0]?.playerId
      expect(winnerAlias).toBeTruthy()
      if (!winnerAlias) {
        return
      }

      const staleChooseAck = await emitAck<BoolAck>(setup.host, 'choose-winner', {
        winnerId: winnerAlias
      })
      expect(staleChooseAck.ok).toBe(false)
      if (staleChooseAck.ok) {
        return
      }

      expect(staleChooseAck.error).toBe('Session is no longer active.')

      const roundOverPromise = waitForRoomUpdated(
        hostTakeover,
        (room) => room.gameState?.phase === 'round-over' && Boolean(room.gameState.winnerId)
      )

      const activeChooseAck = await emitAck<BoolAck>(hostTakeover, 'choose-winner', {
        winnerId: winnerAlias
      })
      expect(activeChooseAck.ok).toBe(true)

      await roundOverPromise

      const staleNextRoundAck = await emitAck<BoolAck>(setup.host, 'next-round')
      expect(staleNextRoundAck.ok).toBe(false)
      if (staleNextRoundAck.ok) {
        return
      }

      expect(staleNextRoundAck.error).toBe('Session is no longer active.')

      const nextRoundPromise = waitForRoomUpdated(
        hostTakeover,
        (room) => room.gameState?.phase === 'waiting-for-answers' && room.gameState.round === 2
      )

      const activeNextRoundAck = await emitAck<BoolAck>(hostTakeover, 'next-round')
      expect(activeNextRoundAck.ok).toBe(true)

      const nextRoundView = await nextRoundPromise
      expect(nextRoundView.gameState?.round).toBe(2)
    } finally {
      disconnectSockets(setup.host, setup.guest, hostTakeover)
    }
  })

  it('rejects choose-winner when round is not in judge phase', async () => {
    const setup = await setupTwoPlayerRoom()
    try {
      const hostInGame = setup.hostInGame
      const guestInGame = setup.guestInGame

      expect(hostInGame).toBeTruthy()
      expect(guestInGame).toBeTruthy()
      if (!hostInGame || !guestInGame || !hostInGame.gameState) {
        return
      }

      expect(hostInGame.gameState.phase).toBe('waiting-for-answers')

      const hostPlayer = hostInGame.players.find((player) => player.id === setup.createAck.playerId)
      const guestPlayer = guestInGame.players.find((player) => player.id === setup.joinAck.playerId)

      expect(hostPlayer?.gamePlayerId).toBeTruthy()
      expect(guestPlayer?.gamePlayerId).toBeTruthy()
      if (!hostPlayer?.gamePlayerId || !guestPlayer?.gamePlayerId) {
        return
      }

      const judgePlayerId = hostInGame.gameState.players[hostInGame.gameState.judgeIndex]?.id
      expect(judgePlayerId).toBeTruthy()
      if (!judgePlayerId) {
        return
      }

      const judgeSocket = hostPlayer.gamePlayerId === judgePlayerId ? setup.host : setup.guest
      const chooseAck = await emitAck<BoolAck>(judgeSocket, 'choose-winner', {
        winnerId: hostPlayer.gamePlayerId
      })

      expect(chooseAck.ok).toBe(false)
      if (chooseAck.ok) {
        return
      }

      expect(chooseAck.error).toBe('Round is not ready for judging.')
    } finally {
      disconnectSockets(setup.host, setup.guest)
    }
  })

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

  it('transfers host in lobby when host explicitly leaves the room', async () => {
    const host = await connectClient()
    const guestOne = await connectClient()
    const guestTwo = await connectClient()

    try {
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

      const hostTransferredPromise = waitForRoomUpdated(guestOne, (room) => {
        if (room.phase !== 'lobby') {
          return false
        }

        const guestOnePlayer = room.players.find((player) => player.id === joinOneAck.playerId)
        const hostPlayer = room.players.find((player) => player.id === createAck.playerId)
        return Boolean(guestOnePlayer?.isHost && !hostPlayer)
      })

      host.emit('leave-room')

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
      disconnectSockets(host, guestOne, guestTwo)
    }
  })

  it('deletes room when all players disconnect', async () => {
    const setup = await setupTwoPlayerRoom({ startGame: false })

    try {
      setup.guest.disconnect()
      setup.host.disconnect()

      const rejoinClient = await connectClient()
      try {
        const rejoinAck = await emitAck<SocketAck>(rejoinClient, 'rejoin-room', {
          roomCode: setup.createAck.room.roomCode,
          sessionToken: setup.createAck.sessionToken
        })

        expect(rejoinAck.ok).toBe(false)
        if (rejoinAck.ok) {
          return
        }

        expect(rejoinAck.error).toBe('Room not found.')
      } finally {
        rejoinClient.disconnect()
      }
    } finally {
      disconnectSockets(setup.host, setup.guest)
    }
  })

  it('deletes room when the final player leaves explicitly', async () => {
    const host = await connectClient()

    try {
      const createAck = requireOkAck(await emitAck<SocketAck>(host, 'create-room', { playerName: 'Host' }))

      host.emit('leave-room')

      const joinClient = await connectClient()
      try {
        const joinAck = await emitAck<SocketAck>(joinClient, 'join-room', {
          roomCode: createAck.room.roomCode,
          playerName: 'Replacement Host'
        })

        expect(joinAck.ok).toBe(false)
        if (joinAck.ok) {
          return
        }

        expect(joinAck.error).toBe('Room not found.')
      } finally {
        joinClient.disconnect()
      }
    } finally {
      host.disconnect()
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

  it('removes disconnected lobby players when starting a game', async () => {
    const host = await connectClient()
    const guestOne = await connectClient()
    const guestTwo = await connectClient()

    try {
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

      const guestOneDisconnectedPromise = waitForRoomUpdated(host, (room) => {
        const guestOnePlayer = room.players.find((player) => player.id === joinOneAck.playerId)
        return Boolean(guestOnePlayer && !guestOnePlayer.connected)
      })

      guestOne.disconnect()
      await guestOneDisconnectedPromise

      const hostInGamePromise = waitForRoomUpdated(host, (room) => room.phase === 'in-game' && Boolean(room.gameState))
      const guestTwoInGamePromise = waitForRoomUpdated(
        guestTwo,
        (room) => room.phase === 'in-game' && Boolean(room.gameState)
      )

      const startAck = await emitAck<SocketAck | { ok: false; error: string }>(host, 'start-game')
      expect(startAck.ok).toBe(true)

      const hostInGame = await hostInGamePromise
      const guestTwoInGame = await guestTwoInGamePromise

      expect(hostInGame.players.length).toBe(2)
      expect(guestTwoInGame.players.length).toBe(2)
      expect(hostInGame.players.some((player) => player.id === joinOneAck.playerId)).toBe(false)
      expect(guestTwoInGame.players.some((player) => player.id === joinOneAck.playerId)).toBe(false)
      expect(hostInGame.players.some((player) => player.id === joinTwoAck.playerId)).toBe(true)
      expect(hostInGame.players.some((player) => player.id === createAck.playerId)).toBe(true)
    } finally {
      disconnectSockets(host, guestOne, guestTwo)
    }
  })

  it('rejects rejoin for player pruned from lobby on game start', async () => {
    const host = await connectClient()
    const guestOne = await connectClient()
    const guestTwo = await connectClient()

    try {
      const createAck = requireOkAck(await emitAck<SocketAck>(host, 'create-room', { playerName: 'Host' }))
      const joinOneAck = requireOkAck(
        await emitAck<SocketAck>(guestOne, 'join-room', {
          roomCode: createAck.room.roomCode,
          playerName: 'Guest One'
        })
      )
      requireOkAck(
        await emitAck<SocketAck>(guestTwo, 'join-room', {
          roomCode: createAck.room.roomCode,
          playerName: 'Guest Two'
        })
      )

      const guestOneDisconnectedPromise = waitForRoomUpdated(host, (room) => {
        const guestOnePlayer = room.players.find((player) => player.id === joinOneAck.playerId)
        return Boolean(guestOnePlayer && !guestOnePlayer.connected)
      })

      guestOne.disconnect()
      await guestOneDisconnectedPromise

      const hostInGamePromise = waitForRoomUpdated(host, (room) => room.phase === 'in-game' && Boolean(room.gameState))
      const startAck = await emitAck<SocketAck | { ok: false; error: string }>(host, 'start-game')
      expect(startAck.ok).toBe(true)
      await hostInGamePromise

      const rejoinClient = await connectClient()
      try {
        const rejoinAck = await emitAck<SocketAck>(rejoinClient, 'rejoin-room', {
          roomCode: createAck.room.roomCode,
          sessionToken: joinOneAck.sessionToken
        })

        expect(rejoinAck.ok).toBe(false)
        if (rejoinAck.ok) {
          return
        }

        expect(rejoinAck.error).toBe('Session expired for this room.')
      } finally {
        rejoinClient.disconnect()
      }
    } finally {
      disconnectSockets(host, guestOne, guestTwo)
    }
  })

  it('transfers host to connected player when another player is disconnected', async () => {
    const host = await connectClient()
    const guestOne = await connectClient()
    const guestTwo = await connectClient()

    try {
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

      const guestOneDisconnectedPromise = waitForRoomUpdated(host, (room) => {
        const guestOnePlayer = room.players.find((player) => player.id === joinOneAck.playerId)
        return Boolean(guestOnePlayer && !guestOnePlayer.connected)
      })

      guestOne.disconnect()
      await guestOneDisconnectedPromise

      const hostTransferredPromise = waitForRoomUpdated(guestTwo, (room) => {
        const guestOnePlayer = room.players.find((player) => player.id === joinOneAck.playerId)
        const guestTwoPlayer = room.players.find((player) => player.id === joinTwoAck.playerId)

        return Boolean(guestOnePlayer && !guestOnePlayer.connected && guestTwoPlayer?.isHost)
      })

      host.disconnect()

      const transferredRoom = await hostTransferredPromise
      const guestOnePlayer = transferredRoom.players.find((player) => player.id === joinOneAck.playerId)
      const guestTwoPlayer = transferredRoom.players.find((player) => player.id === joinTwoAck.playerId)

      expect(guestOnePlayer?.connected).toBe(false)
      expect(guestTwoPlayer?.connected).toBe(true)
      expect(guestTwoPlayer?.isHost).toBe(true)
      expect(guestOnePlayer?.isHost).toBe(false)
    } finally {
      disconnectSockets(host, guestOne, guestTwo)
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

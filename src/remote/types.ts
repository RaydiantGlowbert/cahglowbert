import type { GameState } from '../game'

export type RoomPlayer = {
  id: string
  name: string
  isHost: boolean
  gamePlayerId?: string
}

export type RoomSnapshot = {
  roomCode: string
  players: RoomPlayer[]
  phase: 'lobby' | 'in-game'
  gameState?: GameState
}

export type SocketAck =
  | { ok: true; room: RoomSnapshot; playerId: string }
  | { ok: false; error: string }

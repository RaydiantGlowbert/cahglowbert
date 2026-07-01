export type RoomPlayer = {
  id: string
  name: string
  isHost: boolean
}

export type RoomSnapshot = {
  roomCode: string
  players: RoomPlayer[]
  phase: 'lobby'
}

export type SocketAck =
  | { ok: true; room: RoomSnapshot; playerId: string }
  | { ok: false; error: string }

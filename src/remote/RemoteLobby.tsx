import { useEffect, useMemo, useState } from 'react'
import { io, type Socket } from 'socket.io-client'
import type { RoomSnapshot, SocketAck } from './types'

const SERVER_URL = import.meta.env.VITE_SERVER_URL ?? 'http://localhost:3001'

type RemoteLobbyProps = {
  onBackToLocal: () => void
}

function RemoteLobby({ onBackToLocal }: RemoteLobbyProps) {
  const [socket, setSocket] = useState<Socket | null>(null)
  const [isConnected, setIsConnected] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [createName, setCreateName] = useState('')
  const [joinName, setJoinName] = useState('')
  const [roomCodeInput, setRoomCodeInput] = useState('')
  const [currentRoom, setCurrentRoom] = useState<RoomSnapshot | null>(null)
  const [currentPlayerId, setCurrentPlayerId] = useState<string | null>(null)

  useEffect(() => {
    const nextSocket = io(SERVER_URL, {
      transports: ['websocket']
    })

    setSocket(nextSocket)

    nextSocket.on('connect', () => {
      setIsConnected(true)
      setErrorMessage(null)
    })

    nextSocket.on('disconnect', () => {
      setIsConnected(false)
    })

    nextSocket.on('room-updated', (room: RoomSnapshot) => {
      setCurrentRoom((existing) => (existing?.roomCode === room.roomCode ? room : existing))
    })

    return () => {
      nextSocket.disconnect()
      setSocket(null)
    }
  }, [])

  const playerInRoom = useMemo(
    () => currentRoom?.players.find((player) => player.id === currentPlayerId) ?? null,
    [currentPlayerId, currentRoom]
  )

  const createRoom = () => {
    if (!socket) {
      return
    }

    setErrorMessage(null)
    socket.emit('create-room', { playerName: createName }, (ack: SocketAck) => {
      if (!ack.ok) {
        setErrorMessage(ack.error)
        return
      }

      setCurrentPlayerId(ack.playerId)
      setCurrentRoom(ack.room)
      setRoomCodeInput(ack.room.roomCode)
    })
  }

  const joinRoom = () => {
    if (!socket) {
      return
    }

    setErrorMessage(null)
    socket.emit(
      'join-room',
      {
        roomCode: roomCodeInput.trim().toUpperCase(),
        playerName: joinName
      },
      (ack: SocketAck) => {
        if (!ack.ok) {
          setErrorMessage(ack.error)
          return
        }

        setCurrentPlayerId(ack.playerId)
        setCurrentRoom(ack.room)
      }
    )
  }

  const leaveRoom = () => {
    socket?.emit('leave-room')
    setCurrentRoom(null)
    setCurrentPlayerId(null)
    setErrorMessage(null)
  }

  return (
    <section className="game-panel remote-panel">
      <div className="panel-heading">
        <h3>Remote Multiplayer (M1)</h3>
        <p>Create a room, join with a code, and confirm everyone appears in the waiting room.</p>
      </div>

      <div className="status-row remote-status-row">
        <div className="status-pill">Server: <strong>{isConnected ? 'Connected' : 'Disconnected'}</strong></div>
        <div className="status-pill">Endpoint: <strong>{SERVER_URL}</strong></div>
      </div>

      {errorMessage ? <p className="setup-error-text">{errorMessage}</p> : null}

      {!currentRoom ? (
        <div className="remote-grid">
          <div className="sidebar-card">
            <h3>Create room</h3>
            <label className="name-input" htmlFor="create-name">
              Your name
              <input
                id="create-name"
                value={createName}
                onChange={(event) => setCreateName(event.target.value)}
                placeholder="Host name"
              />
            </label>
            <button type="button" className="primary-action" onClick={createRoom} disabled={!isConnected}>
              Create room
            </button>
          </div>

          <div className="sidebar-card">
            <h3>Join room</h3>
            <label className="name-input" htmlFor="room-code">
              Room code
              <input
                id="room-code"
                value={roomCodeInput}
                onChange={(event) => setRoomCodeInput(event.target.value.toUpperCase())}
                placeholder="ABC123"
                maxLength={6}
              />
            </label>
            <label className="name-input" htmlFor="join-name">
              Your name
              <input
                id="join-name"
                value={joinName}
                onChange={(event) => setJoinName(event.target.value)}
                placeholder="Player name"
              />
            </label>
            <button type="button" className="primary-action" onClick={joinRoom} disabled={!isConnected}>
              Join room
            </button>
          </div>
        </div>
      ) : (
        <div className="sidebar-card">
          <h3>Waiting room: {currentRoom.roomCode}</h3>
          <p>{currentRoom.players.length}/15 players connected</p>
          <div className="score-stack">
            {currentRoom.players.map((player) => (
              <div key={player.id} className="score-row">
                <span>
                  {player.name}
                  {player.id === currentPlayerId ? ' (you)' : ''}
                  {player.isHost ? ' [host]' : ''}
                </span>
              </div>
            ))}
          </div>

          <div className="action-row">
            <button type="button" className="secondary-action" onClick={leaveRoom}>
              Leave room
            </button>
            <button type="button" className="secondary-action" onClick={onBackToLocal}>
              Back to local mode
            </button>
          </div>

          {playerInRoom?.isHost ? (
            <p className="setup-warning">Host controls and round sync are next in M2.</p>
          ) : (
            <p className="setup-warning">Waiting for host to start game (M2).</p>
          )}
        </div>
      )}
    </section>
  )
}

export default RemoteLobby

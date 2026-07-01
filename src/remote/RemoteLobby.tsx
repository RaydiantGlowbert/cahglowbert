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
  const [selectedCardIds, setSelectedCardIds] = useState<string[]>([])

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
      setCurrentRoom(room)
      setErrorMessage(null)
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

  const gameState = currentRoom?.gameState ?? null
  const currentGamePlayer = useMemo(() => {
    if (!gameState || !playerInRoom?.gamePlayerId) {
      return null
    }

    return gameState.players.find((player) => player.id === playerInRoom.gamePlayerId) ?? null
  }, [gameState, playerInRoom?.gamePlayerId])

  const requiredPick = gameState?.blackCard?.pick ?? 1
  const isJudge = Boolean(
    gameState && playerInRoom?.gamePlayerId && gameState.players[gameState.judgeIndex]?.id === playerInRoom.gamePlayerId
  )
  const isActiveAnsweringPlayer = Boolean(
    gameState && playerInRoom?.gamePlayerId && gameState.answeringPlayerId === playerInRoom.gamePlayerId
  )

  useEffect(() => {
    setSelectedCardIds([])
  }, [gameState?.phase, gameState?.round])

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
    setSelectedCardIds([])
  }

  const startGame = () => {
    if (!socket) {
      return
    }

    socket.emit('start-game', (ack: SocketAck) => {
      if (!ack.ok) {
        setErrorMessage(ack.error)
        return
      }

      setCurrentRoom(ack.room)
    })
  }

  const submitAnswer = () => {
    if (!socket || selectedCardIds.length !== requiredPick) {
      return
    }

    socket.emit('submit-answer', { cardIds: selectedCardIds }, (ack: { ok: boolean; error?: string }) => {
      if (!ack.ok) {
        setErrorMessage(ack.error ?? 'Could not submit answer.')
        return
      }

      setSelectedCardIds([])
    })
  }

  const chooseWinner = (winnerId: string) => {
    if (!socket) {
      return
    }

    socket.emit('choose-winner', { winnerId }, (ack: { ok: boolean; error?: string }) => {
      if (!ack.ok) {
        setErrorMessage(ack.error ?? 'Could not choose winner.')
      }
    })
  }

  const advanceRound = () => {
    if (!socket) {
      return
    }

    socket.emit('next-round', (ack: { ok: boolean; error?: string }) => {
      if (!ack.ok) {
        setErrorMessage(ack.error ?? 'Could not advance round.')
      }
    })
  }

  const toggleCard = (cardId: string) => {
    setSelectedCardIds((current) => {
      if (current.includes(cardId)) {
        return current.filter((id) => id !== cardId)
      }

      if (current.length >= requiredPick) {
        return current
      }

      return [...current, cardId]
    })
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
          <h3>{currentRoom.phase === 'lobby' ? 'Waiting room' : 'Remote game'}: {currentRoom.roomCode}</h3>
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

          {currentRoom.phase === 'lobby' ? (
            <>
              <div className="action-row">
                {playerInRoom?.isHost ? (
                  <button type="button" className="primary-action" onClick={startGame}>
                    Start remote game
                  </button>
                ) : null}
                <button type="button" className="secondary-action" onClick={leaveRoom}>
                  Leave room
                </button>
                <button type="button" className="secondary-action" onClick={onBackToLocal}>
                  Back to local mode
                </button>
              </div>

              {playerInRoom?.isHost ? (
                <p className="setup-warning">Start once everyone has joined.</p>
              ) : (
                <p className="setup-warning">Waiting for host to start the game.</p>
              )}
            </>
          ) : null}

          {currentRoom.phase === 'in-game' && gameState ? (
            <div className="remote-game-wrap">
              <div className="status-row remote-status-row">
                <div className="status-pill">Round: <strong>{gameState.round}</strong></div>
                <div className="status-pill">Phase: <strong>{gameState.phase.replace(/-/g, ' ')}</strong></div>
                <div className="status-pill">Judge: <strong>{gameState.players[gameState.judgeIndex]?.name}</strong></div>
              </div>

              <article className="prompt-card">
                <span>Prompt card</span>
                <strong>{gameState.blackCard?.text}</strong>
                <p>Pick {requiredPick} white card{requiredPick > 1 ? 's' : ''}.</p>
              </article>

              <div className="sidebar-card">
                <h3>Scores</h3>
                <div className="score-stack">
                  {gameState.players.map((player) => (
                    <div key={player.id} className="score-row">
                      <span>{player.name}</span>
                      <strong>{player.score}</strong>
                    </div>
                  ))}
                </div>
              </div>

              {gameState.phase === 'waiting-for-answers' ? (
                <div className="sidebar-card">
                  <h3>{isActiveAnsweringPlayer ? 'Your turn to submit' : 'Waiting for answers'}</h3>
                  {isActiveAnsweringPlayer && currentGamePlayer ? (
                    <>
                      <div className="answer-grid hand-grid">
                        {currentGamePlayer.hand.map((card) => (
                          <button
                            key={card.id}
                            type="button"
                            className={`answer-card ${selectedCardIds.includes(card.id) ? 'selected' : ''}`}
                            onClick={() => toggleCard(card.id)}
                          >
                            <span className="card-label">White card</span>
                            {card.text}
                          </button>
                        ))}
                      </div>
                      <button
                        type="button"
                        className="primary-action"
                        onClick={submitAnswer}
                        disabled={selectedCardIds.length !== requiredPick}
                      >
                        Submit {requiredPick} card{requiredPick > 1 ? 's' : ''}
                      </button>
                    </>
                  ) : (
                    <p className="setup-warning">Waiting for {gameState.answeringPlayerId ? 'the active player to submit.' : 'players to submit.'}</p>
                  )}
                </div>
              ) : null}

              {gameState.phase === 'waiting-for-judge' ? (
                <div className="sidebar-card">
                  <h3>{isJudge ? 'Pick the winning answer' : 'Judge is deciding'}</h3>
                  <div className="answer-grid">
                    {gameState.submittedAnswers.map((entry) => (
                      <button
                        key={`${entry.playerId}-${entry.cards.map((card) => card.id).join('-')}`}
                        type="button"
                        className="answer-card"
                        onClick={() => chooseWinner(entry.playerId)}
                        disabled={!isJudge}
                      >
                        <span className="card-label">Submission</span>
                        <strong>{entry.cards.map((card) => card.text).join(' / ')}</strong>
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}

              {gameState.phase === 'round-over' ? (
                <div className="sidebar-card">
                  <h3>Round complete</h3>
                  <p>{gameState.players.find((player) => player.id === gameState.winnerId)?.name} wins this round.</p>
                  <button type="button" className="primary-action" onClick={advanceRound}>
                    {gameState.round >= gameState.maxRounds ? 'Finish game' : 'Next round'}
                  </button>
                </div>
              ) : null}

              {gameState.phase === 'game-over' ? (
                <div className="sidebar-card">
                  <h3>Game over</h3>
                  <p>
                    {gameState.players.reduce((leader, player) =>
                      player.score > leader.score ? player : leader
                    , gameState.players[0]).name} wins the room.
                  </p>
                </div>
              ) : null}

              <div className="action-row">
                <button type="button" className="secondary-action" onClick={leaveRoom}>
                  Leave room
                </button>
                <button type="button" className="secondary-action" onClick={onBackToLocal}>
                  Back to local mode
                </button>
              </div>
            </div>
          ) : null}
        </div>
      )}
    </section>
  )
}

export default RemoteLobby

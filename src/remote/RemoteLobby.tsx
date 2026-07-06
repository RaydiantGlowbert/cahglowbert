import { useEffect, useMemo, useRef, useState } from 'react'
import { io, type Socket } from 'socket.io-client'
import type { RoomSnapshot, SocketAck } from './types'

const SERVER_URL = import.meta.env.VITE_SERVER_URL ?? 'http://localhost:3001'
const SESSION_STORAGE_KEY = 'cah-remote-session'

function createActionId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }

  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

type SavedSession = {
  roomCode: string
  sessionToken: string
}

function RemoteLobby() {
  const [socket, setSocket] = useState<Socket | null>(null)
  const [isConnected, setIsConnected] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [liveMessage, setLiveMessage] = useState('')
  const [pendingAction, setPendingAction] = useState<
    'create' | 'join' | 'start' | 'submit' | 'trade' | 'choose' | 'bonus' | 'advance' | 'end' | null
  >(null)
  const [createName, setCreateName] = useState('')
  const [joinName, setJoinName] = useState('')
  const [roomCodeInput, setRoomCodeInput] = useState('')
  const [currentRoom, setCurrentRoom] = useState<RoomSnapshot | null>(null)
  const [currentPlayerId, setCurrentPlayerId] = useState<string | null>(null)
  const [selectedCardIds, setSelectedCardIds] = useState<string[]>([])
  const [selectedTradeCardIds, setSelectedTradeCardIds] = useState<string[]>([])
  const [selectedWinnerId, setSelectedWinnerId] = useState<string | null>(null)
  const [showStartGuide, setShowStartGuide] = useState(false)
  const [phaseSpotlight, setPhaseSpotlight] = useState<{ title: string; detail: string } | null>(null)
  const [showRoomDetailsInGame, setShowRoomDetailsInGame] = useState(false)
  const previousRoomPhaseRef = useRef<'lobby' | 'in-game' | null>(null)
  const previousGamePhaseRef = useRef<string | null>(null)
  const spotlightTimerRef = useRef<number | null>(null)

  const resetRemoteSession = (message?: string) => {
    setCurrentRoom(null)
    setCurrentPlayerId(null)
    setSelectedCardIds([])
    setSelectedTradeCardIds([])
    setSelectedWinnerId(null)
    window.localStorage.removeItem(SESSION_STORAGE_KEY)

    if (message) {
      setErrorMessage(message)
    }
  }

  const toFriendlyError = (error: string): string => {
    if (error === 'Session is no longer active.') {
      return 'This session was replaced by a newer connection. Rejoin from this device.'
    }

    if (error === 'Game already in progress.') {
      return 'This room is already in progress. New players cannot join mid-game.'
    }

    if (error === 'Winner is invalid.') {
      return 'That winning choice is no longer valid. Pick from the current submissions.'
    }

    if (error === 'Invalid submission for current turn.') {
      return 'That submission is not valid for the current turn.'
    }

    if (error === 'Invalid card trade for current turn.') {
      return 'You can trade up to 3 cards before submitting an answer.'
    }

    if (error === 'Only the host can toggle double points.') {
      return 'Only the host can change round bonus scoring.'
    }

    return error
  }

  const handleActionError = (error?: string, fallback?: string) => {
    const nextError = toFriendlyError(error ?? fallback ?? 'Something went wrong.')

    if (error === 'Session is no longer active.') {
      resetRemoteSession(nextError)
      return
    }

    setErrorMessage(nextError)
  }

  const savedSession = useMemo(() => {
    const raw = window.localStorage.getItem(SESSION_STORAGE_KEY)
    if (!raw) {
      return null
    }

    try {
      return JSON.parse(raw) as SavedSession
    } catch {
      return null
    }
  }, [])

  useEffect(() => {
    const nextSocket = io(SERVER_URL, {
      transports: ['websocket']
    })

    setSocket(nextSocket)

    nextSocket.on('connect', () => {
      setIsConnected(true)
      setErrorMessage(null)

      if (!savedSession) {
        return
      }

      nextSocket.emit(
        'rejoin-room',
        {
          roomCode: savedSession.roomCode,
          sessionToken: savedSession.sessionToken
        },
        (ack: SocketAck) => {
          if (!ack.ok) {
            window.localStorage.removeItem(SESSION_STORAGE_KEY)
            setCurrentRoom(null)
            setCurrentPlayerId(null)
            setSelectedCardIds([])
            setRoomCodeInput('')
            setErrorMessage('Saved session expired. Rejoin with room code and player name.')
            return
          }

          setCurrentPlayerId(ack.playerId)
          setCurrentRoom(ack.room)
          setRoomCodeInput(ack.room.roomCode)
        }
      )
    })

    nextSocket.on('disconnect', () => {
      setIsConnected(false)
      setPendingAction(null)
    })

    nextSocket.on('room-updated', (room: RoomSnapshot) => {
      setCurrentRoom(room)
      setErrorMessage(null)
    })

    return () => {
      nextSocket.disconnect()
      setSocket(null)
    }
  }, [savedSession])

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
  const hasSubmittedThisRound = Boolean(
    gameState &&
      playerInRoom?.gamePlayerId &&
      gameState.submittedAnswers.some((entry) => entry.playerId === playerInRoom.gamePlayerId)
  )
  const canSubmitThisRound = Boolean(gameState && playerInRoom?.gamePlayerId && !isJudge && !hasSubmittedThisRound)
  const hasTradedThisRound = Boolean(
    gameState && playerInRoom?.gamePlayerId && gameState.tradedPlayerIds.includes(playerInRoom.gamePlayerId)
  )
  const canAdvanceRound = Boolean(playerInRoom?.isHost)
  const connectedPlayersCount = currentRoom?.players.filter((player) => player.connected).length ?? 0
  const disconnectedPlayersCount = currentRoom?.players.filter((player) => !player.connected).length ?? 0
  const isCreating = pendingAction === 'create'
  const isJoining = pendingAction === 'join'
  const isStarting = pendingAction === 'start'
  const isSubmitting = pendingAction === 'submit'
  const isTrading = pendingAction === 'trade'
  const isChoosing = pendingAction === 'choose'
  const isTogglingBonus = pendingAction === 'bonus'
  const isAdvancing = pendingAction === 'advance'
  const isEnding = pendingAction === 'end'
  const shouldShowRecoveryHint =
    errorMessage === 'This session was replaced by a newer connection. Rejoin from this device.' ||
    errorMessage === 'Saved session expired. Rejoin with room code and player name.'
  const isInGamePhase = currentRoom?.phase === 'in-game'
  const phaseClass = gameState ? `phase-${gameState.phase}` : 'phase-lobby'
  const rankedPlayers = useMemo(() => {
    if (!gameState) {
      return [] as Array<{ id: string; name: string; score: number; isJudge: boolean }>
    }

    const judgeId = gameState.players[gameState.judgeIndex]?.id

    return [...gameState.players]
      .sort((left, right) => right.score - left.score)
      .map((player) => ({
        id: player.id,
        name: player.name,
        score: player.score,
        isJudge: player.id === judgeId
      }))
  }, [gameState])

  const winningSubmissionCards = useMemo(() => {
    if (!gameState || gameState.phase !== 'round-over' || !gameState.winnerId) {
      return [] as string[]
    }

    const directSubmission = gameState.submittedAnswers.find((entry) => entry.playerId === gameState.winnerId)
    if (directSubmission && directSubmission.cards.length > 0) {
      return directSubmission.cards.map((card) => card.text)
    }

    const latestRoundResult = [...gameState.roundHistory].reverse().find((entry) => entry.round === gameState.round)
    if (latestRoundResult?.winningCardText) {
      return latestRoundResult.winningCardText
        .split(' / ')
        .map((text) => text.trim())
        .filter((text) => text.length > 0)
    }

    return [] as string[]
  }, [gameState])

  const phaseChecklist = useMemo(() => {
    if (!gameState) {
      return null
    }

    if (gameState.phase === 'waiting-for-answers' && canSubmitThisRound) {
      return {
        role: 'player' as const,
        title: 'Round checklist',
        steps: [
          {
            label: `Select ${requiredPick} answer card${requiredPick > 1 ? 's' : ''}`,
            done: selectedCardIds.length === requiredPick
          },
          {
            label: hasTradedThisRound
              ? 'Trade option used (optional, once per round)'
              : `Optional trade selected (${selectedTradeCardIds.length}/3)`,
            done: hasTradedThisRound
          },
          {
            label: 'Submit your answer',
            done: hasSubmittedThisRound
          }
        ]
      }
    }

    if (gameState.phase === 'waiting-for-judge' && isJudge) {
      return {
        role: 'judge' as const,
        title: 'Judge checklist',
        steps: [
          {
            label: 'Select the winning submission',
            done: Boolean(selectedWinnerId)
          },
          {
            label: 'Click Confirm winner',
            done: false
          }
        ]
      }
    }

    return null
  }, [
    canSubmitThisRound,
    gameState,
    hasSubmittedThisRound,
    hasTradedThisRound,
    isJudge,
    requiredPick,
    selectedCardIds.length,
    selectedTradeCardIds.length,
    selectedWinnerId
  ])

  useEffect(() => {
    setSelectedCardIds([])
    setSelectedTradeCardIds([])
    setSelectedWinnerId(null)
  }, [gameState?.phase, gameState?.round])

  useEffect(() => {
    if (!currentRoom) {
      return
    }

    if (currentRoom.phase === 'lobby') {
      setLiveMessage(`In lobby. ${connectedPlayersCount} players connected.`)
      return
    }

    if (!gameState) {
      return
    }

    const normalizedPhase = gameState.phase.replace(/-/g, ' ')
    setLiveMessage(`Round ${gameState.round}. Phase: ${normalizedPhase}.`)
  }, [connectedPlayersCount, currentRoom, gameState])

  useEffect(() => {
    if (!errorMessage) {
      return
    }

    setLiveMessage(errorMessage)
  }, [errorMessage])

  useEffect(() => {
    const currentPhase = currentRoom?.phase ?? null

    if (currentPhase !== 'in-game') {
      setShowStartGuide(false)
    }

    if (currentPhase === 'in-game' && previousRoomPhaseRef.current !== 'in-game') {
      setShowStartGuide(true)
    }

    previousRoomPhaseRef.current = currentPhase
  }, [currentRoom?.phase])

  useEffect(() => {
    if (!gameState) {
      previousGamePhaseRef.current = null
      return
    }

    const previousGamePhase = previousGamePhaseRef.current
    previousGamePhaseRef.current = gameState.phase

    if (currentRoom?.phase !== 'in-game' || !previousGamePhase || previousGamePhase === gameState.phase) {
      return
    }

    let nextSpotlight: { title: string; detail: string } | null = null

    if (gameState.phase === 'waiting-for-judge') {
      nextSpotlight = {
        title: 'Judge phase',
        detail: `${gameState.players[gameState.judgeIndex]?.name} is choosing the winner.`
      }
    } else if (gameState.phase === 'round-over') {
      nextSpotlight = {
        title: 'Round winner',
        detail: `${gameState.players.find((player) => player.id === gameState.winnerId)?.name ?? 'A player'} takes the round.`
      }
    }

    if (!nextSpotlight) {
      return
    }

    setPhaseSpotlight(nextSpotlight)

    if (spotlightTimerRef.current) {
      window.clearTimeout(spotlightTimerRef.current)
    }

    spotlightTimerRef.current = window.setTimeout(() => {
      setPhaseSpotlight(null)
      spotlightTimerRef.current = null
    }, 2200)
  }, [currentRoom?.phase, gameState])

  useEffect(() => {
    return () => {
      if (spotlightTimerRef.current) {
        window.clearTimeout(spotlightTimerRef.current)
      }
    }
  }, [])

  useEffect(() => {
    if (currentRoom?.phase !== 'in-game') {
      setShowRoomDetailsInGame(false)
      return
    }

    if (disconnectedPlayersCount > 0) {
      setShowRoomDetailsInGame(true)
    }
  }, [currentRoom?.phase, disconnectedPlayersCount])

  const createRoom = () => {
    if (!socket || pendingAction) {
      return
    }

    setPendingAction('create')
    setErrorMessage(null)
    socket.emit('create-room', { playerName: createName }, (ack: SocketAck) => {
      setPendingAction(null)

      if (!ack.ok) {
        handleActionError(ack.error)
        return
      }

      setCurrentPlayerId(ack.playerId)
      setCurrentRoom(ack.room)
      setRoomCodeInput(ack.room.roomCode)
      window.localStorage.setItem(
        SESSION_STORAGE_KEY,
        JSON.stringify({ roomCode: ack.room.roomCode, sessionToken: ack.sessionToken })
      )
    })
  }

  const joinRoom = () => {
    if (!socket || pendingAction) {
      return
    }

    setPendingAction('join')
    setErrorMessage(null)
    socket.emit(
      'join-room',
      {
        roomCode: roomCodeInput.trim().toUpperCase(),
        playerName: joinName
      },
      (ack: SocketAck) => {
        setPendingAction(null)

        if (!ack.ok) {
          handleActionError(ack.error)
          return
        }

        setCurrentPlayerId(ack.playerId)
        setCurrentRoom(ack.room)
        window.localStorage.setItem(
          SESSION_STORAGE_KEY,
          JSON.stringify({ roomCode: ack.room.roomCode, sessionToken: ack.sessionToken })
        )
      }
    )
  }

  const leaveRoom = () => {
    socket?.emit('leave-room')
    setCurrentRoom(null)
    setCurrentPlayerId(null)
    setErrorMessage(null)
    setSelectedCardIds([])
    window.localStorage.removeItem(SESSION_STORAGE_KEY)
  }

  const startGame = () => {
    if (!socket || pendingAction) {
      return
    }

    setPendingAction('start')
    socket.emit('start-game', { actionId: createActionId() }, (ack: SocketAck) => {
      setPendingAction(null)

      if (!ack.ok) {
        handleActionError(ack.error)
        return
      }

      setCurrentRoom(ack.room)
    })
  }

  const submitAnswer = () => {
    if (!socket || selectedCardIds.length !== requiredPick || pendingAction) {
      return
    }

    setPendingAction('submit')
    socket.emit('submit-answer', { cardIds: selectedCardIds, actionId: createActionId() }, (ack: { ok: boolean; error?: string }) => {
      setPendingAction(null)

      if (!ack.ok) {
        handleActionError(ack.error, 'Could not submit answer.')
        return
      }

      setSelectedCardIds([])
    })
  }

  const advanceRound = () => {
    if (!socket || pendingAction) {
      return
    }

    setPendingAction('advance')
    socket.emit('next-round', { actionId: createActionId() }, (ack: { ok: boolean; error?: string }) => {
      setPendingAction(null)

      if (!ack.ok) {
        handleActionError(ack.error, 'Could not advance round.')
      }
    })
  }

  const endCurrentGame = () => {
    if (!socket || pendingAction || !playerInRoom?.isHost) {
      return
    }

    if (!window.confirm('End the current game for everyone?')) {
      return
    }

    setPendingAction('end')
    socket.emit('end-game', { actionId: createActionId() }, (ack: { ok: boolean; error?: string }) => {
      setPendingAction(null)

      if (!ack.ok) {
        handleActionError(ack.error, 'Could not end game.')
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

  const toggleTradeCard = (cardId: string) => {
    setSelectedTradeCardIds((current) => {
      if (current.includes(cardId)) {
        return current.filter((id) => id !== cardId)
      }

      if (current.length >= 3) {
        return current
      }

      return [...current, cardId]
    })
  }

  const toggleWinnerSelection = (playerId: string) => {
    setSelectedWinnerId((current) => (current === playerId ? null : playerId))
  }

  const tradeCards = () => {
    if (!socket || selectedTradeCardIds.length === 0 || selectedTradeCardIds.length > 3 || pendingAction) {
      return
    }

    setPendingAction('trade')
    socket.emit(
      'trade-cards',
      { cardIds: selectedTradeCardIds, actionId: createActionId() },
      (ack: { ok: boolean; error?: string }) => {
        setPendingAction(null)

        if (!ack.ok) {
          handleActionError(ack.error, 'Could not trade cards.')
          return
        }

        setSelectedTradeCardIds([])
      }
    )
  }

  const toggleDoublePoints = () => {
    if (!socket || !playerInRoom?.isHost || pendingAction) {
      return
    }

    setPendingAction('bonus')
    socket.emit(
      'toggle-double-points',
      { actionId: createActionId() },
      (ack: { ok: boolean; error?: string }) => {
        setPendingAction(null)

        if (!ack.ok) {
          handleActionError(ack.error, 'Could not update bonus scoring.')
        }
      }
    )
  }

  const confirmWinner = () => {
    if (!socket || !selectedWinnerId || pendingAction) {
      return
    }

    setPendingAction('choose')
    socket.emit(
      'choose-winner',
      { winnerId: selectedWinnerId, actionId: createActionId() },
      (ack: { ok: boolean; error?: string }) => {
        setPendingAction(null)

        if (!ack.ok) {
          handleActionError(ack.error, 'Could not choose winner.')
          return
        }

        setSelectedWinnerId(null)
      }
    )
  }

  return (
    <section className={`game-panel remote-panel ${isInGamePhase ? 'in-game-focus' : ''} ${phaseClass}`}>
      <p className="sr-only" aria-live="polite">{liveMessage}</p>
      {phaseSpotlight ? (
        <div className="phase-spotlight" role="status" aria-live="polite">
          <span className="phase-spotlight-kicker">Round update</span>
          <strong>{phaseSpotlight.title}</strong>
          <p>{phaseSpotlight.detail}</p>
        </div>
      ) : null}
      {showStartGuide && isInGamePhase ? (
        <div className="game-start-overlay" role="dialog" aria-modal="true" aria-labelledby="game-start-title">
          <div className="game-start-modal">
            <h3 id="game-start-title">How to play</h3>
            <ol>
              <li>Each round, one player becomes the judge and gets to be gloriously opinionated.</li>
              <li>Everyone else submits their funniest card combo for the black prompt.</li>
              <li>The judge reads anonymous submissions and crowns one chaotic winner.</li>
              <li>Laugh, roast gently, and get ready for the next absurd prompt.</li>
            </ol>
            <button type="button" className="primary-action" onClick={() => setShowStartGuide(false)}>
              Got it
            </button>
          </div>
        </div>
      ) : null}

      {!isInGamePhase ? (
        <div className="panel-heading">
          <h3>Online Multiplayer</h3>
          <p>Create a room, join with a code, and start playing together.</p>
        </div>
      ) : null}

      {!isInGamePhase ? (
        <div className="status-row remote-status-row">
          <div className="status-pill">Server: <strong>{isConnected ? 'Connected' : 'Disconnected'}</strong></div>
          <div className="status-pill">Endpoint: <strong>{SERVER_URL}</strong></div>
        </div>
      ) : null}

      {currentRoom?.phase === 'lobby' ? (
        <div className="remote-room-health">
          <div className="remote-health-item">
            <span>Room</span>
            <strong>{currentRoom.roomCode}</strong>
          </div>
          <div className="remote-health-item">
            <span>You</span>
            <strong>{playerInRoom?.isHost ? 'Host' : 'Player'}</strong>
          </div>
          <div className="remote-health-item">
            <span>Connected</span>
            <strong>{connectedPlayersCount}/15</strong>
          </div>
          <div className="remote-health-item">
            <span>Disconnected</span>
            <strong>{disconnectedPlayersCount}</strong>
          </div>
        </div>
      ) : null}

      {errorMessage ? <p className="setup-error-text">{errorMessage}</p> : null}
      {shouldShowRecoveryHint ? (
        <div className="remote-recovery-hint" role="status" aria-live="polite">
          <strong>Recovery tip</strong>
          <p>Enter your player name and room code, then use Join room to continue from this device.</p>
        </div>
      ) : null}

      {!currentRoom ? (
        <div className="remote-grid">
          <div className="sidebar-card create-room-card">
            <div className="create-room-heading">
              <h3>Create room</h3>
              <span className="create-room-badge">Host only</span>
            </div>
            <label className="name-input" htmlFor="create-name">
              Your name
              <input
                id="create-name"
                value={createName}
                onChange={(event) => setCreateName(event.target.value)}
                placeholder="Host name"
              />
            </label>
            <button
              type="button"
              className="primary-action"
              onClick={createRoom}
              disabled={!isConnected || isCreating || Boolean(pendingAction && !isCreating)}
            >
              {isCreating ? 'Creating...' : 'Create room'}
            </button>
          </div>

          <div className="sidebar-card join-room-card">
            <h3>Join room</h3>
            <label className="name-input" htmlFor="room-code">
              Room code
              <input
                id="room-code"
                value={roomCodeInput}
                onChange={(event) => setRoomCodeInput(event.target.value.toUpperCase())}
                placeholder=""
                maxLength={6}
              />
            </label>
            <p className="room-code-hint"><em>Enter room code provided by your host.</em></p>
            <label className="name-input" htmlFor="join-name">
              Your name
              <input
                id="join-name"
                value={joinName}
                onChange={(event) => setJoinName(event.target.value)}
                placeholder="Player name"
              />
            </label>
            <button
              type="button"
              className="primary-action"
              onClick={joinRoom}
              disabled={!isConnected || isJoining || Boolean(pendingAction && !isJoining)}
            >
              {isJoining ? 'Joining...' : 'Join room'}
            </button>
          </div>
        </div>
      ) : (
        <div className="sidebar-card">
          <h3>{currentRoom.phase === 'lobby' ? 'Waiting room' : 'Game room'}: {currentRoom.roomCode}</h3>
          <p>{currentRoom.players.length}/15 players connected</p>
          {currentRoom.phase === 'lobby' ? (
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
          ) : (
            <div className="in-game-room-meta">
              <button
                type="button"
                className="secondary-action room-info-toggle"
                onClick={() => setShowRoomDetailsInGame((current) => !current)}
              >
                {showRoomDetailsInGame ? 'Hide room info' : 'Show room info'}
              </button>
              <span className={`room-health-chip ${disconnectedPlayersCount > 0 ? 'warning' : ''}`}>
                {disconnectedPlayersCount > 0
                  ? `${disconnectedPlayersCount} disconnected`
                  : `${connectedPlayersCount} connected`}
              </span>
            </div>
          )}

          {currentRoom.phase === 'in-game' && showRoomDetailsInGame ? (
            <div className="in-game-room-drawer">
              <div className="remote-room-health">
                <div className="remote-health-item">
                  <span>Room</span>
                  <strong>{currentRoom.roomCode}</strong>
                </div>
                <div className="remote-health-item">
                  <span>You</span>
                  <strong>{playerInRoom?.isHost ? 'Host' : 'Player'}</strong>
                </div>
                <div className="remote-health-item">
                  <span>Connected</span>
                  <strong>{connectedPlayersCount}/15</strong>
                </div>
                <div className="remote-health-item">
                  <span>Disconnected</span>
                  <strong>{disconnectedPlayersCount}</strong>
                </div>
              </div>
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
            </div>
          ) : null}

          {currentRoom.phase === 'lobby' ? (
            <>
              <div className="action-row">
                {playerInRoom?.isHost ? (
                  <button
                    type="button"
                    className="primary-action"
                    onClick={startGame}
                    disabled={isStarting || Boolean(pendingAction && !isStarting)}
                  >
                    {isStarting ? 'Starting...' : 'Start game'}
                  </button>
                ) : null}
                <button type="button" className="secondary-action" onClick={leaveRoom}>
                  Leave room
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

              {phaseChecklist ? (
                <section className={`checklist-card checklist-${phaseChecklist.role}`} aria-live="polite">
                  <h3>{phaseChecklist.title}</h3>
                  <ul>
                    {phaseChecklist.steps.map((step) => (
                      <li key={step.label} className={step.done ? 'done' : ''}>
                        <span className="checklist-state">{step.done ? 'Done' : 'Next'}</span>
                        <span>{step.label}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}

              <div className="sidebar-card">
                <h3>Scores</h3>
                <div className="score-stack">
                  {rankedPlayers.map((player, index) => (
                    <div key={player.id} className={`score-row ${gameState.winnerId === player.id ? 'score-row-winner' : ''}`}>
                      <span className="score-name-wrap">
                        <span className="score-rank">#{index + 1}</span>
                        <span>{player.name}</span>
                        {player.isJudge ? <span className="score-tag">Judge</span> : null}
                      </span>
                      <strong>{player.score}</strong>
                    </div>
                  ))}
                </div>
              </div>

              {gameState.phase === 'waiting-for-answers' ? (
                <div className="sidebar-card">
                  <h3>{canSubmitThisRound ? 'Submit your answer' : 'Waiting for answers'}</h3>
                  {canSubmitThisRound && currentGamePlayer ? (
                    <>
                      <p className="setup-warning">Step 1: select your answer card{requiredPick > 1 ? 's' : ''}. Step 2: submit.</p>
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
                        className="primary-action mobile-sticky-action"
                        onClick={submitAnswer}
                        disabled={selectedCardIds.length !== requiredPick || isSubmitting || Boolean(pendingAction && !isSubmitting)}
                      >
                        {isSubmitting ? 'Submitting...' : `Submit ${requiredPick} card${requiredPick > 1 ? 's' : ''}`}
                      </button>
                      <div className="trade-panel">
                        <div className="trade-panel-heading">
                          <div>
                            <h4>Trade cards</h4>
                            <p>
                              Swap up to 3 white cards before you lock in your answer.
                              {hasTradedThisRound ? ' Trade used this round.' : ' One trade action per round.'}
                            </p>
                          </div>
                          <button
                            type="button"
                            className="secondary-action"
                            onClick={tradeCards}
                            disabled={
                              hasTradedThisRound ||
                              selectedTradeCardIds.length === 0 ||
                              isTrading ||
                              Boolean(pendingAction && !isTrading)
                            }
                          >
                            {isTrading
                              ? 'Trading...'
                              : hasTradedThisRound
                                ? 'Trade used'
                                : `Trade ${selectedTradeCardIds.length || ''}`.trim()}
                          </button>
                        </div>
                        <div className="answer-grid hand-grid trade-grid">
                          {currentGamePlayer.hand.map((card) => (
                            <button
                              key={`trade-${card.id}`}
                              type="button"
                              className={`answer-card trade-card ${selectedTradeCardIds.includes(card.id) ? 'selected' : ''}`}
                              onClick={() => toggleTradeCard(card.id)}
                            >
                              <span className="card-label">Trade card</span>
                              {card.text}
                            </button>
                          ))}
                        </div>
                      </div>
                    </>
                  ) : (
                    <p className="setup-warning">
                      {isJudge
                        ? 'Waiting for players to submit.'
                        : hasSubmittedThisRound
                          ? 'Submission received. Waiting for other players.'
                          : 'Waiting for players to submit.'}
                    </p>
                  )}
                </div>
              ) : null}

              {gameState.phase === 'waiting-for-judge' ? (
                <div className="sidebar-card">
                  <h3>{isJudge ? 'Pick the winning answer' : 'Judge is deciding'}</h3>
                  <p className="setup-warning">
                    {isJudge
                      ? 'Step 1: select a submission. Step 2: click Confirm winner.'
                      : 'Submissions are shuffled and anonymized each round.'}
                  </p>
                  <div className="answer-grid">
                    {gameState.submittedAnswers.map((entry, index) => (
                      <button
                        key={`submission-${index + 1}-${entry.cards.map((card) => card.id).join('-')}`}
                        type="button"
                        className={`answer-card submission-card ${selectedWinnerId === entry.playerId ? 'selected' : ''}`}
                        onClick={() => isJudge && toggleWinnerSelection(entry.playerId)}
                        disabled={!isJudge || isChoosing || Boolean(pendingAction && !isChoosing)}
                        title={isJudge ? `Select Submission ${index + 1}` : 'Only the judge can pick a winner'}
                        aria-label={`Submission ${index + 1}${isJudge ? ', select to confirm' : ', waiting for judge'}`}
                        style={{ animationDelay: `${index * 60}ms` }}
                      >
                        <span className="card-label">Submission {index + 1}</span>
                        <strong>{entry.cards.map((card) => card.text).join(' / ')}</strong>
                      </button>
                    ))}
                  </div>
                  {isJudge ? (
                    <>
                      {selectedWinnerId ? <p className="setup-warning">Selection ready. Click Confirm winner to lock it in.</p> : null}
                      <button
                        type="button"
                        className="primary-action mobile-sticky-action"
                        onClick={confirmWinner}
                        disabled={!selectedWinnerId || isChoosing || Boolean(pendingAction && !isChoosing)}
                      >
                        {isChoosing ? 'Submitting winner...' : 'Confirm winner'}
                      </button>
                    </>
                  ) : null}
                </div>
              ) : null}

              {gameState.phase === 'round-over' ? (
                <div className="sidebar-card winner-card">
                  <h3>Round complete</h3>
                  <p className="winner-message">{gameState.players.find((player) => player.id === gameState.winnerId)?.name} wins this round.</p>
                  {winningSubmissionCards.length > 0 ? (
                    <section className="winner-answer-preview" aria-live="polite">
                      <span>Winning card{winningSubmissionCards.length > 1 ? 's' : ''}</span>
                      <div className="answer-grid hand-grid winner-answer-grid">
                        {winningSubmissionCards.map((cardText, index) => (
                          <article key={`${index}-${cardText}`} className="answer-card winner-answer-card" aria-label="Winning white card">
                            <span className="card-label">White card</span>
                            <strong>{cardText}</strong>
                          </article>
                        ))}
                      </div>
                    </section>
                  ) : null}
                  <button
                    type="button"
                    className="primary-action mobile-sticky-action"
                    onClick={advanceRound}
                    disabled={!canAdvanceRound || isAdvancing || Boolean(pendingAction && !isAdvancing)}
                    title={canAdvanceRound ? 'Advance to the next round' : 'Only the host can advance rounds'}
                  >
                    {isAdvancing ? 'Advancing...' : 'Next round'}
                  </button>
                  {!canAdvanceRound ? <p className="setup-warning">Waiting for host to advance the round.</p> : null}
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
                {playerInRoom?.isHost && gameState.phase !== 'game-over' ? (
                  <button
                    type="button"
                    className={`secondary-action ${gameState.doublePointsEnabled ? 'active' : ''}`}
                    onClick={toggleDoublePoints}
                    disabled={isTogglingBonus || Boolean(pendingAction && !isTogglingBonus)}
                  >
                    {isTogglingBonus
                      ? 'Updating bonus...'
                      : gameState.doublePointsEnabled
                        ? 'Double points: On'
                        : 'Double points: Off'}
                  </button>
                ) : null}
                {playerInRoom?.isHost && gameState.phase !== 'game-over' ? (
                  <button
                    type="button"
                    className="secondary-action"
                    onClick={endCurrentGame}
                    disabled={isEnding || Boolean(pendingAction && !isEnding)}
                  >
                    {isEnding ? 'Ending...' : 'End game'}
                  </button>
                ) : null}
                <button type="button" className="secondary-action" onClick={leaveRoom}>
                  Leave room
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

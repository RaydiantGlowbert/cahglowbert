import { useEffect, useMemo, useState } from 'react'
import './App.css'
import {
  LARGE_TABLE_THRESHOLD,
  MAX_PLAYERS,
  chooseWinner,
  createInitialGameState,
  deckValidation,
  nextRound,
  submitAnswer,
  type GameState
} from './game'
import { clearPersistedState, loadPersistedState, savePersistedState } from './persistence'

function App() {
  const JUDGE_PAGE_SIZE = 6
  const SHORTLIST_TRIGGER_SIZE = 12
  const SHORTLIST_SIZE = 3
  const [playerNamesInput, setPlayerNamesInput] = useState('Ada, Grace')
  const [gameState, setGameState] = useState<GameState | null>(null)
  const [selectedCardIds, setSelectedCardIds] = useState<string[]>([])
  const [judgePage, setJudgePage] = useState(1)
  const [shortlistMode, setShortlistMode] = useState(false)
  const [shortlistedPlayerIds, setShortlistedPlayerIds] = useState<string[]>([])
  const [shortlistLocked, setShortlistLocked] = useState(false)
  const deckErrors = deckValidation.errors
  const hasDeckErrors = !deckValidation.isValid

  const parsedSetupNames = useMemo(
    () =>
      playerNamesInput
        .split(',')
        .map((name) => name.trim())
        .filter(Boolean),
    [playerNamesInput]
  )

  useEffect(() => {
    if (hasDeckErrors) {
      setGameState(null)
      return
    }

    const persisted = loadPersistedState()
    if (persisted.gameState) {
      setGameState(persisted.gameState)
    }

    if (persisted.playerNamesInput) {
      setPlayerNamesInput(persisted.playerNamesInput)
    }
  }, [hasDeckErrors])

  useEffect(() => {
    if (!gameState) {
      clearPersistedState()
      return
    }

    savePersistedState(gameState, playerNamesInput)
  }, [gameState, playerNamesInput])

  useEffect(() => {
    setJudgePage(1)
    setShortlistedPlayerIds([])
    setShortlistLocked(false)
    if (gameState?.phase !== 'waiting-for-judge') {
      setShortlistMode(false)
    }
  }, [gameState?.phase, gameState?.round])

  const activePlayerId = useMemo(() => {
    if (!gameState) {
      return null
    }

    return gameState.answeringPlayerId ?? null
  }, [gameState])

  const activePlayer = useMemo(() => {
    if (!gameState || !activePlayerId) {
      return null
    }

    return gameState.players.find((player) => player.id === activePlayerId) ?? null
  }, [activePlayerId, gameState])

  const requiredPick = useMemo(() => gameState?.blackCard?.pick ?? 1, [gameState])
  const judgePageCount = useMemo(() => {
    if (!gameState || gameState.phase !== 'waiting-for-judge') {
      return 1
    }

    return Math.max(1, Math.ceil(gameState.submittedAnswers.length / JUDGE_PAGE_SIZE))
  }, [gameState])

  const canUseShortlist = useMemo(() => {
    if (!gameState || gameState.phase !== 'waiting-for-judge') {
      return false
    }

    return gameState.submittedAnswers.length >= SHORTLIST_TRIGGER_SIZE
  }, [gameState])

  const visibleSubmittedAnswers = useMemo(() => {
    if (!gameState || gameState.phase !== 'waiting-for-judge') {
      return []
    }

    if (shortlistMode && shortlistLocked) {
      return gameState.submittedAnswers.filter((entry) => shortlistedPlayerIds.includes(entry.playerId))
    }

    const start = (judgePage - 1) * JUDGE_PAGE_SIZE
    return gameState.submittedAnswers.slice(start, start + JUDGE_PAGE_SIZE)
  }, [gameState, judgePage, shortlistLocked, shortlistMode, shortlistedPlayerIds])

  const startGame = () => {
    if (hasDeckErrors) {
      return
    }

    const names = parsedSetupNames

    const nextState = createInitialGameState(names.length >= 2 ? names : ['Player 1', 'Player 2'])
    setGameState(nextState)
    setSelectedCardIds([])
    setJudgePage(1)
  }

  const handleAnswerSubmit = () => {
    if (!gameState || !activePlayerId || selectedCardIds.length !== requiredPick) {
      return
    }

    const nextState = submitAnswer(gameState, activePlayerId, selectedCardIds)
    setGameState(nextState)
    setSelectedCardIds([])
  }

  const handleCardToggle = (cardId: string) => {
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

  const handleWinnerPick = (winnerId: string) => {
    if (!gameState) {
      return
    }

    const nextState = chooseWinner(gameState, winnerId)
    setGameState(nextState)
  }

  const handleShortlistToggle = () => {
    if (!shortlistMode) {
      setShortlistMode(true)
      return
    }

    setShortlistMode(false)
    setShortlistedPlayerIds([])
    setShortlistLocked(false)
  }

  const handleShortlistCandidateToggle = (playerId: string) => {
    setShortlistedPlayerIds((current) => {
      if (current.includes(playerId)) {
        return current.filter((id) => id !== playerId)
      }

      if (current.length >= SHORTLIST_SIZE) {
        return current
      }

      return [...current, playerId]
    })
  }

  const handleNextRound = () => {
    if (!gameState) {
      return
    }

    const nextState = nextRound(gameState)
    setGameState(nextState)
    setSelectedCardIds([])
  }

  const handleRestart = () => {
    setGameState(null)
    setSelectedCardIds([])
    setPlayerNamesInput('Ada, Grace')
    clearPersistedState()
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">CAH</span>
          <div>
            <p className="eyebrow">Local party game prototype</p>
            <h1>Cards Against Humanity</h1>
          </div>
        </div>
      </header>

      {!gameState ? (
        <section className="hero-panel setup-panel">
          <div className="hero-copy">
            <p className="eyebrow">Phase 1 • local play</p>
            <h2>Set up a quick table and start the laughs.</h2>
            <p>
              Add a few player names, deal the cards, and begin a round of black-card
              chaos right in your browser.
            </p>
            <div className="setup-card">
              <label className="name-input" htmlFor="players">
                Player names
                <input
                  id="players"
                  value={playerNamesInput}
                  onChange={(event) => setPlayerNamesInput(event.target.value)}
                  placeholder="Ada, Grace, Linus"
                />
              </label>
              {parsedSetupNames.length >= LARGE_TABLE_THRESHOLD ? (
                <p className="setup-warning">Large table mode will auto-enable: 5-card hands, 3 rounds.</p>
              ) : null}
              {parsedSetupNames.length > MAX_PLAYERS ? (
                <p className="setup-warning">Only the first {MAX_PLAYERS} players will be used.</p>
              ) : null}
              {hasDeckErrors ? (
                <div className="setup-error-box">
                  <p>The card deck is invalid. Fix these issues before starting:</p>
                  <ul>
                    {deckErrors.map((error) => (
                      <li key={error}>{error}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              <button type="button" className="primary-action" onClick={startGame} disabled={hasDeckErrors}>
                Start game
              </button>
            </div>
          </div>
        </section>
      ) : (
        <>
          <section className="table-shell">
            <div className="table-main">
              <div className="table-topbar">
                <div>
                  <p className="eyebrow">Round {gameState.round}</p>
                  <h2>{gameState.blackCard?.text}</h2>
                </div>
                <div className="phase-chip">{gameState.phase.replace(/-/g, ' ')}</div>
              </div>

              <div className="status-row">
                <div className="status-pill">
                  Judge: <strong>{gameState.players[gameState.judgeIndex]?.name}</strong>
                </div>
                <div className="status-pill">
                  Current turn: <strong>{activePlayer?.name ?? 'Waiting'}</strong>
                </div>
                <div className="status-pill">
                  Your hand: <strong>{activePlayer?.hand.length ?? 0} cards</strong>
                </div>
                {gameState.largeTableMode ? (
                  <div className="status-pill">
                    Mode: <strong>Large table</strong>
                  </div>
                ) : null}
              </div>

              <div className="table-body">
                <article className="prompt-card">
                  <span>Prompt card</span>
                  <strong>{gameState.blackCard?.text}</strong>
                  <p>Pick {gameState.blackCard?.pick ?? 1} white card{(gameState.blackCard?.pick ?? 1) > 1 ? 's' : ''}.</p>
                </article>

                <aside className="table-sidebar">
                  <div className="sidebar-card">
                    <h3>Table status</h3>
                    <p>{gameState.phase === 'waiting-for-answers' ? 'Players are choosing answers.' : null}</p>
                    <p>{gameState.phase === 'waiting-for-judge' ? 'The judge is choosing a winner.' : null}</p>
                    <p>{gameState.phase === 'round-over' ? 'The round has finished.' : null}</p>
                    <p>{gameState.phase === 'game-over' ? 'The game is complete.' : null}</p>
                  </div>

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

                  <div className="sidebar-card">
                    <h3>Recent rounds</h3>
                    <div className="history-stack">
                      {gameState.roundHistory.length === 0 ? <p>No rounds finished yet.</p> : null}
                      {gameState.roundHistory
                        .slice(-5)
                        .reverse()
                        .map((entry) => (
                          <div key={`${entry.round}-${entry.winnerId}`} className="history-item">
                            <strong>Round {entry.round}: {entry.winnerName}</strong>
                            <p>{entry.blackCardText}</p>
                            <p>Winning card: {entry.winningCardText}</p>
                          </div>
                        ))}
                    </div>
                  </div>
                </aside>
              </div>
            </div>
          </section>

          {gameState.phase === 'waiting-for-answers' && activePlayer ? (
            <section className="game-panel">
              <div className="panel-heading">
                <h3>{activePlayer.name}, choose your best answer</h3>
                <p>Pick {requiredPick} card{requiredPick > 1 ? 's' : ''} from your hand.</p>
              </div>
              <div className="answer-grid hand-grid">
                {activePlayer.hand.map((card) => (
                  <button
                    key={card.id}
                    type="button"
                    className={`answer-card ${selectedCardIds.includes(card.id) ? 'selected' : ''}`}
                    onClick={() => handleCardToggle(card.id)}
                  >
                    <span className="card-label">White card</span>
                    {card.text}
                  </button>
                ))}
              </div>
              <button
                type="button"
                className="primary-action"
                onClick={handleAnswerSubmit}
                disabled={selectedCardIds.length !== requiredPick}
              >
                Submit {requiredPick} card{requiredPick > 1 ? 's' : ''}
              </button>
            </section>
          ) : null}

          {gameState.phase === 'waiting-for-judge' ? (
            <section className="game-panel">
              <div className="panel-heading">
                <h3>Judge picks a winner</h3>
                <p>Choose the funniest answer from the table.</p>
              </div>
              <div className="answer-grid">
                {visibleSubmittedAnswers.map((entry) => {
                  const speaker = gameState.players.find((player) => player.id === entry.playerId)
                  const isShortlisted = shortlistedPlayerIds.includes(entry.playerId)
                  return (
                    <button
                      key={`${entry.playerId}-${entry.cards.map((card) => card.id).join('-')}`}
                      type="button"
                      className={`answer-card ${isShortlisted ? 'shortlisted' : ''}`}
                      onClick={() => {
                        if (shortlistMode && !shortlistLocked) {
                          handleShortlistCandidateToggle(entry.playerId)
                          return
                        }

                        handleWinnerPick(entry.playerId)
                      }}
                    >
                      <span className="card-label">Submitted by {speaker?.name}</span>
                      <strong>{entry.cards.map((card) => card.text).join(' / ')}</strong>
                    </button>
                  )
                })}
              </div>
              {canUseShortlist ? (
                <div className="judge-shortlist">
                  <button
                    type="button"
                    className="secondary-action"
                    onClick={handleShortlistToggle}
                  >
                    {shortlistMode ? 'Disable shortlist' : 'Enable shortlist'}
                  </button>
                  {shortlistMode && !shortlistLocked ? (
                    <>
                      <span>
                        Select up to {SHORTLIST_SIZE} finalists ({shortlistedPlayerIds.length}/{SHORTLIST_SIZE})
                      </span>
                      <button
                        type="button"
                        className="secondary-action"
                        onClick={() => setShortlistLocked(true)}
                        disabled={shortlistedPlayerIds.length < 2}
                      >
                        Review shortlist
                      </button>
                    </>
                  ) : null}
                  {shortlistMode && shortlistLocked ? (
                    <>
                      <span>Pick the winner from shortlisted finalists.</span>
                      <button
                        type="button"
                        className="secondary-action"
                        onClick={() => setShortlistLocked(false)}
                      >
                        Edit shortlist
                      </button>
                    </>
                  ) : null}
                </div>
              ) : null}
              {judgePageCount > 1 && !(shortlistMode && shortlistLocked) ? (
                <div className="judge-pagination">
                  <button
                    type="button"
                    className="secondary-action"
                    onClick={() => setJudgePage((page) => Math.max(1, page - 1))}
                    disabled={judgePage === 1}
                  >
                    Previous
                  </button>
                  <span>Page {judgePage} of {judgePageCount}</span>
                  <button
                    type="button"
                    className="secondary-action"
                    onClick={() => setJudgePage((page) => Math.min(judgePageCount, page + 1))}
                    disabled={judgePage === judgePageCount}
                  >
                    Next
                  </button>
                </div>
              ) : null}
            </section>
          ) : null}

          {gameState.phase === 'round-over' ? (
            <section className="game-panel">
              <div className="panel-heading">
                <h3>Round complete</h3>
                <p>{gameState.players.find((player) => player.id === gameState.winnerId)?.name} wins this round.</p>
              </div>
              <div className="action-row">
                <button type="button" className="primary-action" onClick={handleNextRound}>
                  {gameState.round >= gameState.maxRounds ? 'Finish game' : 'Next round'}
                </button>
                <button type="button" className="secondary-action" onClick={handleRestart}>
                  Restart game
                </button>
              </div>
            </section>
          ) : null}

          {gameState.phase === 'game-over' ? (
            <section className="game-panel">
              <div className="panel-heading">
                <h3>Game over</h3>
                <p>
                  {gameState.players.reduce((leader, player) =>
                    player.score > leader.score ? player : leader
                  , gameState.players[0]).name} wins the table.
                </p>
              </div>
              <div className="action-row">
                <button type="button" className="secondary-action" onClick={handleRestart}>
                  Play again
                </button>
              </div>
            </section>
          ) : null}
        </>
      )}
    </main>
  )
}

export default App

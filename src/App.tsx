import { useEffect, useMemo, useState } from 'react'
import './App.css'
import {
  chooseWinner,
  createInitialGameState,
  nextRound,
  submitAnswer,
  type GameState
} from './game'
import { clearPersistedState, loadPersistedState, savePersistedState } from './persistence'

function App() {
  const [playerNamesInput, setPlayerNamesInput] = useState('Ada, Grace')
  const [gameState, setGameState] = useState<GameState | null>(null)
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null)

  useEffect(() => {
    const persisted = loadPersistedState()
    if (persisted.gameState) {
      setGameState(persisted.gameState)
    }

    if (persisted.playerNamesInput) {
      setPlayerNamesInput(persisted.playerNamesInput)
    }
  }, [])

  useEffect(() => {
    if (!gameState) {
      clearPersistedState()
      return
    }

    savePersistedState(gameState, playerNamesInput)
  }, [gameState, playerNamesInput])

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

  const startGame = () => {
    const names = playerNamesInput
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean)

    const nextState = createInitialGameState(names.length >= 2 ? names : ['Player 1', 'Player 2'])
    setGameState(nextState)
    setSelectedCardId(null)
  }

  const handleAnswerSubmit = () => {
    if (!gameState || !activePlayerId || !selectedCardId) {
      return
    }

    const nextState = submitAnswer(gameState, activePlayerId, selectedCardId)
    setGameState(nextState)
    setSelectedCardId(null)
  }

  const handleWinnerPick = (winnerId: string) => {
    if (!gameState) {
      return
    }

    const nextState = chooseWinner(gameState, winnerId)
    setGameState(nextState)
  }

  const handleNextRound = () => {
    if (!gameState) {
      return
    }

    const nextState = nextRound(gameState)
    setGameState(nextState)
    setSelectedCardId(null)
  }

  const handleRestart = () => {
    setGameState(null)
    setSelectedCardId(null)
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
              <button type="button" className="primary-action" onClick={startGame}>
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
                </aside>
              </div>
            </div>
          </section>

          {gameState.phase === 'waiting-for-answers' && activePlayer ? (
            <section className="game-panel">
              <div className="panel-heading">
                <h3>{activePlayer.name}, choose your best answer</h3>
                <p>Your hand is laid out face down on the table.</p>
              </div>
              <div className="answer-grid hand-grid">
                {activePlayer.hand.map((card) => (
                  <button
                    key={card.id}
                    type="button"
                    className={`answer-card ${selectedCardId === card.id ? 'selected' : ''}`}
                    onClick={() => setSelectedCardId(card.id)}
                  >
                    <span className="card-label">White card</span>
                    {card.text}
                  </button>
                ))}
              </div>
              <button type="button" className="primary-action" onClick={handleAnswerSubmit}>
                Submit answer
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
                {gameState.submittedAnswers.map((entry) => {
                  const speaker = gameState.players.find((player) => player.id === entry.playerId)
                  return (
                    <button
                      key={entry.card.id}
                      type="button"
                      className="answer-card"
                      onClick={() => handleWinnerPick(entry.playerId)}
                    >
                      <span className="card-label">Submitted by {speaker?.name}</span>
                      <strong>{entry.card.text}</strong>
                    </button>
                  )
                })}
              </div>
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
                  {gameState.round >= 5 ? 'Finish game' : 'Next round'}
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

import { useState } from 'react'
import './App.css'

type Mode = 'local' | 'private' | 'public'

function App() {
  const [mode, setMode] = useState<Mode>('local')

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">CAH</span>
          <div>
            <p className="eyebrow">Browser-based party game</p>
            <h1>Cards Against Humanity</h1>
          </div>
        </div>
        <nav className="top-actions" aria-label="Primary navigation">
          <a href="#roadmap">Roadmap</a>
          <a href="#setup">How it works</a>
        </nav>
      </header>

      <section className="hero-panel">
        <div className="hero-copy">
          <p className="eyebrow">Phase 1 • local play, no sign-in</p>
          <h2>Build a fast, funny party game you can share with friends.</h2>
          <p>
            This first pass focuses on a simple, polished experience for local
            play and lays the foundation for private rooms and real-time
            multiplayer later.
          </p>
          <div className="hero-actions">
            <button type="button">Create a room</button>
            <button type="button" className="secondary">
              Join a room
            </button>
          </div>
        </div>

        <div className="hero-card" aria-label="Example game cards">
          <div className="card-stack">
            <article className="black-card">
              <span>Prompt</span>
              <strong>Things that make a great first date</strong>
            </article>
            <article className="white-card">
              <span>Answer</span>
              <strong>Accidentally starting a group chat with your ex</strong>
            </article>
          </div>
          <div className="game-pill">Local mode ready</div>
        </div>
      </section>

      <section className="mode-grid" aria-label="Game modes">
        {[
          {
            key: 'local',
            title: 'Local play',
            description: 'Perfect for testing the rules and UI on one device.'
          },
          {
            key: 'private',
            title: 'Private rooms',
            description: 'Invite players with a room code and keep it cozy.'
          },
          {
            key: 'public',
            title: 'Public lobbies',
            description: 'Open matchmaking for larger, casual sessions.'
          }
        ].map((item) => (
          <button
            key={item.key}
            type="button"
            className={`mode-card ${mode === item.key ? 'active' : ''}`}
            onClick={() => setMode(item.key as Mode)}
          >
            <h3>{item.title}</h3>
            <p>{item.description}</p>
          </button>
        ))}
      </section>

      <section className="info-grid" id="setup">
        <article>
          <h3>1. Start a session</h3>
          <p>Choose a mode and create a room in seconds.</p>
        </article>
        <article>
          <h3>2. Deal the cards</h3>
          <p>Players receive white cards and one judge draws the black card.</p>
        </article>
        <article>
          <h3>3. Keep the laughs going</h3>
          <p>Score rounds, rotate the judge, and celebrate the best answer.</p>
        </article>
      </section>

      <section className="roadmap-panel" id="roadmap">
        <h3>Recommended roadmap</h3>
        <ul>
          <li>Build a polished local game loop with card selection and scoring.</li>
          <li>Add private room creation with shareable codes.</li>
          <li>Introduce real-time multiplayer with a simple backend.</li>
          <li>Deploy the app to Vercel and share a public preview.</li>
        </ul>
      </section>
    </main>
  )
}

export default App

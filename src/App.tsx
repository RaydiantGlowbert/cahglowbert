import './App.css'
import RemoteLobby from './remote/RemoteLobby'

function App() {
  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">CAH</span>
          <div>
            <p className="eyebrow">Online multiplayer</p>
            <div className="brand-title-row">
              <h1>Cards Against Humanity</h1>
              <span className="brand-edition">Team Raydiant Edition</span>
            </div>
          </div>
        </div>
      </header>

      <RemoteLobby />
    </main>
  )
}

export default App

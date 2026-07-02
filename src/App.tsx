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
            <h1>Cards Against Humanity</h1>
          </div>
        </div>
      </header>

      <RemoteLobby />
    </main>
  )
}

export default App

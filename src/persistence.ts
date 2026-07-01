export type PersistedState = {
  gameState: import('./game').GameState | null
  playerNamesInput: string
}

const STORAGE_KEY = 'cah-local-game'

export function savePersistedState(gameState: import('./game').GameState | null, playerNamesInput: string) {
  const payload: PersistedState = {
    gameState,
    playerNamesInput
  }

  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload))
}

export function loadPersistedState(): PersistedState {
  if (typeof window === 'undefined') {
    return { gameState: null, playerNamesInput: '' }
  }

  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    return { gameState: null, playerNamesInput: '' }
  }

  try {
    return JSON.parse(raw) as PersistedState
  } catch {
    return { gameState: null, playerNamesInput: '' }
  }
}

export function clearPersistedState() {
  window.localStorage.removeItem(STORAGE_KEY)
}

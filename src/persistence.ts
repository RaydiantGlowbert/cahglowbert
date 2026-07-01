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
    const parsed = JSON.parse(raw) as PersistedState
    const gameState = parsed.gameState

    if (!gameState) {
      return { gameState: null, playerNamesInput: parsed.playerNamesInput ?? '' }
    }

    return {
      ...parsed,
      gameState: {
        ...gameState,
        roundHistory: Array.isArray(gameState.roundHistory) ? gameState.roundHistory : []
      },
      playerNamesInput: parsed.playerNamesInput ?? ''
    }
  } catch {
    return { gameState: null, playerNamesInput: '' }
  }
}

export function clearPersistedState() {
  window.localStorage.removeItem(STORAGE_KEY)
}

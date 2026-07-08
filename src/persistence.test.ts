// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest'
import { createInitialGameState } from './game'
import { loadPersistedState, savePersistedState } from './persistence'

describe('persistence', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('persists and restores a game state', () => {
    const state = createInitialGameState(['Ada', 'Grace'])

    savePersistedState(state, 'Ada, Grace')

    const restored = loadPersistedState()

    expect(restored.gameState?.round).toBe(1)
    expect(restored.gameState?.players[0].name).toBe('Ada')
    expect(restored.playerNamesInput).toBe('Ada, Grace')
  })

  it('backfills used white card ids for older saved states', () => {
    const legacyState = createInitialGameState(['Ada', 'Grace'])
    const payload = {
      gameState: {
        ...legacyState,
        usedWhiteCardIds: undefined
      },
      playerNamesInput: 'Ada, Grace'
    }

    window.localStorage.setItem('cah-local-game', JSON.stringify(payload))

    const restored = loadPersistedState()

    expect(restored.gameState?.usedWhiteCardIds).toEqual([])
  })
})

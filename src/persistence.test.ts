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
})

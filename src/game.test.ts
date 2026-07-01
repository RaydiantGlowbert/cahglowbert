import { describe, expect, it } from 'vitest'
import { blackCards } from './cards/blackCards'
import { whiteCards } from './cards/whiteCards'
import {
  chooseWinner,
  createInitialGameState,
  nextRound,
  shuffleCards,
  submitAnswer
} from './game'

describe('game flow', () => {
  it('creates a game state with players and a black card', () => {
    const state = createInitialGameState(['Ada', 'Grace'])

    expect(state.players).toHaveLength(2)
    expect(state.players[0].hand).toHaveLength(7)
    expect(blackCards.length).toBeGreaterThan(0)
    expect(state.blackCard?.type).toBe('black')
    expect(state.blackCard?.pick).toBe(1)
    expect(state.phase).toBe('waiting-for-answers')
  })

  it('collects answers until the judge phase begins', () => {
    const state = createInitialGameState(['Ada', 'Grace'])
    const firstAnswer = submitAnswer(state, 'player-2', state.players[1].hand[0].id)

    expect(firstAnswer.phase).toBe('waiting-for-judge')
    expect(firstAnswer.submittedAnswers).toHaveLength(1)
  })

  it('awards a point to the winning player and advances the round', () => {
    const state = createInitialGameState(['Ada', 'Grace'])
    const firstAnswer = submitAnswer(state, 'player-1', state.players[0].hand[0].id)
    const secondAnswer = submitAnswer(firstAnswer, 'player-2', firstAnswer.players[1].hand[0].id)
    const judged = chooseWinner(secondAnswer, 'player-1')
    const advanced = nextRound(judged)

    expect(judged.players[0].score).toBe(1)
    expect(advanced.phase).toBe('waiting-for-answers')
    expect(advanced.round).toBe(2)
  })

  it('records round history when a winner is picked', () => {
    const state = createInitialGameState(['Ada', 'Grace'])
    const answered = submitAnswer(state, 'player-2', state.players[1].hand[0].id)
    const judged = chooseWinner(answered, 'player-2')

    expect(judged.roundHistory).toHaveLength(1)
    expect(judged.roundHistory[0]?.round).toBe(1)
    expect(judged.roundHistory[0]?.winnerId).toBe('player-2')
    expect(judged.roundHistory[0]?.winnerName).toBe('Grace')
    expect(judged.roundHistory[0]?.blackCardText).toBe(state.blackCard?.text)
  })

  it('shuffles cards without losing the card content', () => {
    const shuffled = shuffleCards(whiteCards)

    expect(shuffled).toHaveLength(whiteCards.length)
    expect(shuffled[0].id).toBeDefined()
    expect(shuffled.some((card) => card.id === 'white-001')).toBe(true)
  })

  it('ends the game after the final round', () => {
    const state = createInitialGameState(['Ada', 'Grace'])
    let nextState = state

    for (let round = 1; round < 5; round += 1) {
      nextState = nextRound(nextState)
    }

    expect(nextState.phase).toBe('game-over')
    expect(nextState.round).toBe(5)
  })
})

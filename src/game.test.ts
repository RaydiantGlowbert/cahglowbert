import { describe, expect, it } from 'vitest'
import { blackCards } from './cards/blackCards'
import { whiteCards } from './cards/whiteCards'
import {
  MAX_PLAYERS,
  type Card,
  chooseWinner,
  createInitialGameState,
  nextRound,
  shuffleCards,
  submitAnswer,
  validateDecks
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
    const firstAnswer = submitAnswer(state, 'player-2', [state.players[1].hand[0].id])

    expect(firstAnswer.phase).toBe('waiting-for-judge')
    expect(firstAnswer.submittedAnswers).toHaveLength(1)
  })

  it('awards a point to the winning player and advances the round', () => {
    const state = createInitialGameState(['Ada', 'Grace'])
    const firstAnswer = submitAnswer(state, 'player-1', [state.players[0].hand[0].id])
    const secondAnswer = submitAnswer(firstAnswer, 'player-2', [firstAnswer.players[1].hand[0].id])
    const judged = chooseWinner(secondAnswer, 'player-1')
    const advanced = nextRound(judged)

    expect(judged.players[0].score).toBe(1)
    expect(advanced.phase).toBe('waiting-for-answers')
    expect(advanced.round).toBe(2)
  })

  it('records round history when a winner is picked', () => {
    const state = createInitialGameState(['Ada', 'Grace'])
    const answered = submitAnswer(state, 'player-2', [state.players[1].hand[0].id])
    const judged = chooseWinner(answered, 'player-2')

    expect(judged.roundHistory).toHaveLength(1)
    expect(judged.roundHistory[0]?.round).toBe(1)
    expect(judged.roundHistory[0]?.winnerId).toBe('player-2')
    expect(judged.roundHistory[0]?.winnerName).toBe('Grace')
    expect(judged.roundHistory[0]?.blackCardText).toBe(state.blackCard?.text)
  })

  it('requires players to submit exactly the pick count', () => {
    const state = createInitialGameState(['Ada', 'Grace', 'Linus'])
    const pickTwoState = {
      ...state,
      blackCard: {
        ...(state.blackCard ?? blackCards[0]),
        pick: 2
      }
    }

    const invalid = submitAnswer(pickTwoState, 'player-2', [pickTwoState.players[1].hand[0].id])

    expect(invalid).toBe(pickTwoState)
    expect(invalid.submittedAnswers).toHaveLength(0)
  })

  it('stores multiple cards for pick-two submissions', () => {
    const state = createInitialGameState(['Ada', 'Grace', 'Linus'])
    const pickTwoState = {
      ...state,
      blackCard: {
        ...(state.blackCard ?? blackCards[0]),
        pick: 2
      }
    }
    const selectedCards = pickTwoState.players[1].hand.reduce<typeof pickTwoState.players[1]['hand']>((unique, card) => {
      if (unique.some((entry) => entry.id === card.id)) {
        return unique
      }

      if (unique.length >= 2) {
        return unique
      }

      return [...unique, card]
    }, [])

    expect(selectedCards).toHaveLength(2)

    const afterFirstSubmission = submitAnswer(
      pickTwoState,
      'player-2',
      selectedCards.map((card) => card.id)
    )

    expect(afterFirstSubmission.submittedAnswers).toHaveLength(1)
    expect(afterFirstSubmission.submittedAnswers[0]?.cards).toHaveLength(2)
    expect(afterFirstSubmission.players[1].hand).toHaveLength(5)
    expect(afterFirstSubmission.phase).toBe('waiting-for-answers')
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

  it('enables quick mode for large tables', () => {
    const names = Array.from({ length: 9 }, (_, index) => `Player ${index + 1}`)
    const state = createInitialGameState(names)

    expect(state.largeTableMode).toBe(true)
    expect(state.maxRounds).toBe(3)
    expect(state.handSize).toBe(5)
    expect(state.players[0]?.hand).toHaveLength(5)
  })

  it('caps player count at the maximum supported table size', () => {
    const names = Array.from({ length: MAX_PLAYERS + 3 }, (_, index) => `Player ${index + 1}`)
    const state = createInitialGameState(names)

    expect(state.players).toHaveLength(MAX_PLAYERS)
  })

  it('validates bad black pick values and empty text', () => {
    const invalidBlackDeck: Card[] = [
      { id: 'black-001', text: '', type: 'black', pick: 1 },
      { id: 'black-002', text: 'Test', type: 'black', pick: 3 }
    ]
    const result = validateDecks(invalidBlackDeck, whiteCards.slice(0, 2))

    expect(result.isValid).toBe(false)
    expect(result.errors.some((error) => error.includes('empty text'))).toBe(true)
    expect(result.errors.some((error) => error.includes('invalid pick value'))).toBe(true)
  })

  it('validates duplicate card ids', () => {
    const blackDeckWithDuplicate: Card[] = [
      { id: 'black-001', text: 'A ____.', type: 'black', pick: 1 },
      { id: 'black-001', text: 'B ____.', type: 'black', pick: 1 }
    ]
    const whiteDeckWithDuplicate: Card[] = [
      { id: 'white-001', text: 'First', type: 'white' },
      { id: 'white-001', text: 'Second', type: 'white' }
    ]

    const result = validateDecks(blackDeckWithDuplicate, whiteDeckWithDuplicate)

    expect(result.isValid).toBe(false)
    expect(result.errors.some((error) => error.includes('Black deck has duplicate ids'))).toBe(true)
    expect(result.errors.some((error) => error.includes('White deck has duplicate ids'))).toBe(true)
  })
})

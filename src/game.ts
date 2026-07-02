import { blackCards } from './cards/blackCards'
import { whiteCards } from './cards/whiteCards'

export type Card = {
  id: string
  text: string
  type: 'white' | 'black'
  pick?: number
}

export type Player = {
  id: string
  name: string
  score: number
  hand: Card[]
}

export type RoundHistoryEntry = {
  round: number
  blackCardText: string
  winningCardText: string
  winnerId: string
  winnerName: string
}

export type DeckValidationResult = {
  isValid: boolean
  errors: string[]
}

export const MAX_PLAYERS = 15
export const LARGE_TABLE_THRESHOLD = 9
const DEFAULT_HAND_SIZE = 7
const QUICK_MODE_HAND_SIZE = 5
const DEFAULT_MAX_ROUNDS = 5
const QUICK_MODE_MAX_ROUNDS = 3

export type GameState = {
  players: Player[]
  judgeIndex: number
  blackCard: Card | null
  round: number
  phase: 'waiting-for-answers' | 'waiting-for-judge' | 'round-over' | 'game-over'
  submittedAnswers: Array<{ playerId: string; cards: Card[] }>
  winnerId: string | null
  answeringPlayerId: string | null
  roundHistory: RoundHistoryEntry[]
  handSize: number
  maxRounds: number
  largeTableMode: boolean
}

export const initialBlackCards: Card[] = blackCards
export const initialWhiteCards: Card[] = whiteCards

function collectDuplicateIds(cards: Card[]): string[] {
  const seen = new Set<string>()
  const duplicates = new Set<string>()

  for (const card of cards) {
    if (seen.has(card.id)) {
      duplicates.add(card.id)
      continue
    }

    seen.add(card.id)
  }

  return [...duplicates]
}

export function validateDecks(blackDeck: Card[], whiteDeck: Card[]): DeckValidationResult {
  const errors: string[] = []

  if (blackDeck.length === 0) {
    errors.push('Black deck is empty.')
  }

  if (whiteDeck.length === 0) {
    errors.push('White deck is empty.')
  }

  blackDeck.forEach((card, index) => {
    if (!card.id.trim()) {
      errors.push(`Black card #${index + 1} has an empty id.`)
    }

    if (!card.text.trim()) {
      errors.push(`Black card ${card.id || `#${index + 1}`} has empty text.`)
    }

    if (card.type !== 'black') {
      errors.push(`Black card ${card.id || `#${index + 1}`} has invalid type ${card.type}.`)
    }

    const pickCount = card.pick ?? 1
    if (!Number.isInteger(pickCount) || pickCount < 1 || pickCount > 2) {
      errors.push(`Black card ${card.id || `#${index + 1}`} has invalid pick value ${String(card.pick)}.`)
    }
  })

  whiteDeck.forEach((card, index) => {
    if (!card.id.trim()) {
      errors.push(`White card #${index + 1} has an empty id.`)
    }

    if (!card.text.trim()) {
      errors.push(`White card ${card.id || `#${index + 1}`} has empty text.`)
    }

    if (card.type !== 'white') {
      errors.push(`White card ${card.id || `#${index + 1}`} has invalid type ${card.type}.`)
    }
  })

  const duplicateBlackIds = collectDuplicateIds(blackDeck)
  if (duplicateBlackIds.length > 0) {
    errors.push(`Black deck has duplicate ids: ${duplicateBlackIds.join(', ')}.`)
  }

  const duplicateWhiteIds = collectDuplicateIds(whiteDeck)
  if (duplicateWhiteIds.length > 0) {
    errors.push(`White deck has duplicate ids: ${duplicateWhiteIds.join(', ')}.`)
  }

  return {
    isValid: errors.length === 0,
    errors
  }
}

export const deckValidation = validateDecks(initialBlackCards, initialWhiteCards)

export function createPlayers(names: string[]): Player[] {
  return names.map((name, index) => ({
    id: `player-${index + 1}`,
    name,
    score: 0,
    hand: []
  }))
}

export function shuffleCards<T>(cards: T[]): T[] {
  const shuffled = [...cards]
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1))
    ;[shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]]
  }

  return shuffled
}

function getNonJudgePlayerIds(players: Player[], judgeIndex: number): string[] {
  return players.filter((_, index) => index !== judgeIndex).map((player) => player.id)
}

function getNextPendingAnsweringPlayerId(
  players: Player[],
  judgeIndex: number,
  submittedAnswers: Array<{ playerId: string; cards: Card[] }>
): string | null {
  const nonJudgePlayerIds = getNonJudgePlayerIds(players, judgeIndex)
  const submittedPlayerIds = new Set(submittedAnswers.map((entry) => entry.playerId))

  return nonJudgePlayerIds.find((playerId) => !submittedPlayerIds.has(playerId)) ?? null
}

export function dealHands(players: Player[], deck: Card[], handSize = DEFAULT_HAND_SIZE): Player[] {
  const deckPool = shuffleCards(deck)
  const dealtPlayers: Player[] = players.map((player) => ({ ...player, hand: [] as Card[] }))

  const drawCard = () => {
    if (deckPool.length === 0) {
      deckPool.push(...shuffleCards(deck))
    }

    return deckPool.shift()
  }

  for (let i = 0; i < handSize; i += 1) {
    for (const player of dealtPlayers) {
      const nextCard = drawCard()
      if (nextCard) {
        player.hand.push(nextCard)
      }
    }
  }

  return dealtPlayers
}

export function createInitialGameState(names: string[]): GameState {
  if (!deckValidation.isValid) {
    throw new Error(`Invalid card data: ${deckValidation.errors.join(' ')}`)
  }

  const cappedNames = names.slice(0, MAX_PLAYERS)
  const largeTableMode = cappedNames.length >= LARGE_TABLE_THRESHOLD
  const handSize = largeTableMode ? QUICK_MODE_HAND_SIZE : DEFAULT_HAND_SIZE
  const maxRounds = largeTableMode ? QUICK_MODE_MAX_ROUNDS : DEFAULT_MAX_ROUNDS
  const players = dealHands(createPlayers(cappedNames), initialWhiteCards, handSize)
  const judgeIndex = 0
  return {
    players,
    judgeIndex,
    blackCard: initialBlackCards[0],
    round: 1,
    phase: 'waiting-for-answers',
    submittedAnswers: [],
    winnerId: null,
    answeringPlayerId: getNextPendingAnsweringPlayerId(players, judgeIndex, []),
    roundHistory: [],
    handSize,
    maxRounds,
    largeTableMode
  }
}

export function submitAnswer(state: GameState, playerId: string, cardIds: string[]): GameState {
  const player = state.players.find((entry) => entry.id === playerId)
  const requiredPick = state.blackCard?.pick ?? 1
  const uniqueCardIds = Array.from(new Set(cardIds))
  const selectedCards = player?.hand.filter((card) => uniqueCardIds.includes(card.id)) ?? []
  const hasAlreadySubmitted = state.submittedAnswers.some((entry) => entry.playerId === playerId)

  if (
    !player ||
    state.phase !== 'waiting-for-answers' ||
    hasAlreadySubmitted ||
    state.players[state.judgeIndex]?.id === playerId ||
    uniqueCardIds.length !== requiredPick ||
    selectedCards.length !== requiredPick
  ) {
    return state
  }

  const updatedPlayers = state.players.map((entry) =>
    entry.id === playerId
      ? {
          ...entry,
          hand: entry.hand.filter((card) => !uniqueCardIds.includes(card.id))
        }
      : entry
  )

  const nextSubmittedAnswers = [...state.submittedAnswers, { playerId, cards: selectedCards }]
  const allPlayersAnswered = nextSubmittedAnswers.length >= state.players.length - 1

  return {
    ...state,
    players: updatedPlayers,
    submittedAnswers: nextSubmittedAnswers,
    phase: allPlayersAnswered ? 'waiting-for-judge' : 'waiting-for-answers',
    answeringPlayerId: allPlayersAnswered
      ? null
      : getNextPendingAnsweringPlayerId(state.players, state.judgeIndex, nextSubmittedAnswers)
  }
}

export function chooseWinner(state: GameState, winnerId: string): GameState {
  if (state.phase !== 'waiting-for-judge') {
    return state
  }

  const winner = state.players.find((player) => player.id === winnerId)
  if (!winner) {
    return state
  }

  const updatedPlayers = state.players.map((player) =>
    player.id === winnerId ? { ...player, score: player.score + 1 } : player
  )

  const winningSubmission = state.submittedAnswers.find((answer) => answer.playerId === winnerId)
  const nextRoundHistory: RoundHistoryEntry[] = [
    ...state.roundHistory,
    {
      round: state.round,
      blackCardText: state.blackCard?.text ?? '',
      winningCardText: winningSubmission?.cards.map((card) => card.text).join(' / ') ?? '',
      winnerId,
      winnerName: winner.name
    }
  ]

  return {
    ...state,
    players: updatedPlayers,
    winnerId,
    phase: 'round-over',
    roundHistory: nextRoundHistory
  }
}

export function nextRound(state: GameState): GameState {
  const nextRoundNumber = state.round + 1
  const nextJudgeIndex = (state.judgeIndex + 1) % state.players.length
  const nextBlackCard = initialBlackCards[(nextRoundNumber - 1) % initialBlackCards.length] ?? initialBlackCards[0]

  if (nextRoundNumber > state.maxRounds) {
    return {
      ...state,
      phase: 'game-over',
      submittedAnswers: [],
      answeringPlayerId: null,
      winnerId: null
    }
  }

  if (nextRoundNumber >= state.maxRounds) {
    return {
      ...state,
      judgeIndex: nextJudgeIndex,
      blackCard: nextBlackCard,
      round: nextRoundNumber,
      phase: 'game-over',
      submittedAnswers: [],
      winnerId: null,
      answeringPlayerId: null
    }
  }

  return {
    ...state,
    judgeIndex: nextJudgeIndex,
    blackCard: nextBlackCard,
    round: nextRoundNumber,
    phase: 'waiting-for-answers',
    submittedAnswers: [],
    winnerId: null,
    answeringPlayerId: getNextPendingAnsweringPlayerId(state.players, nextJudgeIndex, [])
  }
}

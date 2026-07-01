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
}

export const initialBlackCards: Card[] = blackCards
export const initialWhiteCards: Card[] = whiteCards

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

function getNextAnsweringPlayerId(
  players: Player[],
  judgeIndex: number,
  currentPlayerId: string | null
): string | null {
  const nonJudgePlayerIds = getNonJudgePlayerIds(players, judgeIndex)
  if (nonJudgePlayerIds.length === 0) {
    return null
  }

  if (!currentPlayerId) {
    return nonJudgePlayerIds[0] ?? null
  }

  const currentIndex = nonJudgePlayerIds.indexOf(currentPlayerId)
  if (currentIndex === -1) {
    return nonJudgePlayerIds[0] ?? null
  }

  return nonJudgePlayerIds[(currentIndex + 1) % nonJudgePlayerIds.length] ?? null
}

export function dealHands(players: Player[], deck: Card[]): Player[] {
  const deckPool = shuffleCards(deck)
  const dealtPlayers: Player[] = players.map((player) => ({ ...player, hand: [] as Card[] }))

  const drawCard = () => {
    if (deckPool.length === 0) {
      deckPool.push(...shuffleCards(deck))
    }

    return deckPool.shift()
  }

  for (let i = 0; i < 7; i += 1) {
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
  const players = dealHands(createPlayers(names), initialWhiteCards)
  const judgeIndex = 0
  return {
    players,
    judgeIndex,
    blackCard: initialBlackCards[0],
    round: 1,
    phase: 'waiting-for-answers',
    submittedAnswers: [],
    winnerId: null,
    answeringPlayerId: getNextAnsweringPlayerId(players, judgeIndex, null),
    roundHistory: []
  }
}

export function submitAnswer(state: GameState, playerId: string, cardIds: string[]): GameState {
  const player = state.players.find((entry) => entry.id === playerId)
  const requiredPick = state.blackCard?.pick ?? 1
  const uniqueCardIds = Array.from(new Set(cardIds))
  const selectedCards = player?.hand.filter((card) => uniqueCardIds.includes(card.id)) ?? []

  if (
    !player ||
    state.phase !== 'waiting-for-answers' ||
    state.answeringPlayerId !== playerId ||
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
      : getNextAnsweringPlayerId(state.players, state.judgeIndex, playerId)
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

  if (nextRoundNumber > 5) {
    return {
      ...state,
      phase: 'game-over',
      submittedAnswers: [],
      answeringPlayerId: null
    }
  }

  if (nextRoundNumber === 5) {
    return {
      ...state,
      judgeIndex: (state.judgeIndex + 1) % state.players.length,
      blackCard: initialBlackCards[(nextRoundNumber - 1) % initialBlackCards.length] ?? initialBlackCards[0],
      round: nextRoundNumber,
      phase: 'game-over',
      submittedAnswers: [],
      winnerId: null,
      answeringPlayerId: null
    }
  }

  const nextJudgeIndex = (state.judgeIndex + 1) % state.players.length
  const nextBlackCard = initialBlackCards[(nextRoundNumber - 1) % initialBlackCards.length] ?? initialBlackCards[0]

  return {
    ...state,
    judgeIndex: nextJudgeIndex,
    blackCard: nextBlackCard,
    round: nextRoundNumber,
    phase: 'waiting-for-answers',
    submittedAnswers: [],
    winnerId: null,
    answeringPlayerId: getNextAnsweringPlayerId(state.players, nextJudgeIndex, null)
  }
}

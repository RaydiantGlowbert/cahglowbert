import fs from 'fs'
import path from 'path'
import { createClient, type RedisClientType } from 'redis'
import type { GameState } from '../../src/game'

export type PersistedRoomPlayer = {
  id: string
  name: string
  isHost: boolean
  gamePlayerId?: string
  sessionToken: string
  connected: boolean
}

export type PersistedRoom = {
  roomCode: string
  players: PersistedRoomPlayer[]
  phase: 'lobby' | 'in-game'
  gameState: GameState | null
}

export type RoomStore = {
  load: () => Promise<PersistedRoom[]>
  save: (rooms: PersistedRoom[]) => Promise<void>
}

class FileRoomStore implements RoomStore {
  constructor(private readonly filePath: string) {}

  async load(): Promise<PersistedRoom[]> {
    try {
      if (!fs.existsSync(this.filePath)) {
        return []
      }

      const raw = await fs.promises.readFile(this.filePath, 'utf8')
      if (!raw.trim()) {
        return []
      }

      return JSON.parse(raw) as PersistedRoom[]
    } catch {
      return []
    }
  }

  async save(rooms: PersistedRoom[]): Promise<void> {
    const directory = path.dirname(this.filePath)
    if (!fs.existsSync(directory)) {
      await fs.promises.mkdir(directory, { recursive: true })
    }

    await fs.promises.writeFile(this.filePath, JSON.stringify(rooms, null, 2), 'utf8')
  }
}

class RedisRoomStore implements RoomStore {
  private readonly key = 'cah:rooms'
  private readonly client: RedisClientType
  private connectPromise: Promise<void> | null = null

  constructor(redisUrl: string) {
    this.client = createClient({ url: redisUrl })
  }

  private async ensureConnected() {
    if (this.client.isOpen) {
      return
    }

    if (!this.connectPromise) {
      this.connectPromise = this.client.connect().then(() => undefined)
    }

    await this.connectPromise
  }

  async load(): Promise<PersistedRoom[]> {
    try {
      await this.ensureConnected()
      const raw = await this.client.get(this.key)
      if (!raw) {
        return []
      }

      return JSON.parse(raw) as PersistedRoom[]
    } catch {
      return []
    }
  }

  async save(rooms: PersistedRoom[]): Promise<void> {
    await this.ensureConnected()
    await this.client.set(this.key, JSON.stringify(rooms))
  }
}

export function createRoomStore(options: {
  mode: string | undefined
  redisUrl: string | undefined
  filePath: string
}): RoomStore {
  const normalizedMode = options.mode?.trim().toLowerCase()

  if (normalizedMode === 'redis' && options.redisUrl) {
    return new RedisRoomStore(options.redisUrl)
  }

  if (!normalizedMode && options.redisUrl) {
    return new RedisRoomStore(options.redisUrl)
  }

  return new FileRoomStore(options.filePath)
}

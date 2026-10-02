export type Reading = { tokens: number; window: number }

/** The last main-loop request's cache figures. */
export type Cache = { hitRate: number | null; lastRequestAt: number }

/** Auto-warming since the last turn: how many warms, and whether the last one found the cache cold. */
export type Warm = { count: number; missed: boolean }

declare module 'claude-code' {
  interface PluginState {
    'token-weather': {
      history: Reading[]
      speed: number | null
      cache: Cache | null
      now: number
      warm: Warm
    }
  }
}

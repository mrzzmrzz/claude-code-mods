export type Reading = { tokens: number; window: number }

/** The last main-loop request's cache figures. */
export type Cache = { hitRate: number | null; lastRequestAt: number }

declare module 'claude-code' {
  interface PluginState {
    'token-weather': { history: Reading[]; speed: number | null; cache: Cache | null; now: number }
  }
}

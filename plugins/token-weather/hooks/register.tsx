import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Cache, Reading } from '../types'

const MAX_TURNS = 12
const BARS = '▁▂▃▄▅▆▇█'

const history = atom({ plugin: 'token-weather', key: 'history' } as const, [])
// Output tokens per second of the last turn, timed from each request's start.
const speed = atom({ plugin: 'token-weather', key: 'speed' } as const, null)
// Last turn's cache hit rate and when the last main-loop request touched the cache.
const cache = atom({ plugin: 'token-weather', key: 'cache' } as const, null)
// Wall clock, ticked every second so the cache countdown redraws.
const clock = atom({ plugin: 'token-weather', key: 'now' } as const, 0)

function forecast(percent: number) {
  if (percent >= 90) return { word: 'Compact soon', color: 'red' }
  if (percent >= 75) return { word: 'Storm', color: 'magenta' }
  if (percent >= 50) return { word: 'Showers', color: 'blue' }
  if (percent >= 25) return { word: 'Cloudy', color: 'cyan' }
  return { word: 'Clear', color: 'yellow' }
}

function short(n: number) {
  const trim = (x: number) => x.toFixed(1).replace(/\.0$/, '')
  if (Math.abs(n) >= 1e6) return `${trim(n / 1e6)}M`
  if (Math.abs(n) >= 1e3) return `${trim(n / 1e3)}k`
  return `${Math.round(n)}`
}

function sparkline(readings: Reading[]) {
  const peak = Math.max(...readings.map(r => r.tokens), 1)
  return readings
    .map(r => BARS[Math.min(BARS.length - 1, Math.floor((r.tokens / peak) * (BARS.length - 1) + 0.5))])
    .join('')
}

function countdown(ms: number) {
  const total = Math.ceil(ms / 1000)
  const m = Math.floor(total / 60)
  const sec = String(total % 60).padStart(2, '0')
  return `${m}:${sec}`
}

async function measure($: EngineInterface) {
  const { context } = await $.session.usage()
  if (context.tokens === undefined) return
  const reading: Reading = { tokens: context.tokens, window: context.window }
  await update($, history, h => [...h, reading].slice(-MAX_TURNS))
}

export const register: Register = (on, options) => {
  const ttlMs = options.cacheTtl === '5m' ? 5 * 60_000 : 60 * 60_000

  // Per main-loop turn: output tokens and milliseconds from request to response end.
  let streamed = { turnId: '', tokens: 0, ms: 0 }

  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) return yield* next(e)
    if (streamed.turnId !== e.turnId) streamed = { turnId: e.turnId, tokens: 0, ms: 0 }

    // Timed from the request, so thinking (streamed, summarized or not) and
    // prefill latency all count against the output tokens.
    const startedAt = await $.clock.now()
    const result = yield* next(e)
    if (result.usage) {
      streamed.tokens += result.usage.output_tokens
      streamed.ms += (await $.clock.now()) - startedAt
      // The cache's TTL restarts when a request reads or writes it.
      await update($, cache, c => ({ hitRate: c?.hitRate ?? null, lastRequestAt: startedAt }))
    }
    return result
  })

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    const tick = async () => {
      const t = await $.clock.now()
      await update($, clock, () => t)
    }
    await tick()
    $.clock.every(1000, () => void tick())
    // Seed one reading on a fresh load (or a hot reload mid-session).
    if ((await read($, history)).length === 0) await measure($)
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result
    await measure($)
    if (streamed.turnId === e.turnId && streamed.ms > 0) {
      const tps = streamed.tokens / (streamed.ms / 1000)
      await update($, speed, () => tps)
    }
    if (e.usage) {
      const u = e.usage
      const input = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
      if (input > 0) {
        const hitRate = u.cache_read_input_tokens / input
        await update($, cache, c => (c ? { ...c, hitRate } : c))
      }
    }
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const readings = await read($, history)
    const tps = await read($, speed)
    const cached = await read($, cache)
    const nowMs = await read($, clock)
    if (e.props.hasSurvey || readings.length === 0) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const now = readings[readings.length - 1]!
    const percent = Math.round((now.tokens / now.window) * 100)
    const sky = forecast(percent)
    const prev = readings[readings.length - 2] ?? null
    const delta = prev ? now.tokens - prev.tokens : null

    return (
      <Box>
        <Text color={sky.color} bold>
          {sky.word}
        </Text>
        <Text>
          {'  '}
          {percent}%{' '}
        </Text>
        <Text dimColor>
          {short(now.tokens)} / {short(now.window)}
          {'  '}
        </Text>
        <Text color={sky.color}>{sparkline(readings)}</Text>
        {delta !== null ? (
          <Text dimColor>
            {'  '}
            {delta >= 0 ? `▲ +${short(delta)}` : `▼ −${short(-delta)}`} last turn
          </Text>
        ) : null}
        {tps !== null ? (
          <Text dimColor>
            {'  '}{Math.round(tps)} tok/s
          </Text>
        ) : null}
        {cached !== null ? cacheInfo(Text, cached, cached.lastRequestAt + ttlMs - nowMs) : null}
      </Box>
    )
  })
}

// Text is the surface's own element, from $.ui.resolve.
function cacheInfo(Text: any, cached: Cache, left: number) {
  const rate = cached.hitRate === null ? '' : ` ${Math.round(cached.hitRate * 100)}%`
  const label = <Text dimColor>{'  '}cache{rate} </Text>
  if (left <= 0) return <Text>{label}<Text color="red">expired</Text></Text>
  if (left < 5 * 60_000) return <Text>{label}<Text color="yellow">{countdown(left)}</Text></Text>
  return <Text>{label}<Text dimColor>{countdown(left)}</Text></Text>
}

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Cache, Reading, Warm } from '../types'

const MAX_TURNS = 12
const BARS = '▁▂▃▄▅▆▇█'

const history = atom({ plugin: 'omni-token', key: 'history' } as const, [])
// Output tokens per second of the last turn, timed from each request's start.
const speed = atom({ plugin: 'omni-token', key: 'speed' } as const, null)
// Last turn's cache hit rate and when the last main-loop request touched the cache.
const cache = atom({ plugin: 'omni-token', key: 'cache' } as const, null)
// Wall clock, ticked every second so the cache countdown redraws.
const clock = atom({ plugin: 'omni-token', key: 'now' } as const, 0)
const warm = atom({ plugin: 'omni-token', key: 'warm' } as const, { count: 0, missed: false })
const warmOverride = atom({ plugin: 'omni-token', key: 'warmOverride' } as const, null)

// Below this a cold restart is cheap, so warming isn't worth it.
const MIN_WARM_TOKENS = 50_000
const WARM_PROMPT = 'Cache keep-alive. Reply with exactly: ok'

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

// One forked request over the main thread's prefix: a cache read restarts its TTL.
async function warmCache($: EngineInterface, startedAt: number) {
  const r = await $.model.fork({ prompt: WARM_PROMPT })
  if (!('usage' in r)) return
  const hit = r.usage.cache_read_input_tokens > 0
  await update($, warm, w => ({ count: w.count + 1, missed: !hit }))
  if (hit) await update($, cache, c => (c ? { ...c, lastRequestAt: startedAt } : c))
}

type WarmConfig = { autoWarm: boolean; ttlMs: number; marginMs: number; warmMs: number }

// What the hooks know of the main loop right now; starts over on a reload.
const live = { isBusy: false, isWarming: false, lastTurnAt: 0 }

async function maybeWarm($: EngineInterface, cfg: WarmConfig) {
  if (live.isBusy || live.isWarming || live.lastTurnAt === 0) return
  if (!((await read($, warmOverride)) ?? cfg.autoWarm)) return
  const now = await $.clock.now()
  if (now - live.lastTurnAt > cfg.warmMs) return
  const [cached, readings, w] = [await read($, cache), await read($, history), await read($, warm)]
  if (cached === null || w.missed) return
  const left = cached.lastRequestAt + cfg.ttlMs - now
  // Already expired: a warm would pay a full write, the very cost it exists to avoid.
  if (left <= 0 || left > cfg.marginMs) return
  const tokens = readings[readings.length - 1]?.tokens ?? 0
  if (tokens < MIN_WARM_TOKENS) return
  live.isWarming = true
  try {
    await warmCache($, now)
  } finally {
    live.isWarming = false
  }
}

async function runCommand($: EngineInterface, cfg: WarmConfig, args: string) {
  const [verb, value] = args.trim().toLowerCase().split(/\s+/)
  if (verb === 'warm' && (value === 'on' || value === 'off')) {
    await update($, warmOverride, () => value === 'on')
    return value === 'on'
      ? 'Auto-warm on for this session.'
      : 'Auto-warm off for this session. Other sessions and the autoWarm option are unchanged.'
  }
  if (verb === 'warm' && value === 'reset') {
    await update($, warmOverride, () => null)
    return `Auto-warm follows the autoWarm option again (${cfg.autoWarm ? 'on' : 'off'}).`
  }
  if (verb !== undefined && verb !== '' && verb !== 'status') {
    return 'Usage: /omni-token [status] | /omni-token warm on|off|reset'
  }

  const override = await read($, warmOverride)
  const isOn = override ?? cfg.autoWarm
  const cached = await read($, cache)
  const w = await read($, warm)
  const now = await $.clock.now()
  const left = cached === null ? null : cached.lastRequestAt + cfg.ttlMs - now
  const lines = [
    `auto-warm: ${isOn ? 'on' : 'off'} (${override === null ? 'from the autoWarm option' : 'set for this session'})`,
    `cache TTL: ${cfg.ttlMs === 5 * 60_000 ? '5m' : '1h'}, expires in ${left === null ? 'n/a' : left <= 0 ? 'expired' : countdown(left)}`,
    `keep warm for: ${cfg.warmMs / 3_600_000}h after the last turn`,
    `warms since the last turn: ${w.count}${w.missed ? ' (last one found the cache cold; stopped)' : ''}`,
  ]
  if (isOn && live.lastTurnAt === 0) lines.push('Warming starts after your next message.')
  lines.push('Options: cacheTtl, autoWarm, warmHours (claude plugin configure omni-token@claude-code-mods)')
  return lines.join('\n')
}

async function measure($: EngineInterface) {
  const { context } = await $.session.usage()
  if (context.tokens === undefined) return
  const reading: Reading = { tokens: context.tokens, window: context.window }
  await update($, history, h => [...h, reading].slice(-MAX_TURNS))
}

export const register: Register = (on, options) => {
  const ttlMs = options.cacheTtl === '5m' ? 5 * 60_000 : 60 * 60_000
  // Warm this long before expiry: room for the request to reach the API.
  const marginMs = options.cacheTtl === '5m' ? 60_000 : 3 * 60_000
  const cfg: WarmConfig = {
    autoWarm: options.autoWarm === true,
    ttlMs,
    marginMs,
    warmMs: (typeof options.warmHours === 'number' ? options.warmHours : 24) * 3_600_000,
  }

  // Per main-loop turn: output tokens and milliseconds from request to response end.
  let streamed = { turnId: '', tokens: 0, ms: 0 }

  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined || !live.isBusy) return yield* next(e)
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

  on('turn.start', async ($, e, next) => {
    live.isBusy = true
    live.lastTurnAt = await $.clock.now()
    await update($, warm, () => ({ count: 0, missed: false }))
    return next(e)
  })

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await $.command.register({
      name: 'omni-token',
      description: 'Show omni-token status; "warm on|off|reset" toggles cache auto-warm for this session',
    })
    const tick = async () => {
      const t = await $.clock.now()
      await update($, clock, () => t)
    }
    await tick()
    $.clock.every(1000, () => void tick().then(() => maybeWarm($, cfg)))
    // Seed one reading on a fresh load (or a hot reload mid-session).
    if ((await read($, history)).length === 0) await measure($)
    return result
  })

  on('command.run', { command: 'omni-token' }, async ($, e) => ({ text: await runCommand($, cfg, e.args) }))

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result
    live.isBusy = false
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
    const warmed = await read($, warm)
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
        {warmed.missed ? (
          <Text color="red">{'  '}warm missed</Text>
        ) : warmed.count > 0 ? (
          <Text dimColor>{'  '}warmed {warmed.count}x</Text>
        ) : null}
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

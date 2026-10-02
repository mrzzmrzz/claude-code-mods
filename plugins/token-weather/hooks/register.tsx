import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Reading } from '../types'

const MAX_TURNS = 12
const BARS = '▁▂▃▄▅▆▇█'

const history = atom({ plugin: 'token-weather', key: 'history' } as const, [])
// Output tokens per second of the last turn, timed from each request's start.
const speed = atom({ plugin: 'token-weather', key: 'speed' } as const, null)

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

async function measure($: EngineInterface) {
  const { context } = await $.session.usage()
  if (context.tokens === undefined) return
  const reading: Reading = { tokens: context.tokens, window: context.window }
  await update($, history, h => [...h, reading].slice(-MAX_TURNS))
}

export const register: Register = on => {
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
    }
    return result
  })

  on('session.start', async ($, e, next) => {
    const result = await next(e)
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
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const readings = await read($, history)
    const tps = await read($, speed)
    if (e.props.hasSurvey || readings.length === 0) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const now = readings[readings.length - 1]
    const percent = Math.round((now.tokens / now.window) * 100)
    const sky = forecast(percent)
    const prev = readings.length > 1 ? readings[readings.length - 2] : null
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
      </Box>
    )
  })
}

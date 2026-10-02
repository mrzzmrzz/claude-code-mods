import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { CommandRunInput, On, TurnUsage } from 'claude-code'

const MIN = 60_000
const usage: TurnUsage = {
  model: 'claude-opus-5-5',
  input_tokens: 10,
  output_tokens: 100,
  cache_read_input_tokens: 190_000,
  cache_creation_input_tokens: 10_000,
}
const status: CommandRunInput = {
  command: 'omni-token',
  args: '',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 120 },
}

// The engine beneath the plugin: one 200k-token context, every fork a cache hit unless told otherwise.
function engine(on: On, fork: { count: number; hit: boolean }) {
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 200_000, window: 1_000_000, percent: 20 }, rateLimits: [] } }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.step', async function* (_$, e) {
    return { turnId: e.turnId, index: e.index, answer: 'hi', toolUses: [], stopReason: 'end_turn' as const, usage }
  })
  on('turn.complete', () => ({ text: '' }))
  on('model.fork', () => {
    fork.count += 1
    return {
      value: {
        isAnswered: true as const,
        text: 'ok',
        usage: { input_tokens: 20, output_tokens: 5, cache_read_input_tokens: fork.hit ? 200_000 : 0, cache_creation_input_tokens: fork.hit ? 0 : 200_000 },
      },
    }
  })
}

async function oneTurn($: Engine) {
  await $.turn.start({ text: 'hi', turnId: 't1' })
  for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 })) {
  }
  await $.turn.complete({ answer: 'hi', durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer', usage })
}

const start = { cwd: '/tmp', surface: 'terminal' as const, isInteractive: true }

test('warms 3 minutes before expiry, then on each renewed TTL', { options: { autoWarm: true } }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const fork = { count: 0, hit: true }
  engine(on, fork)
  await $.session.start(start)
  await oneTurn($)

  await clock.advance(56 * MIN)
  expect(fork.count).toBe(0)
  await clock.advance(2 * MIN) // 58 min: under 3 left
  expect(fork.count).toBe(1)
  expect((await $.command.run(status)).text).toContain('warms since the last turn: 1')

  await clock.advance(57 * MIN + 30_000) // renewed from the warm's start
  expect(fork.count).toBe(2)
})

test('stops warmHours after the last turn', { options: { autoWarm: true, warmHours: 2 } }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const fork = { count: 0, hit: true }
  engine(on, fork)
  await $.session.start(start)
  await oneTurn($)
  for (let i = 0; i < 6 * 60; i++) await clock.advance(MIN)
  expect(fork.count).toBe(2)
})

test('a cold warm stops warming until the next turn', { options: { autoWarm: true } }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const fork = { count: 0, hit: false }
  engine(on, fork)
  await $.session.start(start)
  await oneTurn($)
  for (let i = 0; i < 3 * 60; i++) await clock.advance(MIN)
  expect(fork.count).toBe(1)
  expect((await $.command.run(status)).text).toContain('found the cache cold')
})

test('warm off stops it for the session', { options: { autoWarm: true } }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const fork = { count: 0, hit: true }
  engine(on, fork)
  await $.session.start(start)
  await oneTurn($)
  await $.command.run({ ...status, args: 'warm off' })
  for (let i = 0; i < 3 * 60; i++) await clock.advance(MIN)
  expect(fork.count).toBe(0)
})

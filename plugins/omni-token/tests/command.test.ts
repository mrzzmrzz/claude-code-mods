import { expect, mock, test } from 'claude-code/testing'
import type { CommandRunInput } from 'claude-code'

const run = (args: string): CommandRunInput => ({
  command: 'omni-token',
  args,
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 120 },
})

test('warm off and reset toggle auto-warm for the session', { options: { autoWarm: true } }, async ($, on) => {
  mock.clock(on)
  expect((await $.command.run(run(''))).text).toContain('auto-warm: on (from the autoWarm option)')

  expect((await $.command.run(run('warm off'))).text).toContain('Auto-warm off for this session')
  expect((await $.command.run(run('status'))).text).toContain('auto-warm: off (set for this session)')

  expect((await $.command.run(run('warm reset'))).text).toContain('follows the autoWarm option again (on)')
  expect((await $.command.run(run(''))).text).toContain('auto-warm: on (from the autoWarm option)')
})

test('warm on overrides an off option', async ($, on) => {
  mock.clock(on)
  await $.command.run(run('warm on'))
  expect((await $.command.run(run(''))).text).toContain('auto-warm: on (set for this session)')
})

test('unknown args print usage', async ($, on) => {
  mock.clock(on)
  expect((await $.command.run(run('warm maybe'))).text).toContain('Usage: /omni-token')
})

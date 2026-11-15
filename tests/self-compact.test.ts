import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const TURN = { answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1' } as const

function world(on: On, tokens: number, isHeadless = false) {
  const seen = { compacted: [] as (string | undefined)[], submitted: [] as string[], commands: [] as string[] }
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('tool.register', (_$, e) => ({ value: { tool: `mcp__self-compact__${e.name}` } }))
  on('ui.status', () => ({ value: undefined }) as never)
  on('ui.toast', () => ({ value: undefined }) as never)
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { tokens, window: 1_000_000, percent: tokens / 10_000, breakdown: { autoCompactThreshold: 300_000 } },
      rateLimits: [],
    },
  }) as never)
  on('session.compact', (_$, e) => {
    if (isHeadless) return { deny: 'not available in a headless (-p / SDK) session yet: compaction here runs inside a turn (a /compact prompt)' } as never
    seen.compacted.push(e.instructions)
    return { messages: [{ role: 'user', text: 'summary', toolUses: [] }] as never, tokensBefore: 250_000, tokensAfter: 30_000 }
  })
  on('prompt.submit', (_$, e) => {
    seen.submitted.push(e.text)
    return { text: e.text }
  })
  on('command.run', (_$, e) => {
    seen.commands.push(`/${e.command} ${e.args}`)
    return { text: 'Compacted.' }
  })
  on('tool.call', () => ({ result: 'tool output' }))
  return seen
}

test('compact waits for the turn to end, then compacts and resumes with the note', async ($, on) => {
  const clock = mock.clock(on)
  const seen = world(on, 120_000)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

  const queued = await $.tool.call({ tool: 'mcp__self-compact__compact', keep: 'decision A', resume: 'run step 3' })
  expect(queued.deny).toBeUndefined()
  expect(seen.compacted).toEqual([])

  await $.turn.complete({ ...TURN, reason: 'answer' })
  await clock.advance(1000)
  expect(seen.compacted.length).toBe(1)
  expect(seen.compacted[0]).toContain('decision A')
  expect(seen.submitted.length).toBe(1)
  expect(seen.submitted[0]).toContain('run step 3')
  expect(seen.submitted[0]).toContain('250k -> 30k')
})

test('an interrupted turn drops the queued compaction', async ($, on) => {
  const clock = mock.clock(on)
  const seen = world(on, 120_000)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'mcp__self-compact__compact', resume: 'run step 3' })
  await $.turn.complete({ ...TURN, isAborted: true, reason: 'aborted' })
  await clock.advance(5000)
  expect(seen.compacted).toEqual([])
  expect(seen.submitted).toEqual([])
})

test('a subagent cannot compact', async ($, on) => {
  world(on, 120_000)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const denied = await $.tool.call({ tool: 'mcp__self-compact__compact', resume: 'x', agentId: 'a1' } as never)
  expect(denied.deny ?? denied.text).toContain('Only the main session')
})

test('context_usage reports against the auto-compact point', async ($, on) => {
  world(on, 150_000)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const usage = await $.tool.call({ tool: 'mcp__self-compact__context_usage' })
  expect(String(usage.result)).toContain('150k tokens in use, 50% of the 300k auto-compact point')
})

test('crossing 50% of the auto-compact point adds one reminder, not one per call', async ($, on) => {
  world(on, 160_000)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const first = await $.tool.call({ tool: 'Read', file_path: '/repo/a.ts' })
  const second = await $.tool.call({ tool: 'Read', file_path: '/repo/b.ts' })
  expect(first.context?.join(' ')).toContain('53% of the 300k auto-compact point')
  expect(second.context).toBeUndefined()
})

test('in an SDK host (the desktop app) it runs /compact as a command, then resumes once', async ($, on) => {
  const clock = mock.clock(on)
  const seen = world(on, 120_000, true)
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
  await $.tool.call({ tool: 'mcp__self-compact__compact', keep: 'decision A', resume: 'run step 3' })
  await $.turn.complete({ ...TURN, reason: 'answer' })
  await clock.advance(1000)
  expect(seen.compacted).toEqual([])
  expect(seen.commands.length).toBe(1)
  expect(seen.commands[0]).toContain('/compact ')
  expect(seen.commands[0]).toContain('decision A')
  expect(seen.submitted.length).toBe(1)
  expect(seen.submitted[0]).toContain('run step 3')

  // The /compact and resume turns ending must not queue another compaction.
  await $.turn.complete({ ...TURN, reason: 'answer' })
  await clock.advance(10_000)
  expect(seen.commands.length).toBe(1)
  expect(seen.submitted.length).toBe(1)
})

import { expect, mock, test, type TestBody } from 'claude-code/testing'
import type { On } from 'claude-code'

const TURN = { answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1' } as const

type Row = { role: 'user' | 'assistant'; text: string; toolUses: never[] }
type World = {
  compacted: (string | undefined)[]
  submitted: string[]
  commands: string[]
  rows: Row[]
  tokens: number | undefined
  commandText?: string
  isRowDropped: boolean
  release?: () => void
}

// Stands for the engine. In an SDK host /compact runs as a command: the world's command.run waits
// until the test runs the compaction through the `session.compact` chain (`runCompact`), as the engine
// does inside the command; the rows that chain returns become the conversation.
function world(on: On, tokens: number, isHeadless = false) {
  const seen: World = { compacted: [], submitted: [], commands: [], rows: [], tokens, isRowDropped: false }
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('tool.register', (_$, e) => ({ value: { tool: `mcp__self-compact__${e.name}` } }))
  on('ui.status', () => ({ value: undefined }) as never)
  on('ui.toast', () => ({ value: undefined }) as never)
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: {
        tokens: seen.tokens,
        window: 1_000_000,
        percent: (seen.tokens ?? 0) / 10_000,
        breakdown: { autoCompactThreshold: 300_000 },
      },
      rateLimits: [],
    },
  }) as never)
  on('session.messages', () => ({ value: seen.isRowDropped ? seen.rows.slice(0, 1) : seen.rows }) as never)
  on('session.compact', (_$, e) => {
    if (isHeadless && e.trigger === 'plugin' && !seen.commands.length) {
      return { deny: 'not available in a headless (-p / SDK) session yet: compaction here runs inside a turn (a /compact prompt)' } as never
    }
    seen.compacted.push(e.instructions)
    return { messages: [{ role: 'user', text: 'summary', toolUses: [] }] as never, tokensBefore: 250_000, tokensAfter: 30_000 }
  })
  on('prompt.submit', (_$, e) => {
    seen.submitted.push(e.text)
    return { text: e.text }
  })
  on('command.run', async (_$, e) => {
    seen.commands.push(`/${e.command} ${e.args}`)
    if (seen.commandText !== undefined) return { text: seen.commandText }
    await new Promise<void>(resolve => (seen.release = resolve))
    return {}
  })
  on('tool.call', () => ({ result: 'tool output' }))
  return seen
}

type Engine = Parameters<TestBody>[0]
type Clock = ReturnType<typeof mock.clock>

// The 250 ms wait, then the compaction /compact runs, then the command's end.
async function runCompact($: Engine, clock: Clock, seen: World) {
  await clock.advance(300)
  const args = seen.commands.at(-1)?.replace(/^\/compact /, '')
  const done = await $.session.compact({ instructions: args, messages: [{ role: 'user', text: 'old turn', toolUses: [] }] } as never)
  if (done.messages) seen.rows = done.messages.map(m => ({ role: m.role, text: m.text, toolUses: [] as never[] }))
  seen.release?.()
  await clock.advance(10)
}

test('compact waits for the turn to end, then compacts and resumes with the note', async ($, on) => {
  const clock = mock.clock(on)
  const seen = world(on, 120_000)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

  const queued = await $.tool.call({ tool: 'mcp__self-compact__compact', keep: 'decision A', resume: 'run step 3' })
  expect(queued.deny).toBeUndefined()
  expect(seen.compacted).toEqual([])

  await $.turn.complete({ ...TURN, reason: 'answer' })
  await clock.advance(5000)
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

test('a reminder fires once per step, not once per call', async ($, on) => {
  const seen = world(on, 60_000)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Read', file_path: '/repo/a.ts' }) // floor: 60k
  seen.tokens = 240_000 // 75% of the room above the floor
  const first = await $.tool.call({ tool: 'Read', file_path: '/repo/b.ts' })
  const second = await $.tool.call({ tool: 'Read', file_path: '/repo/c.ts' })
  expect(first.context?.join(' ')).toContain('80% of the 300k auto-compact point')
  expect(first.context?.join(' ')).toContain('free about 180k')
  expect(second.context).toBeUndefined()
})

test('in an SDK host (the desktop app) it runs /compact as a command, then resumes once', async ($, on) => {
  const clock = mock.clock(on)
  const seen = world(on, 120_000, true)
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
  await $.tool.call({ tool: 'mcp__self-compact__compact', keep: 'decision A', resume: 'run step 3' })
  await $.turn.complete({ ...TURN, reason: 'answer' })
  await runCompact($, clock, seen)
  await clock.advance(5000)
  expect(seen.compacted.length).toBe(1)
  expect(seen.commands.length).toBe(1)
  expect(seen.commands[0]).toContain('/compact ')
  expect(seen.commands[0]).toContain('decision A')
  expect(seen.submitted.length).toBe(1)

  // The /compact and resume turns ending must not queue another compaction.
  await $.turn.complete({ ...TURN, reason: 'answer' })
  await clock.advance(10_000)
  expect(seen.commands.length).toBe(1)
  expect(seen.submitted.length).toBe(1)
})

// Fault A (2026-10-17, 2026-11-15): the resume prompt queued behind side-session notes and arrived
// minutes later as a second, older copy of an instruction the session had already acted on.

test('the resume note stands right after the summary, verbatim and time-stamped', async ($, on) => {
  const clock = mock.clock(on)
  const seen = world(on, 120_000, true)
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
  await $.tool.call({ tool: 'mcp__self-compact__compact', resume: 'run step 3' })
  await $.turn.complete({ ...TURN, reason: 'answer' })
  await runCompact($, clock, seen)
  expect(seen.rows.length).toBe(2)
  expect(seen.rows[0]?.text).toBe('summary')
  expect(seen.rows[1]?.text).toContain('[self-compact] Resume note you wrote at')
  expect(seen.rows[1]?.text).toContain('UTC')
  expect(seen.rows[1]?.text).toContain('run step 3')
})

test('with nothing else queued, a short kick follows that points at the note instead of repeating it', async ($, on) => {
  const clock = mock.clock(on)
  const seen = world(on, 120_000, true)
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
  await $.tool.call({ tool: 'mcp__self-compact__compact', resume: 'run step 3' })
  await $.turn.complete({ ...TURN, reason: 'answer' })
  await runCompact($, clock, seen)
  expect(seen.submitted).toEqual([]) // still settling
  await clock.advance(5000)
  expect(seen.submitted.length).toBe(1)
  expect(seen.submitted[0]).toContain('Your resume note is the message just before this one')
  expect(seen.submitted[0]).not.toContain('run step 3')
})

test('a side-session note that starts a turn first takes the place of the kick: no late second copy', async ($, on) => {
  const clock = mock.clock(on)
  const seen = world(on, 120_000, true)
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
  await $.tool.call({ tool: 'mcp__self-compact__compact', resume: 'run step 3' })
  await $.turn.complete({ ...TURN, reason: 'answer' })
  await runCompact($, clock, seen)
  // the note queued meanwhile starts its turn
  await $.turn.start({ text: 'The session "x" you started finished a turn.', turnId: 't2' })
  await $.turn.complete({ ...TURN, turnId: 't2', reason: 'answer' })
  await clock.advance(30 * 60 * 1000)
  expect(seen.rows[1]?.text).toContain('run step 3')
  expect(seen.submitted).toEqual([])
})

test('if the note could not be placed after the summary, the kick carries it in full', async ($, on) => {
  const clock = mock.clock(on)
  const seen = world(on, 120_000, true)
  seen.isRowDropped = true // the conversation shows the summary alone, as if the engine had not kept the row
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
  await $.tool.call({ tool: 'mcp__self-compact__compact', resume: 'run step 3' })
  await $.turn.complete({ ...TURN, reason: 'answer' })
  await runCompact($, clock, seen)
  await clock.advance(5000)
  expect(seen.submitted.length).toBe(1)
  expect(seen.submitted[0]).toContain('run step 3')
})

test('a second compact call while one is in flight is refused, so /compact never runs twice', async ($, on) => {
  const clock = mock.clock(on)
  const seen = world(on, 120_000, true)
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
  await $.tool.call({ tool: 'mcp__self-compact__compact', resume: 'run step 3' })
  await $.turn.complete({ ...TURN, reason: 'answer' })
  await runCompact($, clock, seen)
  // settling
  const again = await $.tool.call({ tool: 'mcp__self-compact__compact', resume: 'run step 3' })
  expect(again.deny ?? again.text).toContain('still')
  await $.turn.complete({ ...TURN, reason: 'answer' })
  await clock.advance(10_000)
  expect(seen.commands.length).toBe(1)
})

test('a /compact that prints an error is reported as failed, never as compacted', async ($, on) => {
  const clock = mock.clock(on)
  const seen = world(on, 120_000, true)
  seen.commandText = 'Error during compaction: summarization produced empty response'
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
  await $.tool.call({ tool: 'mcp__self-compact__compact', resume: 'run step 3' })
  await $.turn.complete({ ...TURN, reason: 'answer' })
  await clock.advance(5000)
  expect(seen.submitted.length).toBe(1)
  expect(seen.submitted[0]).toContain('did not run')
  expect(seen.submitted[0]).not.toContain('Context compacted')
})

// Fault B ("fires too easily"): after a compaction the context comes back to a floor near 115k (system
// prompt, tools, summary, re-read files), 43% of the 267k point, so the old 50% reminder fired within a
// minute of every compaction.

test('no reminder right after a compaction, though the floor is near half the auto-compact point', async ($, on) => {
  const clock = mock.clock(on)
  const seen = world(on, 230_000, true)
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
  await $.tool.call({ tool: 'mcp__self-compact__compact', resume: 'run step 3' })
  await $.turn.complete({ ...TURN, reason: 'answer' })
  await runCompact($, clock, seen)
  await clock.advance(5000)
  seen.tokens = 115_000 // the first reading after the compaction: the floor
  const first = await $.tool.call({ tool: 'Read', file_path: '/repo/a.ts' })
  seen.tokens = 160_000 // 53% of the point, only 24% of the room above the floor
  const second = await $.tool.call({ tool: 'Read', file_path: '/repo/b.ts' })
  expect(first.context).toBeUndefined()
  expect(second.context).toBeUndefined()
  seen.tokens = 250_000 // 73% of the room
  const third = await $.tool.call({ tool: 'Read', file_path: '/repo/c.ts' })
  expect(third.context?.join(' ')).toContain('free about 135k')
  seen.tokens = 285_000 // 92% of the room: the last reminder
  const fourth = await $.tool.call({ tool: 'Read', file_path: '/repo/d.ts' })
  expect(fourth.context?.join(' ')).toContain('Auto-compaction is close')
})

test('an automatic compaction also resets the floor and the reminders', async ($, on) => {
  const seen = world(on, 60_000)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Read', file_path: '/repo/a.ts' })
  seen.tokens = 250_000
  const before = await $.tool.call({ tool: 'Read', file_path: '/repo/b.ts' })
  expect(before.context?.join(' ')).toContain('auto-compact point')
  await $.session.compact({ messages: [{ role: 'user', text: 'old turn', toolUses: [] }] } as never) // stands for the engine's own compaction
  seen.tokens = 120_000
  await $.tool.call({ tool: 'Read', file_path: '/repo/c.ts' }) // the new floor
  seen.tokens = 260_000 // 78% of the new room
  const after = await $.tool.call({ tool: 'Read', file_path: '/repo/d.ts' })
  expect(after.context?.join(' ')).toContain('free about 140k')
})

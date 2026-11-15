import type { EngineInterface, Register } from 'claude-code'

// Self-compaction for the main session. The model calls `compact` with what the summary must keep and a
// note to resume from; the compaction runs once its turn ends (the engine refuses one mid-turn).
// The note is then put into the compacted conversation itself, verbatim and time-stamped, so whichever
// turn comes first (a short kick from this mod, a side-session note, a task notification, a user message)
// reads it right after the summary. The kick is sent only when no other turn started first, so a note
// never arrives late as a second, older copy.
// `context_usage` and two reminders let the model judge when to compact; the reminders are measured on
// the room above the post-compaction floor (system prompt, tools, summary, re-read files), not on the
// raw fill, because a compaction comes back to that floor and never to zero.

const COMPACT = 'mcp__self-compact__compact'
const USAGE = 'mcp__self-compact__context_usage'
// Reminders at these shares of the room between the floor and the auto-compact point.
const NUDGE_AT = [0.7, 0.9]
// The floor is capped at this share of the auto-compact point, so a high first reading (a resumed
// session, a mod reload) still leaves the reminders some room.
const FLOOR_CAP = 0.6
// After /compact: how long to wait for another queued turn before sending the kick.
const SETTLE_MS = 3000
// A compaction still in flight after this long is treated as lost.
const STALE_MS = 15 * 60 * 1000
const RETRY_MS = 2000
const RETRIES = 90
const MARK = 'The agent asked for this compaction itself'
const NOTE_MARK = '[self-compact] Resume note you wrote at'
const FAILED = /error during compaction|compaction failed|failed to compact|not enough messages/i

type Job = { keep: string; resume: string; writtenAt: number }
type Active = {
  job: Job
  phase: 'compacting' | 'settling'
  startedAt: number
  compactedAt?: number
  isNoteEmbedded: boolean
  isCompacted: boolean
  failure?: string
  isOvertaken: boolean
}

// The module's own state; a reload starts it over, which at worst drops one queued compaction.
const state: {
  job?: Job
  active?: Active
  isWaiting: boolean
  threshold?: number
  floor?: number
  nudged: number
  isSdkHost: boolean
} = {
  isWaiting: false,
  nudged: 0,
  isSdkHost: false,
}

const COMPACT_DESCRIPTION = [
  "Compact this session's context now instead of waiting for auto-compaction.",
  'Use it at a phase boundary: planning settled and implementation starts, a milestone landed, a long',
  'debugging trail resolved, or most of the context is tool output you no longer need. Not mid-edit, and',
  'not while something you still need exists only in recent tool output.',
  'Before calling, write what the next phase needs (plan, decisions, verified vs assumed, next step) to the',
  "project's handoff or plan file: the summary is lossy.",
  'It runs when your turn ends, so after calling make no more tool calls and end the turn with one short',
  'line. Your `resume` note is then placed, verbatim, right after the summary, and the session carries on',
  'from it by itself. Main session only; one compaction at a time.',
].join(' ')

const k = (n: number) => `${Math.round(n / 1000)}k`
const hhmm = (ms: number) => `${new Date(ms).toISOString().slice(11, 16)} UTC`
const traceLines: string[] = []
const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '')

let traceFile: string | undefined

// Each step of a compaction, in trace-<session id>.log beside the mod (one file per session, so sessions
// compacting at once keep their own record): the desktop shows a mod's errors nowhere.
async function trace($: EngineInterface, line: string) {
  try {
    traceLines.push(`${new Date(await $.clock.now()).toISOString()} ${line}`)
    if (traceLines.length > 200) traceLines.splice(0, traceLines.length - 200)
    traceFile ??= `${$.plugin.root}/trace-${await $.session.id()}.log`
    await $.fs.write(traceFile, traceLines.join('\n') + '\n')
  } catch {
    // tracing never breaks the mod
  }
}

async function fill($: EngineInterface) {
  const { context } = await $.session.usage()
  if (state.threshold === undefined) {
    try {
      state.threshold = (await $.session.usage({ breakdown: 'summary' })).context.breakdown?.autoCompactThreshold
    } catch {
      state.threshold = undefined
    }
  }
  const limit = state.threshold ?? context.window
  const tokens = context.tokens
  // The first reading after a session start or a compaction is the floor a compaction comes back to.
  if (tokens !== undefined && (state.floor === undefined || tokens < state.floor)) state.floor = tokens
  const floor = Math.min(state.floor ?? 0, limit * FLOOR_CAP)
  return { tokens, window: context.window, limit, floor }
}

// What the summarizer is told. The note also stays here, so the summary still carries it if the engine
// does not route this compaction through the `session.compact` hook below.
const instructionsFor = (job: Job) =>
  `${MARK}, at a point it chose.` +
  (job.keep ? ` Keep in full: ${job.keep}` : '') +
  ` Its next step afterwards, in its own words (also placed verbatim right after this summary): ${job.resume}`

const noteText = (a: Active, now: number) =>
  `${NOTE_MARK} ${hhmm(a.job.writtenAt)}, just before this compaction (finished ${hhmm(now)}). ` +
  'Carry on from it in your next turn; nobody needs to confirm it. If that turn starts with something ' +
  'else (a session note, a task notification, a user message), deal with that first, then carry on from ' +
  'this note unless the conversation shows it is already done. Stop only where the note itself says to.' +
  `\n\n${a.job.resume}`

const kickText = (a: Active, size: string) =>
  a.isNoteEmbedded
    ? `[self-compact] Context compacted at your request at ${hhmm(a.compactedAt ?? a.startedAt)}${size}. ` +
      'Your resume note is the message just before this one: pick the work up from it now; nobody needs ' +
      'to confirm it. If an earlier turn already acted on it, carry on from where that turn left off.'
    : `[self-compact] Context compacted at your request at ${hhmm(a.compactedAt ?? a.startedAt)}${size}. ` +
      `Pick the work up now from your resume note below (written ${hhmm(a.job.writtenAt)}); nobody needs to ` +
      `confirm it. Stop only where the note itself says to.\n\n${a.job.resume}`

const failText = (a: Active, why: string) =>
  `[self-compact] The compaction you asked for did not run (${why.slice(0, 200)}). Your context is as it ` +
  'was. Do not call compact again right away; carry on from your note now:\n\n' +
  a.job.resume

// After a compaction that stood: wait briefly for a queued turn (a side-session note, a task
// notification, a typed prompt). If one starts, it reads the note after the summary and no kick is sent;
// if none does, the kick starts the next turn.
async function settle($: EngineInterface, a: Active, size: string): Promise<void> {
  a.phase = 'settling'
  a.compactedAt ??= await $.clock.now()
  state.nudged = 0
  state.floor = undefined
  if (a.isNoteEmbedded) {
    // Check the note really stands in the conversation; if not, the kick carries it in full.
    try {
      const rows = await $.session.messages()
      a.isNoteEmbedded = rows.slice(-12).some(m => m.role === 'user' && m.text.includes(NOTE_MARK))
    } catch {
      // no reading: trust the hook
    }
  }
  $.clock.after(SETTLE_MS, () => void kick($, a, size))
  await trace($, `resume: note ${a.isNoteEmbedded ? 'embedded after the summary' : 'NOT embedded'}; kick in ${SETTLE_MS} ms unless another turn starts`)
}

async function kick($: EngineInterface, a: Active, size: string): Promise<void> {
  if (state.active !== a) return
  state.active = undefined
  if (a.isOvertaken) {
    await trace($, 'resume: kick not sent, another turn started first and reads the note')
    return
  }
  const sentAt = await $.clock.now()
  const submitted = await $.prompt.submit({ text: kickText(a, size), asUser: true })
  const waited = (await $.clock.now()) - sentAt
  await trace(
    $,
    `resume: kick submitted, ${submitted.drop !== undefined ? `dropped: ${submitted.drop}` : 'entered'}${waited > 5000 ? ` after ${Math.round(waited / 1000)} s` : ''}`,
  )
}

async function fail($: EngineInterface, a: Active, why: string): Promise<void> {
  if (state.active === a) state.active = undefined
  $.ui.status(undefined)
  await trace($, `compact: failed: ${why.slice(0, 200)}`)
  await $.prompt.submit({ text: failText(a, why), asUser: true })
}

// SDK hosts (the desktop app, -p) refuse $.session.compact: there compaction runs inside a turn, as
// a /compact prompt. Run /compact as a command; the `session.compact` hook below embeds the note.
async function compactAsCommand($: EngineInterface, a: Active): Promise<void> {
  const instructions = instructionsFor(a.job)
  $.ui.status(undefined)
  // (A `/compact` prompt is no fallback: the host refuses a plugin prompt that starts with a slash.)
  let ranText: string | undefined
  try {
    const ran = await $.command.run({ command: 'compact', args: instructions })
    ranText = ran.text
    await trace($, `compact: /compact ran via command.run: ${(ran.text ?? '(no text)').slice(0, 200)}`)
  } catch (err) {
    a.failure ??= `the /compact command could not run: ${String(err).slice(0, 200)}`
    await trace($, `compact: command.run rejected: ${String(err).slice(0, 300)}`)
  }
  if (state.active !== a) return
  // The hook saw the compaction fail, or the command printed an error.
  let why = a.failure
  if (why === undefined && !a.isCompacted && ranText !== undefined && FAILED.test(ranText)) why = ranText
  if (why !== undefined) return fail($, a, why)
  await settle($, a, '')
}

async function finish($: EngineInterface, a: Active, tries: number): Promise<void> {
  state.isWaiting = false
  if (state.isSdkHost) {
    await compactAsCommand($, a)
    return
  }
  let compacted
  try {
    await trace($, `compact: attempt ${tries + 1}`)
    compacted = await $.session.compact({ instructions: instructionsFor(a.job) })
  } catch (err) {
    await trace($, `compact: rejected: ${String(err).slice(0, 300)}`)
    if (/headless|SDK/.test(String(err))) {
      a.failure = undefined
      await compactAsCommand($, a)
      return
    }
    // Rejected while a turn runs (a prompt typed meanwhile): try again once the session is idle.
    if (tries >= RETRIES) {
      if (state.active === a) state.active = undefined
      $.ui.toast('self-compact: gave up, the session never went idle')
      return
    }
    state.isWaiting = true
    $.clock.after(RETRY_MS, () => void finish($, a, tries + 1))
    return
  }
  $.ui.status(undefined)
  await trace($, `compact: done${compacted.skip !== undefined ? `, skipped: ${compacted.skip}` : ''}`)
  if (compacted.skip !== undefined) return fail($, a, compacted.skip)
  const size =
    compacted.tokensBefore && compacted.tokensAfter ? ` (${k(compacted.tokensBefore)} -> ${k(compacted.tokensAfter)} tokens)` : ''
  await settle($, a, size)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    state.isSdkHost = !e.isInteractive
    await $.tool.register({
      name: 'compact',
      description: COMPACT_DESCRIPTION,
      isDeferred: false,
      inputSchema: {
        type: 'object',
        properties: {
          keep: {
            type: 'string',
            description:
              'What the summary must preserve in detail: decisions and why, file paths, the current step, open questions, verified vs assumed.',
          },
          resume: {
            type: 'string',
            description:
              'The prompt the session resumes with after compacting, written to yourself: what to do next and which files to re-read first.',
          },
        },
        required: ['resume'],
      },
    })
    await $.tool.register({
      name: 'context_usage',
      description:
        "Report this session's context fill: tokens in use, the auto-compact point and the model's window. Free; check it before deciding whether to compact.",
      isDeferred: false,
      inputSchema: { type: 'object', properties: {} },
    })
    return next(e)
  })

  on('tool.call', { tool: COMPACT }, async ($, e) => {
    if (e.agentId !== undefined) {
      return { deny: 'Only the main session can compact itself. Finish your task and report back.' }
    }
    const args = e as unknown as Record<string, unknown>
    const resume = text(args.resume)
    if (!resume) return { deny: '`resume` is required: the prompt to continue with after compacting.' }
    const now = await $.clock.now()
    if (state.active && now - state.active.startedAt > STALE_MS) {
      await trace($, `tool: dropped a compaction in flight since ${hhmm(state.active.startedAt)} as lost`)
      state.active = undefined
    }
    if (state.active) {
      await trace($, `tool: refused, a compaction from ${hhmm(state.active.startedAt)} is still ${state.active.phase}`)
      return {
        deny:
          `A compaction you asked for at ${hhmm(state.active.job.writtenAt)} is still ${state.active.phase === 'compacting' ? 'running' : 'finishing'}. ` +
          'Do not call compact again; carry on with your work.',
      }
    }
    // A second call in the same turn replaces the first note.
    state.job = { keep: text(args.keep), resume, writtenAt: now }
    await trace($, 'tool: compaction queued')
    $.ui.status('self-compact: compacting when this turn ends')
    return {
      result:
        'Compaction queued for the end of this turn. End the turn now: no more tool calls, one short line. ' +
        'Your resume note is placed right after the summary, and the session carries on from it by itself.',
    }
  })

  on('tool.call', { tool: USAGE }, async $ => {
    const { tokens, window, limit, floor } = await fill($)
    if (tokens === undefined) return { result: 'No reading yet: the window was just started or compacted.' }
    const frees =
      floor > 0 && tokens > floor ? ` A compaction lands near ${k(floor)} here, so it would free about ${k(tokens - floor)}.` : ''
    return {
      result: `Context: ${k(tokens)} tokens in use, ${Math.round((tokens / limit) * 100)}% of the ${k(limit)} auto-compact point (model window ${k(window)}).${frees}`,
    }
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId !== undefined || e.tool === COMPACT || e.tool === USAGE || ran.deny !== undefined || ran.isError) return ran
    if (state.job || state.active) return ran
    const { tokens, limit, floor } = await fill($)
    if (tokens === undefined || limit <= floor) return ran
    const used = (tokens - floor) / (limit - floor)
    if (used < (NUDGE_AT[0] ?? 1)) state.nudged = 0
    const step = NUDGE_AT.filter(at => used >= at).length
    if (step <= state.nudged) return ran
    state.nudged = step
    const note =
      `[self-compact] Context is at ${k(tokens)}, ${Math.round((tokens / limit) * 100)}% of the ${k(limit)} auto-compact point; ` +
      `a compaction lands near ${k(floor)} here, so it would free about ${k(tokens - floor)}. ` +
      (step >= NUDGE_AT.length
        ? 'Auto-compaction is close: save state to disk now and call mcp__self-compact__compact at the next safe point.'
        : 'If you are at a phase boundary, save state to disk and call mcp__self-compact__compact; otherwise carry on.')
    return { ...ran, context: [...(ran.context ?? []), note] }
  })

  // Any compaction of the main conversation resets the floor and the reminders. Our own also gets the
  // resume note, time-stamped, appended after the summary.
  on('session.compact', async ($, e, next) => {
    if (e.agentId !== undefined || e.trigger === 'precompute') return next(e)
    const a = state.active
    const isOurs = a !== undefined && a.phase === 'compacting' && (e.instructions ?? '').includes(MARK)
    let done
    try {
      done = await next(e)
    } catch (err) {
      if (isOurs) a.failure = String(err)
      throw err
    }
    if (done.skip !== undefined) {
      if (isOurs) a.failure = done.skip
      return done
    }
    state.floor = undefined
    state.nudged = 0
    if (!isOurs) return done
    a.isCompacted = true
    a.compactedAt = await $.clock.now()
    a.isNoteEmbedded = true
    return { ...done, messages: [...done.messages, { role: 'user', text: noteText(a, a.compactedAt), toolUses: [] }] }
  })

  on('turn.start', ($, e, next) => {
    const a = state.active
    if (e.agentId === undefined && a) {
      // A turn that starts while the compaction waits to retry (a typed prompt), or while it settles
      // (a queued note), takes the place of the kick.
      if ((a.phase === 'compacting' && state.isWaiting) || a.phase === 'settling') a.isOvertaken = true
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    const job = state.job
    if (job) await trace($, `turn.complete: reason=${e.reason} agent=${e.agentId ?? 'main'}`)
    if (e.agentId !== undefined || !job) return done
    state.job = undefined
    if (e.reason !== 'answer') {
      $.ui.status(undefined)
      $.ui.toast('self-compact: the turn was interrupted, compaction dropped')
      return done
    }
    const a: Active = {
      job,
      phase: 'compacting',
      startedAt: await $.clock.now(),
      isNoteEmbedded: false,
      isCompacted: false,
      isOvertaken: false,
    }
    state.active = a
    state.isWaiting = true
    $.clock.after(250, () => void finish($, a, 0))
    await trace($, 'turn.complete: compaction scheduled in 250 ms')
    return done
  })
}

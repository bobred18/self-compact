import type { EngineInterface, Register } from 'claude-code'

// Self-compaction for the main session. The model calls `compact` with what the summary must keep and a
// note to resume from; the compaction runs once its turn ends (the engine refuses one mid-turn), and the
// note then comes back as the next prompt, so the work carries on with nobody at the keyboard.
// `context_usage` and a one-time reminder at 50% and 80% of the auto-compact point let it judge when.

const COMPACT = 'mcp__self-compact__compact'
const USAGE = 'mcp__self-compact__context_usage'
const NUDGE_AT = [0.5, 0.8]
const RETRY_MS = 2000
const RETRIES = 90

type Job = { keep: string; resume: string; isOvertaken: boolean }

// The module's own state; a reload starts it over, which at worst drops one queued compaction.
const state: { job?: Job; isWaiting: boolean; threshold?: number; nudged: number; isSdkHost: boolean } = {
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
  'line. The session then resumes by itself with `resume` as its next prompt. Main session only.',
].join(' ')

const k = (n: number) => `${Math.round(n / 1000)}k`
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
  return { tokens: context.tokens, window: context.window, limit: state.threshold ?? context.window }
}

const instructionsFor = (job: Job) =>
  'The agent asked for this compaction itself, at a point it chose.' +
  (job.keep ? ` Keep in full: ${job.keep}` : '') +
  ` Its next step afterwards, in its own words: ${job.resume}`

const resumeText = (job: Job, size: string) =>
  `[self-compact] Context compacted at your request${size}. Pick the work up now from your resume note ` +
  `below; nobody needs to confirm it. Stop only where the note itself says to.\n\n${job.resume}`

// SDK hosts (the desktop app, -p) refuse $.session.compact: there compaction runs inside a turn, as
// a /compact prompt. Queue /compact as a command, then the resume note behind it.
async function compactAsCommand($: EngineInterface, job: Job): Promise<void> {
  const instructions = instructionsFor(job)
  // Cleared first: the /compact turn's own turn.complete must not queue a second compaction.
  state.job = undefined
  $.ui.status(undefined)
  let isCompacted = false
  try {
    const ran = await $.command.run({ command: 'compact', args: instructions })
    isCompacted = true
    await trace($, `compact: /compact ran via command.run: ${(ran.text ?? '(no text)').slice(0, 200)}`)
  } catch (err) {
    await trace($, `compact: command.run rejected: ${String(err).slice(0, 300)}; trying a /compact prompt`)
    try {
      const sent = await $.prompt.submit({ text: `/compact ${instructions}`, asUser: true })
      isCompacted = sent.drop === undefined
      await trace($, `compact: /compact prompt ${isCompacted ? 'entered' : `dropped: ${sent.drop}`}`)
    } catch (err2) {
      await trace($, `compact: /compact prompt rejected: ${String(err2).slice(0, 300)}`)
    }
  }
  if (!isCompacted) {
    await $.prompt.submit({
      text: `[self-compact] The compaction you asked for could not run here. Carry on from your note now:\n\n${job.resume}`,
      asUser: true,
    })
    return
  }
  state.nudged = 0
  const submitted = await $.prompt.submit({ text: resumeText(job, ''), asUser: true })
  await trace($, `resume: submitted, ${submitted.drop !== undefined ? `dropped: ${submitted.drop}` : 'entered'}`)
}

async function finish($: EngineInterface, job: Job, tries: number): Promise<void> {
  state.isWaiting = false
  if (state.isSdkHost) {
    await compactAsCommand($, job)
    return
  }
  let compacted
  try {
    await trace($, `compact: attempt ${tries + 1}`)
    compacted = await $.session.compact({ instructions: instructionsFor(job) })
  } catch (err) {
    await trace($, `compact: rejected: ${String(err).slice(0, 300)}`)
    if (/headless|SDK/.test(String(err))) {
      await compactAsCommand($, job)
      return
    }
    // Rejected while a turn runs (a prompt typed meanwhile): try again once the session is idle.
    if (tries >= RETRIES) {
      state.job = undefined
      $.ui.toast('self-compact: gave up, the session never went idle')
      return
    }
    state.isWaiting = true
    $.clock.after(RETRY_MS, () => void finish($, job, tries + 1))
    return
  }
  state.job = undefined
  $.ui.status(undefined)
  await trace($, `compact: done${compacted.skip !== undefined ? `, skipped: ${compacted.skip}` : ''}`)
  if (compacted.skip !== undefined) {
    await $.prompt.submit({
      text: `[self-compact] The compaction you asked for did not run (${compacted.skip}). Carry on from your note now:\n\n${job.resume}`,
      asUser: true,
    })
    return
  }
  state.nudged = 0
  if (job.isOvertaken) {
    // Someone typed while it waited: their prompt has already steered the session past the note.
    $.ui.toast('self-compact: compacted; resume note kept in the summary, not re-sent')
    return
  }
  const size =
    compacted.tokensBefore && compacted.tokensAfter ? ` (${k(compacted.tokensBefore)} -> ${k(compacted.tokensAfter)} tokens)` : ''
  const submitted = await $.prompt.submit({ text: resumeText(job, size), asUser: true })
  await trace($, `resume: submitted, ${submitted.drop !== undefined ? `dropped: ${submitted.drop}` : 'entered'}`)
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
    state.job = { keep: text(args.keep), resume, isOvertaken: false }
    await trace($, 'tool: compaction queued')
    $.ui.status('self-compact: compacting when this turn ends')
    return {
      result:
        'Compaction queued for the end of this turn. End the turn now: no more tool calls, one short line. ' +
        'The session then resumes by itself with your resume note.',
    }
  })

  on('tool.call', { tool: USAGE }, async $ => {
    const { tokens, window, limit } = await fill($)
    if (tokens === undefined) return { result: 'No reading yet: the window was just started or compacted.' }
    return {
      result: `Context: ${k(tokens)} tokens in use, ${Math.round((tokens / limit) * 100)}% of the ${k(limit)} auto-compact point (model window ${k(window)}).`,
    }
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId !== undefined || e.tool === COMPACT || e.tool === USAGE || ran.deny !== undefined || ran.isError) return ran
    const { tokens, limit } = await fill($)
    if (tokens === undefined) return ran
    const share = tokens / limit
    if (share < (NUDGE_AT[0] ?? 1)) state.nudged = 0
    const step = NUDGE_AT.filter(at => share >= at).length
    if (step <= state.nudged) return ran
    state.nudged = step
    const note =
      `[self-compact] Context is at ${k(tokens)}, ${Math.round(share * 100)}% of the ${k(limit)} auto-compact point. ` +
      'If you are at a phase boundary, save state to disk and call mcp__self-compact__compact; otherwise carry on.'
    return { ...ran, context: [...(ran.context ?? []), note] }
  })

  on('turn.start', ($, e, next) => {
    if (state.job && state.isWaiting) state.job.isOvertaken = true
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    const job = state.job
    if (job) await trace($, `turn.complete: reason=${e.reason} agent=${e.agentId ?? 'main'} waiting=${state.isWaiting}`)
    if (e.agentId !== undefined || !job || state.isWaiting) return done
    if (e.reason !== 'answer') {
      state.job = undefined
      $.ui.status(undefined)
      $.ui.toast('self-compact: the turn was interrupted, compaction dropped')
      return done
    }
    state.isWaiting = true
    $.clock.after(250, () => void finish($, job, 0))
    await trace($, 'turn.complete: compaction scheduled in 250 ms')
    return done
  })
}

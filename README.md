# self-compact

A Claude Code mod that lets the main session **compact itself** at a point it chooses, then **carry on by itself** from a note it wrote just before.

Without it, a long session compacts when the context hits the auto-compact point: often mid-task, with the summary deciding what survives. With it, Claude compacts at a phase boundary (plan settled, milestone landed, debugging trail resolved), after writing its state to a file, and picks the work back up with nobody typing.

## What it adds

| Tool | What it does |
| --- | --- |
| `mcp__self-compact__compact` | Queues a compaction for the end of the current turn. Takes `keep` (what the summary must preserve) and `resume` (the next instruction to itself). |
| `mcp__self-compact__context_usage` | Reports tokens in use, the auto-compact point, the model's window, and how much a compaction would free. |

It also sends Claude two reminders as the context fills: at 70% and at 90% of the room between the post-compaction level and the auto-compact point.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install self-compact --marketplace bobred18/self-compact
```

Answer `y` to add the marketplace, then press Enter for the user scope. The mod is active at once in that session, and in every session you start after.

From a shell:

```
claude plugin install self-compact --marketplace bobred18/self-compact
```

In the desktop app (where `/plugin` does not run): click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `bobred18/self-compact`, then **Add plugin**.

**Requires** a Claude Code build with mods (hooks modules). Tested on 2.1.326 and 2.1.327.

## Usage

Nothing to configure. Tell Claude when you want it to use the tool, for example in your `CLAUDE.md`:

```markdown
Compact yourself at a phase boundary rather than waiting for auto-compaction:
call mcp__self-compact__compact. Write state to the handoff file first (the
summary is lossy), and write `resume` as the full next instruction to yourself.
```

A typical self-compaction:

1. Claude writes the plan, decisions and next step to a handoff file.
2. It calls `compact` with a `keep` list and a `resume` note, and ends its turn.
3. The mod runs the compaction. The summarizer is told what to keep.
4. The resume note goes into the compacted conversation, verbatim and time-stamped, right after the summary.
5. If no other turn starts within 3 seconds, the mod sends a short prompt, and Claude continues from the note.

## How it works

- **Main session only.** Subagents that call `compact` are refused.
- **One compaction at a time.** A second call while one runs is refused. One still running after 15 minutes counts as lost.
- **End of turn.** The engine refuses a compaction mid-turn, so the mod waits for the turn to end. It retries every 2 seconds (up to 3 minutes) while another turn is running.
- **Desktop app and `claude -p`.** These hosts refuse a plugin's own compaction, so the mod runs `/compact` as a command instead and puts the note behind it.
- **No stale notes.** If something else starts the next turn first (a task notification, a message from another session, you typing), that turn reads the note after the summary and no extra prompt is sent. A note never arrives later as a second, older copy.
- **Failures are reported.** If `/compact` errors, Claude is told the compaction did not run.
- **Reminders measure the usable room.** A compaction comes back to a floor (system prompt, tools, summary, re-read files), not to zero. The reminders are placed between that floor and the auto-compact point, so they do not fire right after every compaction. The floor is capped at 60% of the auto-compact point.

## Trace log

Each session writes its steps to `trace-<session id>.log` in the mod's folder (the last 200 lines). Read it first when a resume does not fire. The desktop app shows no mod errors, so this is the main debug view.

The logs stay on your machine; `.gitignore` keeps them out of the repository.

## Tests

```
claude plugin test .
```

## Limits

- Reloading the mod (an edit, a reinstall) clears its state, which drops at most one queued compaction.
- The summary is still lossy. The resume note survives word for word; everything else is up to the summarizer. Keep real state in a file.
- A session started before an update keeps the old version until it restarts.

## License

MIT

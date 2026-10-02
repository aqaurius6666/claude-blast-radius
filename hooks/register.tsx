// Blast radius: when a Bash command is about to ask for permission, preview what it would
// do. The built-in check measures any `rm`; user rules run a dry-run command per matching
// command in a chain or pipe. One line goes under the dialog, the details to a side pane.
// Display only, never in the model's context, and the verdict passes through untouched:
// the parser's blind spots must stay cosmetic misses, never holes in a gate.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { PreviewRun, Report } from '../types'
import { format, size } from './format'
import { parse, segments } from './parse'
import { absolute, probe, type Host } from './probe'
import { optionsOf, plan, rulesOf, SOURCES } from './rules'

const PANE = 'blast-radius'
// `/blast-radius off` stores false: the pane then opens only when asked for
const AUTO_OPEN = 'autoOpen'
const report = atom({ plugin: 'blast-radius', key: 'report' } as const, null)

const PREVIEW_MS = 10_000
const MAX_LINES = 200

function hostOf($: EngineInterface, cwd: string, home: string | undefined): Host {
  return {
    cwd,
    home,
    run: (argv, init) => $.process.run(argv, init),
    stat: path => $.fs.stat(path).catch(() => undefined),
    list: dir => $.fs.list(dir),
  }
}

function notice($: EngineInterface, id: string, text: string) {
  try {
    $.ui.notice(id, text)
  } catch {
    // dialog already answered: nothing left to tell
  }
}

async function loadRules($: EngineInterface) {
  const sources = await Promise.all(SOURCES.map(source => $.settings.read({ source }).catch(() => undefined)))
  return rulesOf(optionsOf(sources))
}

async function autoOpen($: EngineInterface) {
  return (await $.store.get(AUTO_OPEN).catch(() => undefined)) !== false
}

// the pane opened unasked for a prompt: closed once that prompt is answered.
// Module state: a reload starts over, at worst leaving one pane open.
const pane = { opened: undefined as string | undefined, answered: new Set<string>() }

async function closeFor($: EngineInterface, id: string) {
  pane.answered.add(id)
  if (pane.opened !== id) return
  pane.opened = undefined
  await $.ui.close({ id: PANE }).catch(() => {})
}

// opens the pane for prompt `id`, claimed for closing only when it was not open already
// (opened with `/blast-radius`, or still up for another prompt)
async function openFor($: EngineInterface, id: string) {
  const wasOpen = (await $.ui.panes().catch(() => [])).some(p => p.id === PANE)
  const placed = await $.ui.open({ id: PANE, title: 'Blast radius' }).then(
    r => r.isPlaced,
    () => false,
  )
  if (!wasOpen) {
    pane.opened = id
    // answered while the pane was opening: close it straight away
    if (pane.answered.has(id)) await closeFor($, id)
  }
  return placed
}

async function analyze($: EngineInterface, id: string, command: string) {
  const removal = parse(command)
  const { rules, errors } = await loadRules($)
  const plans = segments(command).flatMap(s => rules.flatMap(r => plan(r, s) ?? []))
  if (!removal && !plans.length) return

  const set = (fn: (r: Report) => Report) => update($, report, cur => (cur?.id === id ? fn(cur) : cur))
  const previews: PreviewRun[] = plans.map(p =>
    'skip' in p ? { ...p, state: 'done', lines: [], more: 0 } : { ...p, state: 'running', lines: [], more: 0 },
  )
  const fresh: Report = {
    id,
    command,
    rm: removal && { state: 'running', line: 'measuring…', items: [] },
    previews,
    errors,
  }
  await update($, report, () => fresh)
  // opened unasked: a narrow terminal (under 144 columns) keeps it undrawn, so the line says how to see it
  const placed = (await autoOpen($)) && (await openFor($, id))
  const withHint = (...parts: (string | false | null | undefined)[]) =>
    [...parts, !placed && 'details: /blast-radius'].filter(Boolean).join(' · ')
  const dryRuns = previews.length
    ? `🔍 ${previews.length} dry-run${previews.length === 1 ? '' : 's'}${placed ? ' in the Blast radius pane' : ''}`
    : ''
  notice($, id, withHint(removal && '💥 rm: measuring…', dryRuns))

  const [cwd, home] = await Promise.all([$.session.cwd(), $.env.get('HOME')])
  const host = hostOf($, cwd, home)

  const rmDone = removal
    ? probe(host, removal).then(async impact => {
        const line = format(impact)
        await set(r => ({ ...r, rm: { state: 'done', line, items: impact.items } }))
        return line
      })
    : Promise.resolve('')

  await Promise.all(
    previews.map(async (p, i) => {
      if (!p.argv) return
      const dir = absolute(host, '', p.dir || '.') ?? cwd
      const done = await host
        .run(p.argv, { cwd: dir, timeoutMs: PREVIEW_MS })
        .then(r => {
          const all = `${r.stdout}\n${r.exitCode === 0 ? '' : (r.stderr ?? '')}`.split('\n').filter(l => l.trim())
          return { exitCode: r.exitCode, lines: all.slice(0, MAX_LINES), more: Math.max(0, all.length - MAX_LINES) }
        })
        .catch((err: unknown) => ({ exitCode: -1, lines: [String(err)], more: 0 }))
      await set(r => ({ ...r, previews: r.previews.map((q, j) => (j === i ? { ...q, state: 'done', ...done } : q)) }))
    }),
  )
  notice($, id, withHint(await rmDone, dryRuns))
}

export const register: Register = on => {
  const seen = new Set<string>()

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'blast-radius',
      description: 'Show the Blast radius pane (last previewed command); `off` / `on`: stop / resume opening it by itself',
    })
    return next(e)
  })

  on('command.run', { command: 'blast-radius' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    // asked for: stays open after the prompt it was opened for
    pane.opened = undefined
    if (arg === 'off') {
      await $.store.set(AUTO_OPEN, false)
      await $.ui.close({ id: PANE }).catch(() => {})
      return { text: 'Blast radius pane closed; it no longer opens by itself. `/blast-radius on` to undo.' }
    }
    if (arg === 'on') await $.store.set(AUTO_OPEN, true)
    else if (arg) return { text: `Unknown argument "${arg}": /blast-radius [on|off]` }
    await $.ui.open({ id: PANE, title: 'Blast radius' })
    return { text: arg === 'on' ? 'Blast radius pane opened; it opens by itself again.' : 'Blast radius pane opened.' }
  })

  // next(e) runs the permission prompt and the tool: once it settles, the prompt is answered
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    try {
      return await next(e)
    } finally {
      await closeFor($, e.tool_use_id)
    }
  })

  on('tool.check', { tool: 'Bash' }, async ($, e, next) => {
    const verdict = await next(e)
    const id = e.tool_use_id
    const command = (e.input as { command?: unknown }).command
    if (verdict.decision !== 'ask' || !id || seen.has(id) || typeof command !== 'string') return verdict
    seen.add(id)
    // not awaited: the dialog opens now, the line and pane fill in as the probes finish
    analyze($, id, command).catch(err => notice($, id, `💥 could not preview (${String(err).slice(0, 60)})`))
    return verdict
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const r = await read($, report)
    if (!r) return <Text dimColor>Nothing yet: opens when a permission prompt has an rm or matches a rule.</Text>

    const rows: ReturnType<typeof Text>[] = []
    rows.push(<Text dimColor>$ {r.command}</Text>)
    for (const err of r.errors) rows.push(<Text color="yellow">⚠ config: {err}</Text>)
    if (r.rm) {
      rows.push(<Text bold>{r.rm.line}</Text>)
      for (const it of r.rm.items)
        rows.push(
          <Text>
            {'  '}
            {it.path}
            {it.kind === 'dir' ? '/' : ''}
            <Text dimColor>
              {'  '}
              {it.files} file{it.files === 1 ? '' : 's'} · {size(it.bytes)}
            </Text>
          </Text>,
        )
    }
    for (const p of r.previews) {
      rows.push(
        <Text bold>
          🔍 {p.rule}: {p.argv ? p.argv.join(' ') : p.segment}
        </Text>,
      )
      if (p.skip) rows.push(<Text color="yellow">{'  '}skipped: {p.skip}</Text>)
      else if (p.state === 'running') rows.push(<Text dimColor>{'  '}running…</Text>)
      else {
        if (p.exitCode !== 0) rows.push(<Text color="red">{'  '}exit {p.exitCode}</Text>)
        if (!p.lines.length) rows.push(<Text dimColor>{'  '}(no output)</Text>)
        for (const l of p.lines) rows.push(<Text>{'  '}{l}</Text>)
        if (p.more) rows.push(<Text dimColor>{'  '}… {p.more} more lines</Text>)
      }
    }

    const room = Math.max(3, (e.viewport?.rows ?? 30) - 2)
    const shown = rows.length > room ? [...rows.slice(0, room - 1), <Text dimColor>… {rows.length - room + 1} more rows</Text>] : rows
    return <Box flexDirection="column">{shown}</Box>
  })
}

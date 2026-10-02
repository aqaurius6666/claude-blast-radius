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
  const placed = await $.ui.open({ id: PANE, title: 'Blast radius' }).then(
    r => r.isPlaced,
    () => false,
  )
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
    await $.command.register({ name: 'blast-radius', description: 'Show the Blast radius pane (last previewed command)' })
    return next(e)
  })

  on('command.run', { command: 'blast-radius' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Blast radius' })
    return { text: 'Blast radius pane opened.' }
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

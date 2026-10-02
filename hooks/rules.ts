// User rules: a regex over one simple command, and a read-only preview command to run when
// it matches. "kdel.match": "^kubectl delete (.+)$", "kdel.preview": "kubectl delete $1 --dry-run=server -o name".
//
// The preview runs WITHOUT asking, so it is held to: argv only (never a shell), no ; | &
// after filling in, no $VAR or $(..) left (a capture like $(curl ..) must not run), and
// no shell or wrapper as the program. Whether the preview itself is read-only is the
// rule author's job.

import { isWord, lex, type Segment, type Word } from './parse'

export type Rule = { id: string; match: RegExp; preview: string }

export type Plan =
  | { rule: string; segment: string; argv: string[]; dir: string }
  | { rule: string; segment: string; skip: string }

type Options = Readonly<Record<string, unknown>>

export const SOURCES = ['user', 'project', 'local', 'flag', 'policy'] as const

// a program that would run its arguments as code, or hide what runs
const REFUSED = new Set(['sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'eval', 'exec', 'env', 'sudo', 'xargs', 'nohup', 'command', 'builtin', 'time', 'nice', 'python', 'python3', 'node', 'perl', 'ruby'])

// register's `options` only carries keys plugin.json's userConfig declares, so dotted keys
// never arrive there: read pluginConfigs per source, the last source setting a key wins.
export function optionsOf(sources: readonly unknown[]): Options {
  const out: Record<string, unknown> = {}
  for (const s of sources) {
    const configs = (s as { pluginConfigs?: Record<string, { options?: unknown }> } | undefined)?.pluginConfigs ?? {}
    for (const [key, v] of Object.entries(configs)) {
      if (key !== 'blast-radius' && !key.startsWith('blast-radius@')) continue
      const opts = v?.options
      if (opts && typeof opts === 'object' && !Array.isArray(opts)) Object.assign(out, opts)
    }
  }
  return out
}

export function rulesOf(options: Options): { rules: Rule[]; errors: string[] } {
  const ids = options.rules
  const rules: Rule[] = []
  const errors: string[] = []
  for (const id of Array.isArray(ids) ? ids.map(String) : []) {
    const match = options[`${id}.match`]
    const preview = options[`${id}.preview`]
    if (typeof match !== 'string' || typeof preview !== 'string') {
      errors.push(`${id}: needs "${id}.match" and "${id}.preview" strings`)
      continue
    }
    try {
      rules.push({ id, match: new RegExp(match), preview })
    } catch (err) {
      errors.push(`${id}: bad regex: ${String(err)}`)
    }
  }
  return { rules, errors }
}

export function plan(rule: Rule, seg: Segment): Plan | undefined {
  const m = rule.match.exec(seg.text)
  if (!m) return undefined
  const base = { rule: rule.id, segment: seg.text }
  if (seg.dir === undefined) return { ...base, skip: 'runs after a cd we cannot follow' }

  const filled = rule.preview.replace(/\$(\d)/g, (_, n: string) => m[Number(n)] ?? '')
  const tokens = lex(filled)
  if (!tokens.every(isWord)) return { ...base, skip: 'preview would chain commands (; | &)' }
  const words = tokens as Word[]
  if (!words.length) return { ...base, skip: 'preview is empty' }
  if (words.some(w => w.dynamic)) return { ...base, skip: 'preview holds $VAR or $(..)' }
  const program = words[0]!.text.split('/').pop()!
  if (REFUSED.has(program)) return { ...base, skip: `${program} is not allowed as a preview` }
  return { ...base, argv: words.map(w => w.text), dir: seg.dir }
}

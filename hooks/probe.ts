// Measures what a Removal would take: files, size, and how much of it git can't bring back.
// Read-only probes through argv (never a shell: a target like $(curl ..) must not run).

import type { Removal } from './parse'

export type RunResult = { exitCode: number; stdout: string; stderr?: string; isStdoutTruncated: boolean }
export type Stat = { kind: 'file' | 'dir' | 'other'; size: number; isLink: boolean }

export type Host = {
  cwd: string
  home: string | undefined
  run: (argv: readonly string[], init: { cwd?: string; timeoutMs: number }) => Promise<RunResult>
  stat: (path: string) => Promise<Stat | undefined>
  list: (dir: string) => Promise<readonly { name: string }[]>
}

export type Flag = 'root' | 'home' | 'cwd' | 'git-dir' | 'outside-cwd'

export type Impact = {
  recursive: boolean
  paths: number
  missing: number
  unresolved: number
  dirsWithoutR: number
  files: number
  filesCapped: boolean
  bytes: number
  sizeUnknown: boolean
  // modified or untracked in git, or outside any repo: gone for good
  unsaved: number
  tracked: number
  ignored: number
  gitUnknown: boolean
  flags: Flag[]
  // per existing path, for the pane
  items: { path: string; kind: 'file' | 'dir'; files: number; bytes: number }[]
}

const PROBE_MS = 3000
const MAX_PATHS = 200

export function normalize(path: string): string {
  const parts: string[] = []
  for (const p of path.split('/')) {
    if (p === '' || p === '.') continue
    if (p === '..') parts.pop()
    else parts.push(p)
  }
  return `/${parts.join('/')}`
}

export function absolute(host: Host, dir: string, text: string): string | undefined {
  const base = text.startsWith('/') || text.startsWith('~') || !dir ? text : `${dir}/${text}`
  if (base.startsWith('/')) return normalize(base)
  if (base === '~' || base.startsWith('~/')) return host.home ? normalize(host.home + base.slice(1)) : undefined
  if (base.startsWith('~')) return undefined // ~user
  return normalize(`${host.cwd}/${base}`)
}

function globRegex(pattern: string): RegExp {
  let re = ''
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!
    if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    else if (c === '[') {
      const end = pattern.indexOf(']', i + 1)
      if (end < 0) re += '\\['
      else {
        re += `[${pattern.slice(i + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\')}]`
        i = end
      }
    } else re += c.replace(/[.+^${}()|\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`)
}

async function expand(host: Host, abs: string): Promise<string[] | undefined> {
  const cut = abs.lastIndexOf('/')
  const parent = abs.slice(0, cut) || '/'
  const pattern = abs.slice(cut + 1)
  if (/[*?[]/.test(parent)) return undefined
  const re = globRegex(pattern)
  const hidden = pattern.startsWith('.')
  const entries = await host.list(parent).catch(() => [])
  return entries
    .filter(e => re.test(e.name) && (hidden || !e.name.startsWith('.')))
    .map(e => normalize(`${parent}/${e.name}`))
}

const lines = (s: string) => s.split('\n').filter(Boolean).length

function flagsOf(host: Host, path: string): Flag[] {
  const within = (a: string, b: string) => b === a || b.startsWith(a === '/' ? '/' : `${a}/`)
  const flags: Flag[] = []
  if (path === '/') flags.push('root')
  else if (host.home && within(path, host.home)) flags.push('home')
  else if (within(path, host.cwd)) flags.push('cwd')
  if (path.split('/').includes('.git')) flags.push('git-dir')
  if (!within(host.cwd, path)) flags.push('outside-cwd')
  return flags
}

type GitCount = { repo: boolean; tracked: number; unsaved: number; untracked: number } | undefined

async function gitCount(host: Host, path: string, isDir: boolean): Promise<GitCount> {
  const at = isDir ? path : path.slice(0, path.lastIndexOf('/')) || '/'
  const opts = { cwd: at, timeoutMs: PROBE_MS }
  const top = await host.run(['git', 'rev-parse', '--show-toplevel'], opts)
  if (top.exitCode !== 0) return { repo: false, tracked: 0, unsaved: 0, untracked: 0 }
  const [ls, st] = await Promise.all([
    host.run(['git', 'ls-files', '-z', '--', path], opts),
    host.run(['git', 'status', '--porcelain', '-z', '--untracked-files=all', '--', path], opts),
  ])
  if (ls.exitCode !== 0 || st.exitCode !== 0) return undefined
  let unsaved = 0
  let untracked = 0
  const recs = st.stdout.split('\0').filter(Boolean)
  for (let i = 0; i < recs.length; i++) {
    const code = recs[i]!.slice(0, 2)
    if (code.startsWith('R') || code.startsWith('C')) i++ // rename/copy carry the old path as an extra record
    if (code === '??') untracked++
    if (code[1] !== ' ' || code === '??') unsaved++ // worktree side differs: rm loses it
  }
  return { repo: true, tracked: ls.stdout.split('\0').filter(Boolean).length, unsaved, untracked }
}

export async function probe(host: Host, removal: Removal): Promise<Impact> {
  const impact: Impact = {
    recursive: removal.recursive,
    paths: 0,
    missing: 0,
    unresolved: 0,
    dirsWithoutR: 0,
    files: 0,
    filesCapped: false,
    bytes: 0,
    sizeUnknown: false,
    unsaved: 0,
    tracked: 0,
    ignored: 0,
    gitUnknown: false,
    flags: [],
    items: [],
  }

  const paths = new Set<string>()
  for (const t of removal.targets) {
    const abs = t.dynamic || t.dir === undefined ? undefined : absolute(host, t.dir, t.text)
    if (!abs) {
      impact.unresolved++
      continue
    }
    if (!t.glob) {
      paths.add(abs)
      continue
    }
    const hits = await expand(host, abs)
    if (!hits) impact.unresolved++
    else if (!hits.length) impact.missing++
    else hits.forEach(p => paths.add(p))
  }

  const flags = new Set<Flag>()
  await Promise.all(
    [...paths].slice(0, MAX_PATHS).map(async path => {
      const st = await host.stat(path).catch(() => undefined)
      if (!st) return void impact.missing++
      impact.paths++
      const isDir = st.kind === 'dir' && !st.isLink
      if (isDir && !removal.recursive) return void impact.dirsWithoutR++
      flagsOf(host, path).forEach(f => flags.add(f))

      let files = 1
      let bytes = st.size
      if (isDir) {
        const [du, find] = await Promise.allSettled([
          host.run(['du', '-sk', path], { timeoutMs: PROBE_MS }),
          host.run(['find', path, '-type', 'f'], { timeoutMs: PROBE_MS }),
        ])
        bytes = du.status === 'fulfilled' && du.value.stdout ? parseInt(du.value.stdout, 10) * 1024 : 0
        if (!bytes && du.status !== 'fulfilled') impact.sizeUnknown = true
        if (find.status === 'fulfilled') {
          files = lines(find.value.stdout)
          if (find.value.isStdoutTruncated) impact.filesCapped = true
        } else {
          files = 0
          impact.filesCapped = true
        }
      }
      impact.bytes += bytes
      impact.files += files
      impact.items.push({ path, kind: isDir ? 'dir' : 'file', files, bytes })

      const git = await gitCount(host, path, isDir).catch(() => undefined)
      if (!git) return void (impact.gitUnknown = true)
      if (!git.repo) return void (impact.unsaved += files)
      impact.tracked += git.tracked
      impact.unsaved += git.unsaved
      impact.ignored += Math.max(0, files - git.tracked - git.untracked)
    }),
  )
  if (paths.size > MAX_PATHS) impact.unresolved += paths.size - MAX_PATHS
  impact.flags = [...flags]
  return impact
}

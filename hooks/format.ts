// One line under the permission dialog: worst news first, so a glance is enough.

import type { Flag, Impact } from './probe'

const DANGER: [Flag, string][] = [
  ['root', '⛔ deletes /'],
  ['home', '⛔ deletes $HOME'],
  ['cwd', '⛔ deletes the project'],
  ['git-dir', '⛔ deletes .git history'],
]

const count = (n: number) => n.toLocaleString('en-US')

export function size(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = bytes
  let u = 0
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024
    u++
  }
  return `${v >= 10 ? Math.round(v) : Number(v.toFixed(1))} ${units[u]}`
}

export function format(i: Impact): string {
  const parts: string[] = []
  for (const [flag, text] of DANGER) if (i.flags.includes(flag)) parts.push(text)

  if (i.files > 0 || i.filesCapped) {
    // gitignored files are lost too (.env, local config): git can't bring them back either
    const lost = i.unsaved + i.ignored
    if (i.gitUnknown) parts.push('git status unknown')
    else if (lost > 0) parts.push(`⚠ ${count(lost)} not in git${i.ignored > 0 ? ` (${count(i.ignored)} gitignored)` : ''}`)
    else parts.push('all in git')
    parts.push(`${i.filesCapped ? '≥' : ''}${count(i.files)} file${i.files === 1 ? '' : 's'}`)
    parts.push(i.sizeUnknown ? `≥${size(i.bytes)}` : size(i.bytes))
  }
  if (i.flags.includes('outside-cwd') && !DANGER.some(([f]) => i.flags.includes(f))) parts.push('outside project')
  if (i.dirsWithoutR > 0) parts.push(`${i.dirsWithoutR} dir${i.dirsWithoutR === 1 ? '' : 's'} skipped (no -r)`)
  if (i.missing > 0) parts.push(`${i.missing} not found`)
  if (i.unresolved > 0) parts.push(`${i.unresolved} unresolved ($VAR/xargs)`)
  if (!parts.length) parts.push('nothing to delete')

  return `💥 rm${i.recursive ? ' -r' : ''}: ${parts.join(' · ')}`
}

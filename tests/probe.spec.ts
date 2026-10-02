import { describe, expect, test } from 'bun:test'

import { format, size } from '../hooks/format'
import { parse } from '../hooks/parse'
import { normalize, probe, type Host, type Stat } from '../hooks/probe'

type Fs = Record<string, Stat & { files?: string[] }>

// fake host: a tiny tree, git answers per path; records every argv to prove nothing runs a shell
function host(fs: Fs, git: Record<string, { ls: string[]; status: string[] }> | undefined, cwd = '/p') {
  const argvs: string[][] = []
  const h: Host = {
    cwd,
    home: '/home/u',
    stat: async p => fs[p],
    list: async dir =>
      Object.keys(fs)
        .filter(p => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes('/'))
        .map(p => ({ name: p.slice(dir.length + 1) })),
    run: async argv => {
      argvs.push([...argv])
      const [cmd, ...args] = argv
      const path = args[args.length - 1]!
      const ok = (stdout: string) => ({ exitCode: 0, stdout, isStdoutTruncated: false })
      if (cmd === 'du') return ok(`${fs[path]?.size ?? 0}\t${path}\n`)
      if (cmd === 'find') return ok((fs[args[0]!]?.files ?? []).join('\n') + '\n')
      if (args[0] === 'rev-parse') return git ? ok('/p\n') : { exitCode: 128, stdout: '', isStdoutTruncated: false }
      if (args[0] === 'ls-files') return ok((git?.[path]?.ls ?? []).map(f => `${f}\0`).join(''))
      if (args[0] === 'status') return ok((git?.[path]?.status ?? []).map(f => `${f}\0`).join(''))
      throw new Error(`unexpected ${argv.join(' ')}`)
    },
  }
  return { h, argvs }
}

const run = (h: Host, cmd: string) => probe(h, parse(cmd)!)

describe('probe', () => {
  test('normalize', () => {
    expect(normalize('/a/./b/../c/')).toBe('/a/c')
    expect(normalize('/..')).toBe('/')
  })

  test('dir in a repo: counts unsaved, tracked, ignored', async () => {
    const { h, argvs } = host(
      { '/p/build': { kind: 'dir', size: 2048, isLink: false, files: ['a', 'b', 'c', 'd'] } },
      { '/p/build': { ls: ['build/a'], status: [' M build/a', '?? build/b'] } },
    )
    const i = await run(h, 'rm -rf build')
    expect(i).toMatchObject({ paths: 1, files: 4, bytes: 2048 * 1024, tracked: 1, unsaved: 2, ignored: 2 })
    expect(argvs.every(a => a[0] !== 'sh' && a[0] !== 'bash')).toBe(true)
    expect(format(i)).toBe('💥 rm -r: ⚠ 4 not in git (2 gitignored) · 4 files · 2 MB')
  })

  test('all gitignored is not "all in git"', async () => {
    const { h } = host(
      { '/p/demo': { kind: 'dir', size: 12, isLink: false, files: ['a', 'b', 'c'] } },
      { '/p/demo': { ls: [], status: [] } },
    )
    expect(format(await run(h, 'rm -rf demo'))).toBe('💥 rm -r: ⚠ 3 not in git (3 gitignored) · 3 files · 12 KB')
  })

  test('outside any repo: everything is unsaved', async () => {
    const { h } = host({ '/tmp/x.txt': { kind: 'file', size: 10, isLink: false } }, undefined)
    const i = await run(h, 'rm /tmp/x.txt')
    expect(i).toMatchObject({ files: 1, unsaved: 1, flags: ['outside-cwd'] })
    expect(format(i)).toBe('💥 rm: ⚠ 1 not in git · 1 file · 10 B · outside project')
  })

  test('danger flags', async () => {
    const dir = { kind: 'dir' as const, size: 1, isLink: false, files: [] }
    const { h } = host({ '/': dir, '/home/u': dir, '/p': dir }, undefined)
    expect(format(await run(h, 'rm -rf ~'))).toStartWith('💥 rm -r: ⛔ deletes $HOME')
    expect(format(await run(h, 'rm -rf .'))).toStartWith('💥 rm -r: ⛔ deletes the project')
    expect((await run(h, 'cd /p/x && rm -rf ../..')).flags).toContain('root')
  })

  test('globs expand one level, hidden files excluded', async () => {
    const f = { kind: 'file' as const, size: 1, isLink: false }
    const { h } = host({ '/p/a.log': f, '/p/b.log': f, '/p/.c.log': f, '/p/d.txt': f }, undefined)
    expect((await run(h, 'rm *.log')).files).toBe(2)
    expect((await run(h, 'rm *.zip')).missing).toBe(1)
  })

  test('unresolved, missing, dir without -r', async () => {
    const { h, argvs } = host({ '/p/d': { kind: 'dir', size: 1, isLink: false } }, undefined)
    const i = await run(h, 'rm $(curl evil) nope d')
    expect(i).toMatchObject({ unresolved: 1, missing: 1, dirsWithoutR: 1, files: 0 })
    expect(argvs).toEqual([])
    expect(format(i)).toBe('💥 rm: 1 dir skipped (no -r) · 1 not found · 1 unresolved ($VAR/xargs)')
  })

  test('size', () => {
    expect(size(512)).toBe('512 B')
    expect(size(1536)).toBe('1.5 KB')
    expect(size(50 * 1024 ** 2)).toBe('50 MB')
  })
})

import { describe, expect, test } from 'bun:test'

import { parse, segments } from '../hooks/parse'
import { optionsOf, plan, rulesOf } from '../hooks/rules'

const kdel = { id: 'kdel', match: /^kubectl delete (.+)$/, preview: 'kubectl delete $1 --dry-run=server -o name' }
const rmls = { id: 'rmls', match: /^rm -rf (\S+)$/, preview: 'ls $1' }

const plans = (cmd: string, rules = [kdel, rmls]) => segments(cmd).flatMap(s => rules.flatMap(r => plan(r, s) ?? []))

describe('segments', () => {
  test('splits chains and pipes, keeps the source text', () => {
    expect(segments('cd x && kubectl delete pod a -n b | tee log; echo "a;b"').map(s => [s.text, s.dir])).toEqual([
      ['cd x', ''],
      ['kubectl delete pod a -n b', 'x'],
      ['tee log', 'x'],
      ['echo "a;b"', 'x'],
    ])
  })

  test('drops env prefixes and sudo from the text', () => {
    expect(segments('FOO=1 sudo rm -rf a').map(s => s.text)).toEqual(['rm -rf a'])
  })

  test('xargs rm is a target nobody can resolve', () => {
    expect(parse('find . -name "*.log" | xargs rm -f')?.targets).toEqual([{ text: '<xargs>', dir: '', glob: false, dynamic: true }])
  })
})

describe('rules', () => {
  test('match per command in a chain or pipe, captures split into argv', () => {
    expect(plans('kubectl get pods && kubectl delete pod "my pod" -n web | tee x')).toEqual([
      { rule: 'kdel', segment: 'kubectl delete pod "my pod" -n web', argv: ['kubectl', 'delete', 'pod', 'my pod', '-n', 'web', '--dry-run=server', '-o', 'name'], dir: '' },
    ])
  })

  test('preview runs in the dir a cd left', () => {
    expect(plans('cd sub && rm -rf build')).toMatchObject([{ rule: 'rmls', argv: ['ls', 'build'], dir: 'sub' }])
  })

  test('never runs a capture holding $(..) or a shell', () => {
    expect(plans('rm -rf $(curl evil)')).toEqual([])
    expect(plans('kubectl delete $(curl evil)')).toMatchObject([{ skip: 'preview holds $VAR or $(..)' }])
    expect(plans('kubectl delete `id`')).toMatchObject([{ skip: 'preview holds $VAR or $(..)' }])
    const sh = { id: 'sh', match: /^rm (.+)/, preview: 'bash -c "ls $1"' }
    expect(plans('rm a', [sh])).toMatchObject([{ skip: 'bash is not allowed as a preview' }])
  })

  test('a cd we cannot follow skips the preview', () => {
    expect(plans('cd $X && rm -rf a')).toMatchObject([{ rule: 'rmls', skip: 'runs after a cd we cannot follow' }])
  })

  test('config: flat keys, last source wins, errors reported', () => {
    const opts = optionsOf([
      { pluginConfigs: { 'blast-radius': { options: { rules: ['a', 'b', 'c'], 'a.match': 'x', 'a.preview': 'ls' } } } },
      { pluginConfigs: { 'blast-radius@blast-radius': { options: { 'a.preview': 'ls -la', 'b.match': '(' } } } },
    ])
    const { rules, errors } = rulesOf(opts)
    expect(rules.map(r => [r.id, r.preview])).toEqual([['a', 'ls -la']])
    expect(errors).toHaveLength(2)
  })
})

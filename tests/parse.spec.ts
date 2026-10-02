import { describe, expect, test } from 'bun:test'

import { parse } from '../hooks/parse'

const texts = (cmd: string) => parse(cmd)?.targets.map(t => t.text)

describe('parse', () => {
  test('ignores commands without rm', () => {
    expect(parse('ls -la')).toBeUndefined()
    expect(parse('git rm --cached a')).toBeUndefined()
    expect(parse('echo rm')).toBeUndefined()
  })

  test('flags and targets', () => {
    expect(parse('rm -rf build dist')).toEqual({
      recursive: true,
      targets: [
        { text: 'build', dir: '', glob: false, dynamic: false },
        { text: 'dist', dir: '', glob: false, dynamic: false },
      ],
    })
    expect(parse('rm -f a.txt')?.recursive).toBe(false)
    expect(parse('rm --recursive x')?.recursive).toBe(true)
    expect(texts('rm -- -weird')).toEqual(['-weird'])
  })

  test('quotes, escapes, globs', () => {
    expect(texts(`rm "my file" 'a b' c\\ d`)).toEqual(['my file', 'a b', 'c d'])
    expect(parse('rm *.log')?.targets[0]?.glob).toBe(true)
    expect(parse('rm "*.log"')?.targets[0]?.glob).toBe(false)
  })

  test('never expands $VAR or $(..)', () => {
    expect(parse('rm -rf $(curl x)')?.targets[0]?.dynamic).toBe(true)
    expect(parse('rm "$DIR/x"')?.targets[0]?.dynamic).toBe(true)
    expect(parse("rm '$DIR'")?.targets[0]?.dynamic).toBe(false)
  })

  test('follows cd', () => {
    expect(parse('cd sub && rm a')?.targets[0]?.dir).toBe('sub')
    expect(parse('cd /tmp; cd x && rm a')?.targets[0]?.dir).toBe('/tmp/x')
    expect(parse('cd $X && rm a')?.targets[0]?.dir).toBeUndefined()
    expect(parse('cd && rm a')?.targets[0]?.dir).toBe('~')
  })

  test('wrappers, redirects, compound commands', () => {
    expect(texts('sudo rm -rf /opt/x')).toEqual(['/opt/x'])
    expect(texts('FOO=1 rm a')).toEqual(['a'])
    expect(texts('rm a 2>/dev/null')).toEqual(['a'])
    expect(texts('rm a > out.log 2>&1')).toEqual(['a'])
    expect(texts('make clean && rm -rf node_modules; ls')).toEqual(['node_modules'])
    expect(texts('/bin/rm a')).toEqual(['a'])
  })
})

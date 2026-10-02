// Splits a Bash command into simple commands (around ; && || | & newlines) and finds what
// an `rm` would delete, without running anything. Best effort, like a human skimming the
// line: no aliases, functions, find -delete, bash -c, heredocs or scripts. Good enough to
// warn, never to authorize.

export type Target = {
  text: string
  // directory the rm runs in, relative to the session cwd (or absolute, or ~); undefined after a `cd` we can't follow
  dir: string | undefined
  glob: boolean
  // $VAR, $(..), `..`, xargs input: only the shell knows; never expanded here, expanding would run it
  dynamic: boolean
}

export type Removal = { recursive: boolean; targets: Target[] }

export type Word = { text: string; glob: boolean; dynamic: boolean; start: number; end: number }
export type Token = Word | { op: string }

// one simple command: its source text from the command name on, its words, the dir it runs in
export type Segment = { text: string; words: Word[]; dir: string | undefined }

const WRAPPERS = new Set(['sudo', 'command', 'builtin', 'nohup', 'time', 'nice', 'exec'])

export function lex(src: string): Token[] {
  const out: Token[] = []
  let word: Word | undefined
  let skipNext = false
  const push = (at: number) => {
    if (word) {
      word.end = at
      if (skipNext) skipNext = false
      else out.push(word)
    }
    word = undefined
  }

  for (let i = 0; i < src.length; i++) {
    const c = src[i]!
    const cur = () => (word ??= { text: '', glob: false, dynamic: false, start: i, end: i })
    if (c === ' ' || c === '\t') {
      push(i)
    } else if (c === '\n' || c === ';' || c === '(' || c === ')') {
      push(i)
      out.push({ op: ';' })
    } else if (c === '&' || c === '|') {
      push(i)
      if (src[i + 1] === c) i++
      out.push({ op: c })
    } else if (c === '>' || c === '<') {
      // redirection: drop a leading fd number and the redirect target, neither is an argument
      if (word && /^\d+$/.test(word.text)) word = undefined
      push(i)
      if (src[i + 1] === '>' || src[i + 1] === '&') i++
      if (src[i] === '&') {
        while (/[\d-]/.test(src[i + 1] ?? '')) i++
      } else {
        skipNext = true
      }
    } else if (c === '#' && !word) {
      while (i < src.length && src[i] !== '\n') i++
      i--
    } else if (c === "'") {
      const w = cur()
      const end = src.indexOf("'", i + 1)
      const stop = end < 0 ? src.length : end
      w.text += src.slice(i + 1, stop)
      i = stop
    } else if (c === '"') {
      const w = cur()
      for (i++; i < src.length && src[i] !== '"'; i++) {
        if (src[i] === '\\' && /["\\$`]/.test(src[i + 1] ?? '')) i++
        else if (src[i] === '$' || src[i] === '`') w.dynamic = true
        w.text += src[i]
      }
    } else if (c === '\\') {
      cur().text += src[++i] ?? ''
    } else if ((c === '$' && src[i + 1] === '(') || c === '`') {
      // command substitution stays one opaque word, however many words it holds
      const w = cur()
      w.dynamic = true
      let depth = 0
      const start = i
      for (; i < src.length; i++) {
        const d = src[i]!
        if (c === '`' ? d === '`' && i > start : d === ')' && --depth === 0) break
        if (c !== '`' && d === '(') depth++
      }
      w.text += src.slice(start, i + 1)
    } else {
      const w = cur()
      if (c === '$') w.dynamic = true
      if (c === '*' || c === '?' || c === '[') w.glob = true
      w.text += c
    }
  }
  push(src.length)
  return out
}

export const isWord = (t: Token): t is Word => 'text' in t

const basename = (w: Word) => w.text.split('/').pop()

function joinDir(dir: string | undefined, next: Word | undefined): string | undefined {
  if (!next) return '~'
  if (dir === undefined || next.dynamic || next.text === '-') return undefined
  const p = next.text
  if (p.startsWith('/') || p.startsWith('~')) return p
  return dir === '' ? p : `${dir}/${p}`
}

export function segments(command: string): Segment[] {
  const groups: Word[][] = [[]]
  for (const t of lex(command)) {
    if (isWord(t)) groups[groups.length - 1]!.push(t)
    else groups.push([])
  }

  let dir: string | undefined = ''
  const out: Segment[] = []
  for (const g of groups) {
    let i = 0
    while (i < g.length && (WRAPPERS.has(g[i]!.text) || /^[A-Za-z_]\w*=/.test(g[i]!.text) || (i > 0 && g[i]!.text.startsWith('-')))) i++
    const words = g.slice(i)
    if (!words.length) continue
    out.push({ text: command.slice(words[0]!.start, words[words.length - 1]!.end), words, dir })
    if (basename(words[0]!) === 'cd') dir = joinDir(dir, words[1])
  }
  return out
}

export function parse(command: string): Removal | undefined {
  if (!/\brm\b/.test(command)) return undefined

  let recursive = false
  const targets: Target[] = []
  for (const { words, dir } of segments(command)) {
    const [head, ...args] = words
    const name = basename(head!)
    if (name === 'xargs' && args.some(a => basename(a) === 'rm')) {
      // targets arrive on stdin from the left side of the pipe
      targets.push({ text: '<xargs>', dir, glob: false, dynamic: true })
    } else if (name === 'rm') {
      let flags = true
      for (const a of args) {
        if (flags && a.text === '--') flags = false
        else if (flags && a.text.startsWith('-') && a.text.length > 1 && !a.dynamic) {
          if (a.text === '--recursive' || (!a.text.startsWith('--') && /[rR]/.test(a.text))) recursive = true
        } else {
          targets.push({ text: a.text, dir, glob: a.glob, dynamic: a.dynamic })
        }
      }
    }
  }

  return targets.length ? { recursive, targets } : undefined
}

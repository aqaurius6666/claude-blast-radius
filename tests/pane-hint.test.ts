import { expect, test } from 'claude-code/testing'

// The pane opens unasked from tool.check, so a narrow terminal leaves it undrawn:
// the line under the dialog must then say how to see the details.
for (const isPlaced of [false, true]) {
  test(`notice ${isPlaced ? 'points at the pane' : 'hints /blast-radius'} when the pane is ${isPlaced ? '' : 'not '}placed`, async ($, on) => {
    const notices: (string | undefined)[] = []
    let settled!: () => void
    const twoLines = new Promise<void>(r => (settled = r))
    on('tool.check', () => ({ decision: 'ask' }))
    on('ui.open', () => ({ value: isPlaced ? { isPlaced: true } : { isPlaced: false, reason: 'under 144 columns (80)' } }))
    on('ui.notice', (_, e) => {
      if (notices.push(e.text) === 2) settled()
      return { value: undefined }
    })
    on('settings.read', () => ({ value: {} }))
    on('session.cwd', () => ({ value: '/work' }))
    on('env.get', () => ({ value: '/home/u' }))
    on('fs.stat', () => ({ deny: 'ENOENT' }))
    on('fs.list', () => ({ value: [] }))
    on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))

    await $.tool.check({ tool: 'Bash', input: { command: 'rm gone.txt' }, tool_use_id: 't1' })
    await twoLines

    const [first, last] = [notices[0], notices.at(-1)]
    expect(first).toContain('💥 rm: measuring…')
    for (const line of [first, last]) {
      if (isPlaced) expect(line).not.toContain('/blast-radius')
      else expect(line).toContain('details: /blast-radius')
    }
  })
}

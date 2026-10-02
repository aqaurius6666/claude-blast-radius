import { expect, test } from 'claude-code/testing'

// `/blast-radius off` closes the pane and stops it opening by itself; `on` brings that back.
test('/blast-radius off closes the pane and stops auto-open, on resumes it', async ($, on) => {
  const store = new Map<string, unknown>()
  const calls: string[] = []
  const notices: (string | undefined)[] = []
  let settled!: () => void
  const twoLines = new Promise<void>(r => (settled = r))
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('ui.open', () => {
    calls.push('open')
    return { value: { isPlaced: true } }
  })
  on('ui.close', () => {
    calls.push('close')
    return { value: undefined }
  })
  on('tool.check', () => ({ decision: 'ask' }))
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

  await $.command.run({ command: 'blast-radius', args: 'off' })
  expect(calls).toEqual(['close'])
  expect(store.get('autoOpen')).toBe(false)

  await $.tool.check({ tool: 'Bash', input: { command: 'rm gone.txt' }, tool_use_id: 't1' })
  await twoLines
  expect(calls).toEqual(['close'])
  expect(notices.at(-1)).toContain('details: /blast-radius')

  await $.command.run({ command: 'blast-radius', args: 'on' })
  expect(calls).toEqual(['close', 'open'])
  expect(store.get('autoOpen')).toBe(true)
})

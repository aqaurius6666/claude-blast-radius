import { expect, test } from 'claude-code/testing'

// Opened unasked for a prompt, the pane closes once that prompt is answered;
// opened by `/blast-radius`, it stays.
test('pane opened for a prompt closes when the prompt is answered', async ($, on) => {
  const calls: string[] = []
  let isShown = false
  on('ui.panes', () => ({ value: isShown ? [{ id: 'blast-radius', title: 'Blast radius', isShown, isFocused: false, isPlaced: true }] : [] }))
  let opened = () => {}
  on('ui.open', () => {
    calls.push('open')
    isShown = true
    opened()
    return { value: { isPlaced: true } }
  })
  on('ui.close', () => {
    calls.push('close')
    isShown = false
    return { value: undefined }
  })
  on('ui.notice', () => ({ value: undefined }))
  on('settings.read', () => ({ value: {} }))
  on('session.cwd', () => ({ value: '/work' }))
  on('env.get', () => ({ value: '/home/u' }))
  on('fs.stat', () => ({ deny: 'ENOENT' }))
  on('fs.list', () => ({ value: [] }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('tool.check', () => ({ decision: 'ask' }))
  let checked = 0
  // stands for core: the dialog (the check) and the person's "no", given once the pane is up
  on('tool.call', { tool: 'Bash' }, async (_, e) => {
    const isOpen = new Promise<void>(r => (opened = r))
    await $.tool.check({ tool: 'Bash', input: { command: e.command }, tool_use_id: e.tool_use_id })
    checked++
    await isOpen
    return { deny: 'The user said no' }
  })

  await $.tool.call({ tool: 'Bash', command: 'rm gone.txt' })
  expect(calls).toEqual(['open', 'close'])
  expect(isShown).toBe(false)

  await $.command.run({ command: 'blast-radius', args: '', origin: 'person', presentation: 'terminal' } as never)
  await $.tool.call({ tool: 'Bash', command: 'rm again.txt' })
  expect(calls).toEqual(['open', 'close', 'open', 'open'])
  expect(isShown).toBe(true)
  expect(checked).toBe(2)
})

export type RmItem = { path: string; kind: 'file' | 'dir'; files: number; bytes: number }

export type RmReport = { state: 'running' | 'done'; line: string; items: RmItem[] }

export type PreviewRun = {
  rule: string
  segment: string
  state: 'running' | 'done'
  argv?: string[]
  dir?: string
  skip?: string
  exitCode?: number
  lines: string[]
  more: number
}

// the last permission prompt that had something to preview
export type Report = {
  id: string
  command: string
  rm?: RmReport
  previews: PreviewRun[]
  errors: string[]
}

declare module 'claude-code' {
  interface PluginState {
    'blast-radius': { report: Report | null }
  }
}

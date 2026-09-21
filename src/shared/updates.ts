export interface UpdateState {
  status:
    | 'disabled'
    | 'idle'
    | 'checking'
    | 'available'
    | 'downloading'
    | 'downloaded'
    | 'installing'
    | 'up-to-date'
    | 'error'
  currentVersion: string
  version: string | null
  releaseNotes: string
  progress: number
  canInstall: boolean
  reason: string
  error: string
}

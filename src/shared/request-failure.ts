import type { RequestRecord } from './contracts'

export interface RequestFailureLog {
  captureVersion?: number
  context?: Record<string, unknown>
  attempts?: Record<string, unknown>[]
  request: unknown
  forwardedRequest?: unknown
  errors: { attempt: number; status?: number; detail: unknown }[]
}

export function isFailedRequest(record: RequestRecord): boolean {
  return record.status >= 400 || !!record.interruption
}

export function canReportRequest(record: RequestRecord): boolean {
  return (
    isFailedRequest(record) && record.status !== 499 && record.interruption !== 'client_disconnect'
  )
}

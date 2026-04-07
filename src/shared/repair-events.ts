export interface RepairProgressEvent {
  channelId: string
  phase: string
  status: 'pending' | 'in-progress' | 'success' | 'failed'
  message: string
  timestamp: number
}

export interface RepairResultEvent {
  channelId: string
  kind: string
  ok: boolean
  summary: string
  retryable?: boolean
  trigger: 'user-manual' | 'startup' | 'gateway-self-heal' | 'page-load' | 'channel-connect'
  timestamp: number
}

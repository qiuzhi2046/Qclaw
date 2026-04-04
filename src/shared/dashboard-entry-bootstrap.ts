export type DashboardEntryBootstrapTaskKey = 'gateway' | 'config' | 'pairing'

export type DashboardEntryBootstrapTaskStatus =
  | 'pending'
  | 'active'
  | 'done'
  | 'warning'
  | 'error'

export interface DashboardEntryBootstrapState {
  gateway: DashboardEntryBootstrapTaskStatus
  config: DashboardEntryBootstrapTaskStatus
  pairing: DashboardEntryBootstrapTaskStatus
}

export interface DashboardEntryBootstrapCopy {
  title: string
  detail: string
}

export interface DashboardEntryBootstrapTaskDefinition {
  key: DashboardEntryBootstrapTaskKey
  label: string
  pendingDescription: string
}

export interface DashboardEntryPairingSummary {
  feishuBotCount: number
  pairedBotCount: number
  degradedBotCount: number
  offlineBotCount: number
  otherChannelCount: number
}

export interface DashboardEntrySnapshot {
  gatewayRunning: boolean
  config: Record<string, any> | null
  pairingSummary: DashboardEntryPairingSummary | null
  modelStatus: Record<string, any> | null
  loadedAt: string
}

export const DASHBOARD_ENTRY_TASKS: DashboardEntryBootstrapTaskDefinition[] = [
  {
    key: 'gateway',
    label: '读取网关状态',
    pendingDescription: '读取当前网关状态，运行状态问题会在控制面板内继续处理。',
  },
  {
    key: 'config',
    label: '读取当前配置',
    pendingDescription: '读取控制面板首屏所需的配置快照。',
  },
  {
    key: 'pairing',
    label: '整理配对状态',
    pendingDescription: '汇总渠道接通、飞书运行状态和配对状态。',
  },
]

export function createDashboardEntryBootstrapState(): DashboardEntryBootstrapState {
  return {
    gateway: 'pending',
    config: 'pending',
    pairing: 'pending',
  }
}

function resolveProgressUnit(status: DashboardEntryBootstrapTaskStatus): number {
  if (status === 'done' || status === 'warning') return 1
  if (status === 'active') return 0.45
  if (status === 'error') return 0.2
  return 0
}

export function resolveDashboardEntryBootstrapProgress(
  state: DashboardEntryBootstrapState
): number {
  const weights: Record<DashboardEntryBootstrapTaskKey, number> = {
    gateway: 0.5,
    config: 0.3,
    pairing: 0.2,
  }

  const baseline = 8
  const weightedProgress = (Object.keys(weights) as DashboardEntryBootstrapTaskKey[]).reduce(
    (sum, key) => sum + resolveProgressUnit(state[key]) * weights[key],
    0
  )

  return Math.max(baseline, Math.min(100, Math.round(baseline + weightedProgress * (100 - baseline))))
}

export function resolveDashboardEntryBootstrapCopy(
  state: DashboardEntryBootstrapState
): DashboardEntryBootstrapCopy {
  if (state.pairing === 'active') {
    return {
      title: '整理配对状态',
      detail: '正在汇总飞书连接情况和配对结果。',
    }
  }

  if (state.config === 'active') {
    return {
      title: '读取当前配置',
      detail: '正在加载当前控制面板首屏依赖的配置。',
    }
  }

  if (state.gateway === 'active') {
    return {
      title: '读取网关状态',
      detail: '正在读取当前网关状态，运行状态问题会在控制面板内继续处理。',
    }
  }

  if (
    (Object.keys(state) as DashboardEntryBootstrapTaskKey[]).every(
      (key) => state[key] === 'done' || state[key] === 'warning'
    )
  ) {
    return {
      title: '控制面板准备完成',
      detail: '进入前检查已经完成，正在进入控制面板并渲染首屏。',
    }
  }

  return {
    title: '正在进入控制面板',
    detail: '正在完成本次进入前检查，并同步控制面板首屏所需状态。',
  }
}

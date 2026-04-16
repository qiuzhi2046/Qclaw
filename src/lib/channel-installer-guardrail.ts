import type {
  ChannelInstallerGuardrailFailure,
  ChannelInstallerGuardrailState,
  ChannelInstallerGuardrailStatus,
  ChannelInstallerGuardrailStepId,
} from '../shared/channel-installer-session'

export interface ChannelInstallerGuardrailView {
  color: 'blue' | 'green' | 'yellow' | 'red' | 'gray'
  lines: string[]
  title: string
}

const SECRET_PATTERNS = [
  /(["']?(?:app(?:_|-)?secret|authorization(?:_|-)?code|token|secret)["']?\s*[:=]\s*["']?)[^"',;\s}\]]+/gi,
]

function sanitizeInstallerMessage(message: unknown): string {
  let text = String(message || '').trim()
  if (!text) return ''
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, '$1[已隐藏]')
  }
  if (text.length > 240) {
    text = `${text.slice(0, 240)}...`
  }
  return text
}

function stateLabel(state: ChannelInstallerGuardrailState | undefined): string {
  if (state === 'running') return '进行中'
  if (state === 'ok') return '已通过'
  if (state === 'failed') return '失败'
  if (state === 'skipped') return '已跳过'
  return '未开始'
}

function stepLabel(step: ChannelInstallerGuardrailStepId): string {
  if (step === 'environment') return '安装环境'
  if (step === 'command') return '安装命令'
  if (step === 'runtime') return 'Windows runtime'
  if (step === 'bridge') return 'OpenClaw 4.12 runtime bridge'
  if (step === 'config') return '旧插件/旧配置预检'
  if (step === 'gateway-stop') return '网关停止'
  if (step === 'gateway-recovery') return '网关恢复'
  if (step === 'spawn') return '安装器启动'
  if (step === 'final-sync') return '最终配置同步'
  return step
}

function failureTitle(failure: ChannelInstallerGuardrailFailure): string {
  if (failure.step === 'runtime') return 'Windows runtime 暂不可用'
  if (failure.step === 'bridge') return 'OpenClaw 4.12 runtime bridge 校验失败'
  if (failure.step === 'config') return '旧插件/旧配置预检失败'
  if (failure.step === 'gateway-recovery') return '网关恢复失败'
  if (failure.step === 'final-sync') return '最终配置同步失败'
  if (failure.step === 'command') return '安装命令不可用'
  if (failure.step === 'spawn') return '安装器启动失败'
  return `${stepLabel(failure.step)}失败`
}

export function resolveChannelInstallerGuardrailView(
  guardrail: ChannelInstallerGuardrailStatus | null | undefined
): ChannelInstallerGuardrailView | null {
  if (!guardrail) return null

  if (guardrail.failure) {
    const message = sanitizeInstallerMessage(guardrail.failure.message)
    return {
      color: guardrail.failure.step === 'gateway-recovery' ? 'yellow' : 'red',
      title: failureTitle(guardrail.failure),
      lines: [
        message || `${stepLabel(guardrail.failure.step)}未完成。`,
        guardrail.failure.step === 'config'
          ? 'Qclaw 已停止继续启动安装器，避免旧配置或旧插件把当前消息渠道写坏。'
          : '',
        guardrail.failure.step === 'runtime'
          ? '请确认当前 Windows runtime 仍指向 OpenClaw 2026.4.12，然后重试。'
          : '',
      ].filter(Boolean),
    }
  }

  const recovery = guardrail.gateway.recovery
  if (recovery && !recovery.ok && !recovery.skipped) {
    return {
      color: 'yellow',
      title: '网关恢复未完成',
      lines: [
        sanitizeInstallerMessage(recovery.message) || '安装器结束后，Qclaw 未能确认网关已经恢复。',
        '请稍后重试，或手动重新启动网关。',
      ],
    }
  }

  if (guardrail.lock.state === 'running') {
    const message = sanitizeInstallerMessage(guardrail.lock.message)
    return {
      color: 'blue',
      title: '正在处理官方消息渠道插件',
      lines: [
        message || '已有安装、修复或配置同步正在进行，请等待当前操作完成。',
      ],
    }
  }

  if (guardrail.preflight.state === 'running') {
    return {
      color: 'blue',
      title: '正在进行启动前检查',
      lines: [
        `安装环境：${stateLabel(guardrail.environment.state)}`,
        `Windows runtime：${stateLabel(guardrail.runtime.state)}`,
        `旧插件/旧配置：${stateLabel(guardrail.config.state)}`,
      ],
    }
  }

  if (guardrail.preflight.state === 'ok' && guardrail.spawn.state === 'ok') {
    return {
      color: 'green',
      title: '启动前检查已通过',
      lines: [
        '旧插件、旧配置和 Windows runtime 已完成校验。',
      ],
    }
  }

  return null
}

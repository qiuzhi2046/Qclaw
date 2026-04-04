import type { OpenClawInstallCandidate } from '../../src/shared/openclaw-phase1'
import type {
  OpenClawGuardedEnvWriteRequest,
  OpenClawGuardedWriteResult,
} from '../../src/shared/openclaw-phase2'
import { guardedWriteEnvFile } from './openclaw-config-guard'
import { resolveGatewayApplyAction } from './gateway-apply-policy'
import { applyGatewaySecretAction } from './gateway-secret-apply'
import { runCli } from './cli'

function appendMessage(baseMessage: string | undefined, extraMessage: string): string {
  const normalizedBase = String(baseMessage || '').trim()
  if (!normalizedBase) return extraMessage
  return `${normalizedBase} ${extraMessage}`
}

export async function guardedWriteEnvFileWithGatewayApply(
  request: OpenClawGuardedEnvWriteRequest,
  preferredCandidate?: OpenClawInstallCandidate | null
): Promise<OpenClawGuardedWriteResult> {
  const writeResult = await guardedWriteEnvFile(request, preferredCandidate)
  if (!writeResult.ok || !writeResult.wrote) {
    return writeResult
  }

  const changedEnvKeys = Object.keys(request.updates)
    .map((key) => String(key || '').trim())
    .filter(Boolean)

  const decision = resolveGatewayApplyAction({
    changedJsonPaths: [],
    changedEnvKeys,
  })

  if (decision.action === 'none') {
    return {
      ...writeResult,
      gatewayApply: {
        ok: true,
        requestedAction: 'none',
        appliedAction: 'none',
      },
    }
  }

  const applyResult = await applyGatewaySecretAction({
    requestedAction: decision.action,
    runCommand: (args, timeout) => runCli(args, timeout, 'config-write'),
  })

  if (!applyResult.ok) {
    return {
      ...writeResult,
      message: appendMessage(
        writeResult.message,
        `环境变量已保存，但运行状态同步失败（action=${decision.action}）。请稍后手动重载网关。`
      ),
      gatewayApply: applyResult,
    }
  }

  return {
    ...writeResult,
    gatewayApply: applyResult,
  }
}

import { runCli } from './cli'
import { appendEnvCheckDiagnostic } from './env-check-diagnostics'

export async function installGatewayServiceAfterSuccessfulOnboard(): Promise<void> {
  if (process.platform !== 'win32') return

  await appendEnvCheckDiagnostic('ipc-onboard-gateway-install-start', {
    platform: process.platform,
  }).catch(() => undefined)

  try {
    const result = await runCli(['gateway', 'install'], undefined, 'gateway')
    await appendEnvCheckDiagnostic('ipc-onboard-gateway-install-result', {
      ok: result.ok,
      code: result.code,
      stdout: truncateGatewayInstallDiagnosticText(result.stdout),
      stderr: truncateGatewayInstallDiagnosticText(result.stderr),
    }).catch(() => undefined)
  } catch (error) {
    await appendEnvCheckDiagnostic('ipc-onboard-gateway-install-failed', {
      message: error instanceof Error ? error.message : String(error),
    }).catch(() => undefined)
  }
}

function truncateGatewayInstallDiagnosticText(value: string | null | undefined): string | null {
  const normalized = String(value || '').trim()
  if (!normalized) return null
  return normalized.slice(0, 600)
}

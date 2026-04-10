const fs = process.getBuiltinModule('node:fs') as typeof import('node:fs')
const os = process.getBuiltinModule('node:os') as typeof import('node:os')
const path = process.getBuiltinModule('node:path') as typeof import('node:path')
const { appendFile, mkdir } = fs.promises
const { homedir } = os

function resolveUserDataDirectory(): string {
  return String(process.env.QCLAW_USER_DATA_DIR || path.join(homedir(), '.qclaw-lite')).trim()
}

export function resolveEnvCheckDiagnosticsLogPath(): string {
  return path.join(resolveUserDataDirectory(), 'runtime', 'qclaw-env-check-diag.jsonl')
}

function sanitizeDiagnosticFields(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined)
  )
}

export async function appendEnvCheckDiagnostic(
  event: string,
  fields: Record<string, unknown> = {}
): Promise<void> {
  try {
    const logPath = resolveEnvCheckDiagnosticsLogPath()
    await mkdir(path.dirname(logPath), { recursive: true })
    const payload = {
      ts: new Date().toISOString(),
      pid: process.pid,
      source: 'qclaw-env-check',
      event: String(event || '').trim() || 'unknown',
      ...sanitizeDiagnosticFields(fields),
    }
    await appendFile(logPath, `${JSON.stringify(payload)}\n`, 'utf8')
  } catch {
    // Best effort only. Diagnostics must never block env-check.
  }
}

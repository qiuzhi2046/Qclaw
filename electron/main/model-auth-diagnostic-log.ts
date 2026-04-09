const path = process.getBuiltinModule('node:path') as typeof import('node:path')
const fs = process.getBuiltinModule('node:fs/promises') as typeof import('node:fs/promises')
const { fileURLToPath } = process.getBuiltinModule('node:url') as typeof import('node:url')

export const MODEL_AUTH_DIAGNOSTIC_LOG_FILENAME = 'model-auth-diagnostic-trace.jsonl'

export interface ModelAuthDiagnosticLogEntry {
  source: string
  event: string
  providerId?: string
  methodId?: string
  attemptId?: string | number
  details?: Record<string, unknown>
}

function isModelAuthDiagnosticLoggingEnabled(): boolean {
  return String(process.env.QCLAW_MODEL_AUTH_DIAGNOSTIC || '').trim() === '1'
}

export function resolveModelAuthDiagnosticLogPath(baseDir?: string): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url))
  const rootDir = baseDir || path.resolve(moduleDir, '..', '..')
  return path.join(rootDir, 'docs', 'plans', MODEL_AUTH_DIAGNOSTIC_LOG_FILENAME)
}

export async function appendModelAuthDiagnosticLog(
  entry: ModelAuthDiagnosticLogEntry,
  options: { baseDir?: string } = {}
): Promise<string> {
  const logPath = resolveModelAuthDiagnosticLogPath(options.baseDir)
  if (!isModelAuthDiagnosticLoggingEnabled()) {
    return logPath
  }
  await fs.mkdir(path.dirname(logPath), { recursive: true })
  const payload = {
    ts: new Date().toISOString(),
    pid: process.pid,
    source: String(entry.source || '').trim() || 'unknown',
    event: String(entry.event || '').trim() || 'unknown',
    ...(String(entry.providerId || '').trim() ? { providerId: String(entry.providerId || '').trim() } : {}),
    ...(String(entry.methodId || '').trim() ? { methodId: String(entry.methodId || '').trim() } : {}),
    ...(entry.attemptId !== undefined && entry.attemptId !== null ? { attemptId: String(entry.attemptId) } : {}),
    ...(entry.details && typeof entry.details === 'object' ? { details: entry.details } : {}),
  }
  await fs.appendFile(logPath, `${JSON.stringify(payload)}\n`, 'utf8')
  return logPath
}

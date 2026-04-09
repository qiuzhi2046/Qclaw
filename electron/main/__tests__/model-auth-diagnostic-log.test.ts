import { afterEach, describe, expect, it } from 'vitest'
import {
  appendModelAuthDiagnosticLog,
  resolveModelAuthDiagnosticLogPath,
} from '../model-auth-diagnostic-log'

const { mkdtemp, readFile, stat } = process.getBuiltinModule('node:fs/promises') as typeof import('node:fs/promises')
const { tmpdir } = process.getBuiltinModule('node:os') as typeof import('node:os')
const path = process.getBuiltinModule('node:path') as typeof import('node:path')

const originalDiagnosticFlag = process.env.QCLAW_MODEL_AUTH_DIAGNOSTIC

describe('model auth diagnostic log', () => {
  afterEach(() => {
    if (originalDiagnosticFlag === undefined) {
      delete process.env.QCLAW_MODEL_AUTH_DIAGNOSTIC
      return
    }
    process.env.QCLAW_MODEL_AUTH_DIAGNOSTIC = originalDiagnosticFlag
  })

  it('does not write logs unless explicitly enabled', async () => {
    delete process.env.QCLAW_MODEL_AUTH_DIAGNOSTIC
    const baseDir = await mkdtemp(path.join(tmpdir(), 'model-auth-log-'))
    const logPath = resolveModelAuthDiagnosticLogPath(baseDir)

    await appendModelAuthDiagnosticLog(
      {
        source: 'test',
        event: 'sample',
        providerId: 'zai',
      },
      { baseDir }
    )

    const result = await stat(logPath).catch(() => null)
    expect(result).toBeNull()
  })

  it('writes jsonl entries under docs/plans', async () => {
    process.env.QCLAW_MODEL_AUTH_DIAGNOSTIC = '1'
    const baseDir = await mkdtemp(path.join(tmpdir(), 'model-auth-log-'))
    const logPath = resolveModelAuthDiagnosticLogPath(baseDir)

    await appendModelAuthDiagnosticLog(
      {
        source: 'test',
        event: 'sample',
        providerId: 'zai',
        details: { ok: true },
      },
      { baseDir }
    )

    const content = await readFile(logPath, 'utf8')
    const lines = content.trim().split('\n')
    expect(lines).toHaveLength(1)

    const parsed = JSON.parse(lines[0])
    expect(parsed.source).toBe('test')
    expect(parsed.event).toBe('sample')
    expect(parsed.providerId).toBe('zai')
    expect(parsed.details).toEqual({ ok: true })
  })
})

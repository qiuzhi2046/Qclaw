import { afterEach, describe, expect, it } from 'vitest'

import {
  buildGatewayLogSearchRoots,
  detectGatewayPluginLoadFailureEvidence,
} from '../gateway-startup-log-diagnostics'
import { buildTestEnv } from './test-env'

const fs = process.getBuiltinModule('node:fs') as typeof import('node:fs')
const os = process.getBuiltinModule('node:os') as typeof import('node:os')
const path = process.getBuiltinModule('node:path') as typeof import('node:path')

const tempDirs: string[] = []
const itOnWindows = process.platform === 'win32' ? it : it.skip

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qclaw-gateway-logs-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('buildGatewayLogSearchRoots', () => {
  itOnWindows('includes the managed Windows runtime logs dir before temp fallbacks', () => {
    const userDataDir = 'C:\\Users\\alice\\AppData\\Roaming\\Qclaw'

    const roots = buildGatewayLogSearchRoots({
      env: buildTestEnv({
        QCLAW_USER_DATA_DIR: userDataDir,
        TEMP: 'C:\\Users\\alice\\AppData\\Local\\Temp',
        TMP: 'C:\\Users\\alice\\AppData\\Local\\Temp',
      }),
      platform: 'win32',
      tmpDir: 'C:\\Users\\alice\\AppData\\Local\\Temp',
    })

    expect(roots[0]).toBe('C:\\Users\\alice\\AppData\\Roaming\\Qclaw\\runtime\\win32\\logs')
    expect(roots).toContain('C:\\Users\\alice\\AppData\\Local\\Temp\\openclaw')
  })
})

describe('detectGatewayPluginLoadFailureEvidence', () => {
  itOnWindows('reads plugin failure evidence from the managed Windows runtime logs dir', async () => {
    const rootDir = makeTempDir()
    const userDataDir = path.join(rootDir, 'userData')
    const logsDir = path.join(userDataDir, 'runtime', 'win32', 'logs')
    fs.mkdirSync(logsDir, { recursive: true })
    fs.writeFileSync(
      path.join(logsDir, 'openclaw-managed.log'),
      [
        'booting gateway',
        '[plugins] feishu failed to load from C:/Users/test/.openclaw/extensions/openclaw-lark/index.js',
      ].join('\n')
    )

    const evidence = await detectGatewayPluginLoadFailureEvidence({
      env: buildTestEnv({
        QCLAW_USER_DATA_DIR: userDataDir,
      }),
      platform: 'win32',
      tmpDir: path.join(rootDir, 'tmp'),
    })

    expect(evidence).toMatchObject({
      source: 'service',
      message: '网关日志显示扩展插件加载失败',
    })
    expect(evidence?.detail).toContain('failed to load')
  })
})

import { describe, expect, it } from 'vitest'
import {
  createPrivilegedOpenClawNpmCommandOptions,
  ensureManagedOpenClawNpmRuntime,
} from '../openclaw-npm-runtime'
const { mkdtemp, readFile } = process.getBuiltinModule('node:fs/promises') as typeof import('node:fs/promises')
const { tmpdir } = process.getBuiltinModule('node:os') as typeof import('node:os')
const path = process.getBuiltinModule('node:path') as typeof import('node:path')
const { join } = path

describe('openclaw-npm-runtime', () => {
  it('creates managed npm runtime files and returns stable command options', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'qclaw-openclaw-runtime-'))
    const runtime = await ensureManagedOpenClawNpmRuntime({
      workingDirectory: workspace,
      fetchTimeoutMs: 20000,
      fetchRetries: 1,
    })

    expect(runtime.userConfigPath).toContain('openclaw-installer')
    expect(runtime.globalConfigPath).toContain('openclaw-installer')
    expect(runtime.cachePath).toContain('openclaw-installer')
    expect(runtime.cachePath).toContain(`${path.sep}cache${path.sep}run-`)
    expect(runtime.commandOptions.fetchTimeoutMs).toBe(20000)
    expect(runtime.commandOptions.fetchRetries).toBe(1)
    expect(runtime.commandOptions.noAudit).toBe(true)
    expect(runtime.commandOptions.noFund).toBe(true)

    const content = await readFile(runtime.userConfigPath, 'utf8')
    expect(content).toContain('fund=false')
    expect(content).toContain('audit=false')
    expect(content).toContain('strict-ssl=true')
  })

  it('allocates a fresh cache directory for each managed runtime call', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'qclaw-openclaw-runtime-'))

    const first = await ensureManagedOpenClawNpmRuntime({
      workingDirectory: workspace,
    })
    const second = await ensureManagedOpenClawNpmRuntime({
      workingDirectory: workspace,
    })

    expect(first.rootDir).toBe(second.rootDir)
    expect(first.userConfigPath).toBe(second.userConfigPath)
    expect(first.globalConfigPath).toBe(second.globalConfigPath)
    expect(first.cachePath).not.toBe(second.cachePath)
    expect(first.cachePath).toContain(`${path.sep}cache${path.sep}run-`)
    expect(second.cachePath).toContain(`${path.sep}cache${path.sep}run-`)
  })

  it('creates isolated admin cache options outside the managed runtime root', () => {
    const managedCachePath = '/tmp/openclaw-installer/npm/cache/run-user'
    const options = createPrivilegedOpenClawNpmCommandOptions(
      {
        userConfigPath: '/tmp/openclaw-installer/npm/user.npmrc',
        globalConfigPath: '/tmp/openclaw-installer/npm/global.npmrc',
        cachePath: managedCachePath,
        fetchTimeoutMs: 30000,
        fetchRetries: 2,
        noAudit: true,
        noFund: true,
      },
      {
        platform: 'darwin',
        tempDir: '/private/tmp',
        uuidFactory: () => 'admin-run',
      }
    )

    expect(options.cachePath).toBe('/private/tmp/qclaw-openclaw-admin-npm-admin-run/cache')
    expect(options.cachePath).not.toContain('/tmp/openclaw-installer/npm/cache')
    expect(options.userConfigPath).toBe('/tmp/openclaw-installer/npm/user.npmrc')
    expect(options.globalConfigPath).toBe('/tmp/openclaw-installer/npm/global.npmrc')
  })
})

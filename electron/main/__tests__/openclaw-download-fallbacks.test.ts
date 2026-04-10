import { describe, expect, it, vi } from 'vitest'
import {
  OPENCLAW_NPM_REGISTRY_MIRRORS,
  attachOpenClawMirrorFailureDetails,
  buildOpenClawConfigGetPrefixArgs,
  buildMirrorAwareTimeoutMs,
  buildOpenClawInstallArgs,
  buildOpenClawManualInstallCommands,
  buildOpenClawUninstallArgs,
  normalizeOpenClawVersionTag,
  runOpenClawNpmRegistryFallback,
} from '../openclaw-download-fallbacks'

describe('openclaw-download-fallbacks', () => {
  it('does not include the deprecated aliyun npm mirror in fallback order', () => {
    expect(OPENCLAW_NPM_REGISTRY_MIRRORS.map((mirror) => mirror.id)).toEqual([
      'npmmirror',
      'tencent',
      'huawei',
      'npmjs',
    ])
  })

  it('retries npm registries in order and stops at first success', async () => {
    const runner = vi.fn(async (mirror: (typeof OPENCLAW_NPM_REGISTRY_MIRRORS)[number]) => {
      if (mirror.id === 'npmmirror') {
        return { ok: false, stdout: '', stderr: 'connect timeout', code: 1 }
      }
      return { ok: true, stdout: 'installed', stderr: '', code: 0 }
    })

    const outcome = await runOpenClawNpmRegistryFallback(runner)

    expect(outcome.result.ok).toBe(true)
    expect(outcome.attempts).toHaveLength(2)
    expect(outcome.attempts[0].mirror.id).toBe('npmmirror')
    expect(outcome.attempts[1].mirror.id).toBe('tencent')
  })

  it('stops retrying mirrors once a command is canceled', async () => {
    const runner = vi.fn(async (mirror: (typeof OPENCLAW_NPM_REGISTRY_MIRRORS)[number]) => {
      if (mirror.id === 'npmjs') {
        return { ok: false, stdout: '', stderr: 'Command canceled', code: null, canceled: true }
      }
      return { ok: false, stdout: '', stderr: 'should not retry', code: 1 }
    })

    const outcome = await runOpenClawNpmRegistryFallback(runner)

    expect(outcome.result.canceled).toBe(true)
    expect(outcome.attempts).toHaveLength(4)
    expect(outcome.attempts.at(-1)?.mirror.id).toBe('npmjs')
    expect(outcome.attempts.some((attempt) => attempt.mirror.id === 'aliyun')).toBe(false)
    expect(runner).toHaveBeenCalledTimes(4)
  })

  it('builds openclaw install args with optional --registry', () => {
    expect(buildOpenClawInstallArgs('latest')).toEqual(['install', '-g', 'openclaw@latest'])
    expect(buildOpenClawInstallArgs('2026.3.19', 'https://registry.npmmirror.com')).toEqual([
      'install',
      '-g',
      'openclaw@2026.3.19',
      '--registry=https://registry.npmmirror.com',
    ])
  })

  it('defaults manual install commands to the pinned openclaw version', () => {
    const commands = buildOpenClawManualInstallCommands()

    expect(commands).toHaveLength(OPENCLAW_NPM_REGISTRY_MIRRORS.length)
    expect(commands[0]).toContain('openclaw@2026.3.24')
    expect(commands.every((command) => !command.includes('openclaw@latest'))).toBe(true)
  })

  it('builds openclaw install args with managed npm runtime options', () => {
    expect(
      buildOpenClawInstallArgs('2026.3.19', 'https://registry.npmmirror.com', {
        userConfigPath: '/tmp/openclaw-installer/npm/user.npmrc',
        globalConfigPath: '/tmp/openclaw-installer/npm/global.npmrc',
        prefixPath: '/tmp/qclaw-private-node',
        cachePath: '/tmp/openclaw-installer/npm/cache',
        fetchTimeoutMs: 30000,
        fetchRetries: 2,
        noAudit: true,
        noFund: true,
      })
    ).toEqual([
      'install',
      '-g',
      'openclaw@2026.3.19',
      '--registry=https://registry.npmmirror.com',
      '--userconfig=/tmp/openclaw-installer/npm/user.npmrc',
      '--globalconfig=/tmp/openclaw-installer/npm/global.npmrc',
      '--prefix=/tmp/qclaw-private-node',
      '--cache=/tmp/openclaw-installer/npm/cache',
      '--fetch-timeout=30000',
      '--fetch-retries=2',
      '--no-audit',
      '--no-fund',
    ])
  })

  it('builds npm config get prefix args with the same managed config files', () => {
    expect(
      buildOpenClawConfigGetPrefixArgs({
        userConfigPath: '/tmp/openclaw-installer/npm/user.npmrc',
        globalConfigPath: '/tmp/openclaw-installer/npm/global.npmrc',
        prefixPath: '/tmp/qclaw-private-node',
        cachePath: '/tmp/openclaw-installer/npm/cache',
        fetchTimeoutMs: 30000,
        fetchRetries: 2,
        noAudit: true,
        noFund: true,
      })
    ).toEqual([
      'config',
      'get',
      'prefix',
      '--userconfig=/tmp/openclaw-installer/npm/user.npmrc',
      '--globalconfig=/tmp/openclaw-installer/npm/global.npmrc',
      '--prefix=/tmp/qclaw-private-node',
    ])
  })

  it('builds openclaw uninstall args with managed npm runtime options', () => {
    expect(
      buildOpenClawUninstallArgs({
        userConfigPath: '/tmp/openclaw-installer/npm/user.npmrc',
        globalConfigPath: '/tmp/openclaw-installer/npm/global.npmrc',
        prefixPath: '/tmp/qclaw-private-node',
        cachePath: '/private/tmp/qclaw-openclaw-admin-npm/cache',
        fetchTimeoutMs: 30000,
        fetchRetries: 2,
      })
    ).toEqual([
      'uninstall',
      '-g',
      'openclaw',
      '--userconfig=/tmp/openclaw-installer/npm/user.npmrc',
      '--globalconfig=/tmp/openclaw-installer/npm/global.npmrc',
      '--prefix=/tmp/qclaw-private-node',
      '--cache=/private/tmp/qclaw-openclaw-admin-npm/cache',
      '--fetch-timeout=30000',
      '--fetch-retries=2',
    ])
  })

  it('rejects invalid openclaw version tags', () => {
    expect(() => normalizeOpenClawVersionTag('2026.3.19;rm -rf /')).toThrow('Invalid openclaw version')
    expect(() => buildOpenClawInstallArgs('2026.3.19;rm -rf /')).toThrow('Invalid openclaw version')
  })

  it('appends mirror diagnostics and manual fallback commands to failed result', () => {
    const result = attachOpenClawMirrorFailureDetails(
      {
        ok: false,
        stdout: '',
        stderr: 'npm view failed',
        code: 1,
      },
      [
        {
          mirror: OPENCLAW_NPM_REGISTRY_MIRRORS[0],
          result: {
            ok: false,
            stdout: '',
            stderr: 'ETIMEDOUT',
            code: 1,
          },
        },
      ],
      {
        operationLabel: 'OpenClaw 最新版本查询',
      }
    )

    expect(result.stderr).toContain('OpenClaw 最新版本查询失败')
    expect(result.stderr).toContain('npm config set registry https://registry.npmmirror.com')
    expect(result.stderr).toContain('git clone https://gitclone.com/github.com/pjasicek/OpenClaw.git')
  })

  it('adds tls certificate guidance when attempts include certificate failures', () => {
    const result = attachOpenClawMirrorFailureDetails(
      {
        ok: false,
        stdout: '',
        stderr: 'npm install failed',
        code: 1,
      },
      [
        {
          mirror: OPENCLAW_NPM_REGISTRY_MIRRORS[0],
          result: {
            ok: false,
            stdout: '',
            stderr: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
            code: 1,
          },
        },
      ],
      {
        operationLabel: 'OpenClaw CLI 安装',
      }
    )

    expect(result.stderr).toContain('检测到 TLS 证书链校验失败')
    expect(result.stderr).toContain('unset NODE_OPTIONS')
    expect(result.stderr).toContain('export SSL_CERT_FILE=/etc/ssl/cert.pem')
  })

  it('scales timeout budget with mirror attempt count', () => {
    expect(buildMirrorAwareTimeoutMs(180_000, 1)).toBe(180_000)
    expect(buildMirrorAwareTimeoutMs(180_000, 5)).toBe(612_000)
  })
})

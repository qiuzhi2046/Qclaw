import { describe, expect, it } from 'vitest'

const fs = process.getBuiltinModule('node:fs') as typeof import('node:fs')
const path = process.getBuiltinModule('node:path') as typeof import('node:path')

describe('weixin installer session source', () => {
  it('does not keep an unsupported force retry path for the personal weixin installer', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'electron', 'main', 'weixin-installer-session.ts'),
      'utf8'
    )

    expect(source).not.toContain("const WEIXIN_INSTALLER_FORCE_COMMAND = ['npx', '-y', WEIXIN_INSTALLER_PACKAGE, 'install', '--force'] as const")
    expect(source).not.toContain("type: 'started' | 'output' | 'exit' | 'force-retry-started'")
    expect(source).not.toContain("activeSession.output += '\\n--- force 模式重试 ---\\n'")
  })

  it('waits for the personal weixin installer to exit on its own instead of forcing a 90 second timeout', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'electron', 'main', 'weixin-installer-session.ts'),
      'utf8'
    )

    expect(source).not.toContain('const WEIXIN_INSTALLER_INITIAL_TIMEOUT_MS = 90_000')
    expect(source).not.toContain('timeout: WEIXIN_INSTALLER_INITIAL_TIMEOUT_MS')
    expect(source).not.toContain('MAIN_RUNTIME_POLICY.cli.pluginInstallNpxTimeoutMs')
  })

  it('prepares the weixin config before launching the installer so duplicate managed entries do not loop warnings', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'electron', 'main', 'weixin-installer-session.ts'),
      'utf8'
    )

    expect(source).toContain('prepareWeixinInstallerConfig')
    expect(source).toContain('await prepareConfigForWeixinInstaller()')
  })

  it('launches the personal weixin installer with the shared managed npm runtime instead of ad-hoc env wiring', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'electron', 'main', 'weixin-installer-session.ts'),
      'utf8'
    )

    expect(source).toContain('ensureManagedOpenClawNpmRuntime')
    expect(source).toContain('runtime.commandOptions')
    expect(source).not.toContain('sanitizeManagedInstallerEnv')
  })

  it('reuses the shared registry fallback helper instead of keeping a local mirror retry state machine', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'electron', 'main', 'weixin-installer-session.ts'),
      'utf8'
    )

    expect(source).toContain('runOpenClawNpmRegistryFallback')
    expect(source).not.toContain('const WEIXIN_INSTALLER_REGISTRY_ATTEMPTS =')
    expect(source).not.toContain('function resolveWeixinInstallerMirror(')
    expect(source).not.toContain('spawnAttempt(attemptIndex + 1, false)')
  })

  it('routes the personal weixin installer through the shared managed npm runtime and shell runner', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'electron', 'main', 'weixin-installer-session.ts'),
      'utf8'
    )

    expect(source).toContain('ensureManagedOpenClawNpmRuntime')
    expect(source).toContain('runShellStreaming')
    expect(source).toContain("controlDomain: WEIXIN_INSTALLER_CONTROL_DOMAIN")
    expect(source).not.toContain("const { spawn } = childProcess")
    expect(source).not.toContain("spawn(WEIXIN_INSTALLER_COMMAND[0], WEIXIN_INSTALLER_COMMAND.slice(1)")
  })

  it('prefers the command capability resolved path when launching npx', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'electron', 'main', 'weixin-installer-session.ts'),
      'utf8'
    )

    expect(source).toContain('capability.resolvedPath')
    expect(source).toContain('buildCommandCapabilityEnv()')
  })
})

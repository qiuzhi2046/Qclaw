import { describe, expect, it } from 'vitest'

const fs = process.getBuiltinModule('node:fs') as typeof import('node:fs')
const path = process.getBuiltinModule('node:path') as typeof import('node:path')

describe('feishu installer session source', () => {
  it('waits for the interactive feishu installer to exit on its own instead of enforcing a total runtime timeout', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'electron', 'main', 'feishu-installer-session.ts'),
      'utf8'
    )

    expect(source).not.toContain('timeout: MAIN_RUNTIME_POLICY.cli.pluginInstallNpxTimeoutMs')
  })

  it('prefers the command capability resolved path when spawning npx', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'electron', 'main', 'feishu-installer-session.ts'),
      'utf8'
    )

    expect(source).toContain('capability.resolvedPath')
    expect(source).toContain('buildCommandCapabilityEnv()')
  })
})

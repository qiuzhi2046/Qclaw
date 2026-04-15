import { describe, expect, it } from 'vitest'

const fs = process.getBuiltinModule('node:fs') as typeof import('node:fs')
const path = process.getBuiltinModule('node:path') as typeof import('node:path')

describe('weixin installer session', () => {
  it('does not attach a fixed timeout to the interactive personal WeChat installer', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'electron', 'main', 'weixin-installer-session.ts'),
      'utf-8'
    )

    expect(source).toContain('spawn(WEIXIN_INSTALLER_COMMAND[0]')
    expect(source).not.toContain('timeout: MAIN_RUNTIME_POLICY.cli.pluginInstallNpxTimeoutMs')
  })
})

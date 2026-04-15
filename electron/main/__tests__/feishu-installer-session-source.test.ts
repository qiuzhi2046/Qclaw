import { describe, expect, it } from 'vitest'

const fs = process.getBuiltinModule('node:fs') as typeof import('node:fs')
const path = process.getBuiltinModule('node:path') as typeof import('node:path')
const source = fs.readFileSync(
  path.join(process.cwd(), 'electron/main/feishu-installer-session.ts'),
  'utf8'
)

describe('feishu installer session source', () => {
  it('stops gateway before preparing installer config and finalizes success after installer exit', () => {
    expect(source).toContain("stopGatewayIfOwned('feishu-installer-start')")
    expect(source).toContain('applyGatewayPolicy: false')
    expect(source).toContain('ensureFeishuOfficialPluginReady()')
  })
})

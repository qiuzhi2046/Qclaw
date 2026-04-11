import { describe, expect, it } from 'vitest'

const fs = process.getBuiltinModule('node:fs') as typeof import('node:fs')
const source = fs.readFileSync('G:\\Qclaw-deving\\electron\\main\\feishu-installer-session.ts', 'utf8')

describe('feishu installer session source', () => {
  it('stops gateway before preparing installer config and finalizes success after installer exit', () => {
    expect(source).toContain("stopGatewayIfOwned('feishu-installer-start')")
    expect(source).toContain('applyGatewayPolicy: false')
    expect(source).toContain('ensureFeishuOfficialPluginReady()')
  })
})

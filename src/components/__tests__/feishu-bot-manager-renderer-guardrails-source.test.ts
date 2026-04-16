import { describe, expect, it } from 'vitest'

const fs = process.getBuiltinModule('node:fs') as typeof import('node:fs')
const path = process.getBuiltinModule('node:path') as typeof import('node:path')

describe('FeishuBotManagerModal renderer guardrails', () => {
  it('renders installer guardrails and avoids background config healing writes', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src', 'components', 'FeishuBotManagerModal.tsx'),
      'utf8'
    )

    expect(source).toContain("import { resolveChannelInstallerGuardrailView } from '../lib/channel-installer-guardrail'")
    expect(source).toContain('const [feishuConfigNotice, setFeishuConfigNotice] = useState')
    expect(source).toContain('const [feishuInstallerGuardrail, setFeishuInstallerGuardrail]')
    expect(source).toContain('setFeishuInstallerGuardrail(snapshot.guardrail || null)')
    expect(source).toContain('setFeishuInstallerGuardrail(payload.guardrail || null)')
    expect(source).toContain('需要显式同步飞书配置')
    expect(source).not.toContain('Keep the in-memory list even if background healing fails')
    expect(source).not.toContain('background healing')
  })

  it('retains owned successful exits long enough to finalize on reopen while still clearing unrelated stale sessions', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src', 'components', 'FeishuBotManagerModal.tsx'),
      'utf8'
    )

    expect(source).toContain('ownedFeishuCreateSessionId')
    expect(source).toContain('ownedFeishuCreateSessionSource')
    expect(source).toContain('isOwnedFeishuManagerCreateSession')
    expect(source).toContain('snapshotMatchesOwnedSession')
    expect(source).toContain('if (snapshot.active && snapshotSessionId)')
    expect(source).toContain('shouldRetainExitedOwnedFeishuManagerCreateSession')
    expect(source).toContain('shouldRetainOwnedFeishuManagerCreateSessionWhileHidden')
    expect(source).toContain('showOwnedFeishuCreateSessionSurface')
    expect(source).toContain('当前没有正在进行的飞书新建会话')
  })

  it('finalizes owned create sessions through the same merge and auto-pair recovery path as channel connect', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src', 'components', 'FeishuBotManagerModal.tsx'),
      'utf8'
    )

    expect(source).toContain('captureFeishuBotConfigSnapshot')
    expect(source).toContain('mergeFeishuCreateModeBots')
    expect(source).toContain('mergeFeishuPairingAllowFromUsersIntoConfig')
    expect(source).toContain('resolveFeishuInstallerAutoPairOpenId')
    expect(source).toContain('finalizeOwnedFeishuCreateSession')
    expect(source).toContain("window.api.pairingAddAllowFrom(")
    expect(source).toContain("ensureGatewayReadyForChannelConnect(window.api")
    expect(source).toContain('handledOwnedFeishuCreateSessionIdRef')
  })
})

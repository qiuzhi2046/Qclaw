import { describe, expect, it } from 'vitest'

const fs = process.getBuiltinModule('node:fs') as typeof import('node:fs')
const path = process.getBuiltinModule('node:path') as typeof import('node:path')

function readChannelConnectSource(): string {
  return fs.readFileSync(
    path.join(process.cwd(), 'src', 'pages', 'ChannelConnect.tsx'),
    'utf8'
  )
}

describe('ChannelConnect renderer guardrails', () => {
  it('renders installer guardrail views for Feishu and Weixin from structured state', () => {
    const source = readChannelConnectSource()

    expect(source).toContain("import { resolveChannelInstallerGuardrailView } from '../lib/channel-installer-guardrail'")
    expect(source).toContain('const [feishuInstallerGuardrail, setFeishuInstallerGuardrail]')
    expect(source).toContain('const [weixinInstallerGuardrail, setWeixinInstallerGuardrail]')
    expect(source).toContain('const feishuGuardrailView = useMemo(')
    expect(source).toContain('const weixinGuardrailView = useMemo(')
    expect(source).toContain('const hasBlockingFeishuGuardrailFailure = Boolean(feishuInstallerGuardrail?.failure)')
    expect(source).toContain('const feishuInstallerFailureView = showFeishuCreateInstallerArtifacts && !hasBlockingFeishuGuardrailFailure')
    expect(source).toContain('setFeishuInstallerGuardrail(snapshot.guardrail || null)')
    expect(source).toContain('setWeixinInstallerGuardrail(snapshot.guardrail || null)')
    expect(source).toContain('setFeishuInstallerGuardrail(payload.guardrail || null)')
    expect(source).toContain('setWeixinInstallerGuardrail(payload.guardrail || null)')
  })

  it('does not silently heal Feishu config from background refresh paths', () => {
    const source = readChannelConnectSource()

    expect(source).not.toContain('channel-connect-feishu-sync-config')
    expect(source).not.toContain('channel-connect-feishu-auto-recovery-heal')
    expect(source).not.toContain('Keep using the normalized in-memory state even if self-healing writes fail.')
    expect(source).toContain('不会在后台静默写入 managed channel 配置')
    expect(source).toContain('需要显式同步')
  })

  it('lets the Weixin backend installer own managed plugin preflight state', () => {
    const source = readChannelConnectSource()

    expect(source).not.toContain("channel: getChannelDefinition('openclaw-weixin')")
    expect(source).toContain('const snapshot = await window.api.startWeixinInstaller()')
    expect(source).toContain('applyWeixinInstallerSnapshot(snapshot)')
  })

  it('keeps Feishu create session ownership separate from recovered-config readiness', () => {
    const source = readChannelConnectSource()

    expect(source).toContain('ownedFeishuCreateSessionId')
    expect(source).toContain('ownedFeishuCreateSessionSource')
    expect(source).toContain('configRecoveredFeishuCreateReady')
    expect(source).toContain('isStaleExitedFeishuSession')
    expect(source).toContain('canFinishFeishuRecoveredCreateWithoutSession')
  })

  it('does not auto-open the Feishu QR modal for arbitrary stale ASCII output', () => {
    const source = readChannelConnectSource()

    expect(source).not.toMatch(/if \(feishuInstallerAsciiQr\.length > 0\) \{\s*setShowFeishuQrModal\(true\)\s*\}/)
    expect(source).toContain('shouldAutoOpenFeishuQrModal({')
    expect(source).toContain('showOwnedCreateSessionSurface')
    expect(source).toContain('installerRunning: feishuInstallerRunning')
    expect(source).toContain('{showFeishuCreateInstallerArtifacts && (')
  })

  it('keeps sessionless refresh recovery manual-only instead of auto-finishing stale sessions', () => {
    const source = readChannelConnectSource()

    expect(source).toContain('setConfigRecoveredFeishuCreateReady(true)')
    expect(source).toContain('当前没有可继续复用的安装器会话，你可以点击“完成配置”收口这次新建流程')
    expect(source).toContain('showOwnedCreateSessionSurface: showOwnedFeishuCreateSessionSurface')
  })
})

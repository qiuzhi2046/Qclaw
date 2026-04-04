import { describe, expect, it } from 'vitest'

const fs = process.getBuiltinModule('node:fs') as typeof import('node:fs')
const path = process.getBuiltinModule('node:path') as typeof import('node:path')

function readDashboardChatPanelSource(): string {
  return fs.readFileSync(
    path.join(process.cwd(), 'src', 'components', 'dashboard', 'DashboardChatPanel.tsx'),
    'utf8'
  )
}

describe('dashboard chat panel guardrails', () => {
  it('keeps the new-chat entrypoint on the upstream-aware createChatSession flow', () => {
    const source = readDashboardChatPanelSource()
    const handleCreateSessionBlock =
      source.match(/const handleCreateSession = async \(\) => \{[\s\S]*?\n  \}/)?.[0] || ''

    expect(handleCreateSessionBlock).toContain('window.api.createChatSession()')
    expect(handleCreateSessionBlock).not.toContain('window.api.createLocalChatSession()')
  })

  it('does not expose session metadata or routing notices in the user-facing chat surface', () => {
    const source = readDashboardChatPanelSource()
    const headerBlock =
      source.match(/<Group gap="xs">[\s\S]*?<\/Text>\n        <\/div>/)?.[0] || ''

    expect(headerBlock).not.toContain('currentSessionModelLabel')
    expect(headerBlock).not.toContain('sessionModelPresentation.modeLabel')
    expect(headerBlock).not.toContain('activeSessionStatus.sessionSource')

    expect(source).not.toContain('{activeSessionStatus.notice && (')
    expect(source).not.toContain('activeSessionStatus.notice ||')
  })

  it('does not expose the session diagnostics toggle in the user-facing toolbar', () => {
    const source = readDashboardChatPanelSource()

    expect(source).not.toContain("label={showDiagnostics ? '收起诊断' : '会话诊断'}")
    expect(source).not.toContain('IconActivityHeartbeat')
  })

  it('keeps the composer footer free of session continuation status text', () => {
    const source = readDashboardChatPanelSource()

    expect(source).not.toContain("activeSessionStatus.willForkOnSend ? '新会话' : '继续会话'")
    expect(source).not.toContain('首次发送时自动创建会话')
  })

  it('does not keep the redundant direct-chat helper copy or session metadata copy', () => {
    const source = readDashboardChatPanelSource()

    expect(source).not.toContain('直接对话')
    expect(source).not.toContain('展示最近 OpenClaw / Qclaw 会话，并明确区分本地会话与历史来源会话。')
    expect(source).not.toContain('当前会话暂不支持切换模型 · Enter 发送 · Shift+Enter 换行')
    expect(source).not.toContain('当前渠道会话暂不支持在这里原地切模型')
    expect(source).not.toContain('历史模型：')
    expect(source).not.toContain('session.sessionId.slice(0, 8)')
    expect(source).not.toContain('formatSessionUsage(session)')
    expect(source).not.toContain('historySummary.modelDetail &&')
    expect(source).not.toContain('session.modelSwitchBlockedReason')
    expect(source).not.toContain('{composerHint}')
  })

  it('keeps the session model placeholder copy readable for first-message flows', () => {
    const source = readDashboardChatPanelSource()

    expect(source).toContain('发送首条消息后可切换')
    expect(source).not.toContain('\uFFFD')
  })
})

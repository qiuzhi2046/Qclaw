import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MantineProvider } from '@mantine/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Dashboard from '../Dashboard'
import {
  buildDashboardPluginRepairOptions,
  DASHBOARD_PLUGIN_ACTIONS,
  ensureDashboardPluginGatewayReadyAfterReload,
  getDashboardPluginCenterTriggerLabel,
  hasVerifiedManagedChannelInstall,
  resolveDashboardFeishuPluginActionPlan,
  selectDashboardPluginRepairResult,
  shouldReloadGatewayAfterDashboardPluginInstall,
  shouldResetDashboardPluginCenterStateOnClose,
  shouldResetDashboardPluginCenterStateOnOpen,
  waitForDashboardWeixinInstallerCompletion,
} from '../Dashboard'
import type { DashboardEntrySnapshot } from '../../shared/dashboard-entry-bootstrap'
import { buildManagedChannelRepairOutcome } from '../../shared/managed-channel-repair'

interface TestRepairIncompatiblePluginsResult {
  ok: boolean
  repaired: boolean
  incompatiblePlugins: Array<{
    pluginId: string
    packageName: string
    installPath: string
    displayInstallPath: string
    reason: string
  }>
  quarantinedPluginIds: string[]
  prunedPluginIds: string[]
  summary: string
  stderr: string
}

interface TestWeixinInstallerSessionSnapshot {
  active: boolean
  sessionId: string | null
  phase: 'idle' | 'running' | 'exited'
  output: string
  code: number | null
  ok: boolean
  canceled: boolean
  command: string[]
  beforeAccountIds: string[]
  afterAccountIds: string[]
  newAccountIds: string[]
}

interface TestWeixinInstallerSessionEvent {
  sessionId: string
  type: 'started' | 'output' | 'exit'
  ok?: boolean
  canceled?: boolean
  newAccountIds?: string[]
}

function createPluginRepairResult(
  overrides: Partial<TestRepairIncompatiblePluginsResult> = {}
): TestRepairIncompatiblePluginsResult {
  return {
    ok: true,
    repaired: false,
    incompatiblePlugins: [],
    quarantinedPluginIds: [],
    prunedPluginIds: [],
    summary: '',
    stderr: '',
    ...overrides,
  }
}

function createWeixinSnapshot(
  overrides: Partial<TestWeixinInstallerSessionSnapshot> = {}
): TestWeixinInstallerSessionSnapshot {
  return {
    active: false,
    sessionId: null,
    phase: 'idle',
    output: '',
    code: null,
    ok: false,
    canceled: false,
    command: ['npx', '-y', '@tencent-weixin/openclaw-weixin-cli@latest', 'install'],
    beforeAccountIds: [],
    afterAccountIds: [],
    newAccountIds: [],
    ...overrides,
  }
}

function createEntrySnapshot(
  overrides: Partial<DashboardEntrySnapshot> = {}
): DashboardEntrySnapshot {
  return {
    gatewayRunning: true,
    config: {
      channels: {},
    },
    pairingSummary: null,
    modelStatus: {},
    loadedAt: '2026-03-27T00:00:00.000Z',
    ...overrides,
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('dashboard plugin center helpers', () => {
  it('routes feishu and dingtalk through the shared official adapter while keeping weixin on the dedicated installer', () => {
    const feishuAction = DASHBOARD_PLUGIN_ACTIONS.find((action) => action.id === 'feishu')
    const dingtalkAction = DASHBOARD_PLUGIN_ACTIONS.find((action) => action.id === 'dingtalk')
    const qqAction = DASHBOARD_PLUGIN_ACTIONS.find((action) => action.id === 'qqbot')
    const weixinAction = DASHBOARD_PLUGIN_ACTIONS.find((action) => action.id === 'openclaw-weixin')

    expect(feishuAction?.installKind).toBe('official-adapter')
    expect(dingtalkAction?.installKind).toBe('official-adapter')
    expect(qqAction?.expectedPluginIds).toEqual(['openclaw-qqbot', 'qqbot'])
    expect(weixinAction?.installKind).toBe('weixin-installer')
  })

  it('checks feishu plugin state before deciding whether to skip, repair, or install', () => {
    expect(resolveDashboardFeishuPluginActionPlan({
      installedOnDisk: true,
      officialPluginConfigured: true,
      configChanged: false,
    })).toBe('ready')

    expect(resolveDashboardFeishuPluginActionPlan({
      installedOnDisk: true,
      officialPluginConfigured: false,
      configChanged: false,
    })).toBe('repair')

    expect(resolveDashboardFeishuPluginActionPlan({
      installedOnDisk: true,
      officialPluginConfigured: true,
      configChanged: true,
    })).toBe('repair')

    expect(resolveDashboardFeishuPluginActionPlan({
      installedOnDisk: false,
      officialPluginConfigured: false,
      configChanged: false,
    })).toBe('install')
  })

  it('keeps the extra gateway reload only for the personal weixin installer flow', () => {
    const feishuAction = DASHBOARD_PLUGIN_ACTIONS.find((action) => action.id === 'feishu')
    const dingtalkAction = DASHBOARD_PLUGIN_ACTIONS.find((action) => action.id === 'dingtalk')
    const wecomAction = DASHBOARD_PLUGIN_ACTIONS.find((action) => action.id === 'wecom')
    const weixinAction = DASHBOARD_PLUGIN_ACTIONS.find((action) => action.id === 'openclaw-weixin')

    expect(feishuAction).toBeTruthy()
    expect(dingtalkAction).toBeTruthy()
    expect(wecomAction).toBeTruthy()
    expect(weixinAction).toBeTruthy()
    expect(shouldReloadGatewayAfterDashboardPluginInstall(feishuAction!)).toBe(false)
    expect(shouldReloadGatewayAfterDashboardPluginInstall(dingtalkAction!)).toBe(false)
    expect(shouldReloadGatewayAfterDashboardPluginInstall(wecomAction!)).toBe(false)
    expect(shouldReloadGatewayAfterDashboardPluginInstall(weixinAction!)).toBe(true)
  })

  it('formats unified managed repair results into a plugin center outcome', () => {
    const outcome = buildManagedChannelRepairOutcome({
      kind: 'ok',
      channelId: 'dingtalk',
      pluginScope: 'channel',
      entityScope: 'channel',
      action: 'installed',
      status: {
        channelId: 'dingtalk',
        pluginId: 'dingtalk-connector',
        summary: '钉钉官方插件已修复；loaded / ready 仍待上游证据。',
        stages: [],
        evidence: [],
      },
    })

    expect(outcome.ok).toBe(true)
    expect(outcome.summary).toBe('钉钉官方插件已修复；loaded / ready 仍待上游证据。')
    expect(outcome.log).toContain('钉钉官方插件已修复；loaded / ready 仍待上游证据。')
  })

  it('turns interactive-installer repairs into a follow-up action instead of a hard error', () => {
    const outcome = buildManagedChannelRepairOutcome({
      kind: 'manual-action-required',
      channelId: 'openclaw-weixin',
      pluginScope: 'channel',
      entityScope: 'account',
      action: 'launch-interactive-installer',
      reason: '该渠道需要交互式安装器，不能通过后台修复自动完成。',
      status: {
        channelId: 'openclaw-weixin',
        pluginId: 'openclaw-weixin',
        summary: '微信插件仍待交互式安装器完成安装。',
        stages: [],
        evidence: [],
      },
    })

    expect(outcome.ok).toBe(true)
    expect(outcome.nextAction).toBe('launch-interactive-installer')
    expect(outcome.log).toContain('交互式安装器')
  })

  it('keeps the plugin center manually closable while preserving running state', () => {
    expect(getDashboardPluginCenterTriggerLabel(false)).toBe('修复插件环境')
    expect(getDashboardPluginCenterTriggerLabel(true)).toBe('查看插件修复进度')
    expect(shouldResetDashboardPluginCenterStateOnClose(false)).toBe(true)
    expect(shouldResetDashboardPluginCenterStateOnClose(true)).toBe(false)
    expect(shouldResetDashboardPluginCenterStateOnOpen(false, false)).toBe(true)
    expect(shouldResetDashboardPluginCenterStateOnOpen(false, true)).toBe(false)
    expect(shouldResetDashboardPluginCenterStateOnOpen(true, false)).toBe(false)
  })

  it('prefers the plugin center repair result over the prop repair result', () => {
    const propResult = createPluginRepairResult({
      ok: true,
      summary: 'prop result',
    })
    const localResult = createPluginRepairResult({
      ok: false,
      summary: 'local result',
    })

    expect(selectDashboardPluginRepairResult(propResult, localResult)).toBe(localResult)
    expect(selectDashboardPluginRepairResult(propResult, null)).toBe(propResult)
    expect(selectDashboardPluginRepairResult(null, null)).toBeNull()
  })

  it('scopes plugin center repair to the selected plugin aliases only', () => {
    const feishuAction = DASHBOARD_PLUGIN_ACTIONS.find((action) => action.id === 'feishu')
    const dingtalkAction = DASHBOARD_PLUGIN_ACTIONS.find((action) => action.id === 'dingtalk')

    expect(buildDashboardPluginRepairOptions(feishuAction!)).toEqual({
      scopePluginIds: ['openclaw-lark', 'feishu', 'feishu-openclaw-plugin'],
      quarantineOfficialManagedPlugins: true,
    })
    expect(buildDashboardPluginRepairOptions(dingtalkAction!)).toEqual({
      scopePluginIds: ['dingtalk-connector', 'dingtalk'],
      quarantineOfficialManagedPlugins: true,
    })
  })

  it('keeps the plugin center trigger clickable during startup auto repair', () => {
    const html = renderToStaticMarkup(
      createElement(
        MantineProvider,
        {},
        createElement(Dashboard, {
          entrySnapshot: createEntrySnapshot(),
          pluginRepairRunning: true,
        })
      )
    )

    const triggerIndex = html.indexOf('修复插件环境')
    expect(triggerIndex).toBeGreaterThan(-1)
    const triggerMarkup = html.slice(Math.max(0, triggerIndex - 220), triggerIndex + 80)

    expect(triggerMarkup).not.toContain('disabled')
  })

  it('requires both installed and registered evidence before treating a recovered managed plugin as ready', () => {
    expect(hasVerifiedManagedChannelInstall({
      stages: [
        { id: 'installed', state: 'verified' },
        { id: 'registered', state: 'verified' },
      ],
    })).toBe(true)

    expect(hasVerifiedManagedChannelInstall({
      stages: [
        { id: 'installed', state: 'verified' },
        { id: 'registered', state: 'unknown' },
      ],
    })).toBe(false)
  })

  it('re-checks Gateway with strict ensure after a repairable weixin reload failure before treating the repair as success', async () => {
    const appendLog = vi.fn()
    const api = {
      ensureGatewayRunning: vi.fn(async () => ({
        ok: true,
        running: true,
        summary: '',
        stderr: '',
        stdout: '',
      })),
      getManagedChannelPluginStatus: vi.fn(async () => ({
        summary: '微信插件已安装并注册',
        stages: [
          { id: 'installed', state: 'verified' },
          { id: 'registered', state: 'verified' },
        ],
      })),
    }

    await expect(
      ensureDashboardPluginGatewayReadyAfterReload(
        api,
        {
          id: 'openclaw-weixin',
          channelName: '微信',
        },
        {
          ok: false,
          running: false,
          stateCode: 'plugin_load_failure',
          summary: 'Gateway 未 ready',
          stderr: '',
          stdout: '',
        },
        appendLog
      )
    ).resolves.toBeUndefined()

    expect(api.ensureGatewayRunning).toHaveBeenCalledWith({ skipRuntimePrecheck: true })
    expect(api.getManagedChannelPluginStatus).toHaveBeenCalledWith('openclaw-weixin')
    expect(appendLog).toHaveBeenCalledWith('⚠️ 网关重载命中可修复状态：Gateway 未 ready')
  })

  it('falls back to polling installer state when the weixin exit event is missed', async () => {
    vi.useFakeTimers()

    let snapshot = createWeixinSnapshot()
    let listener: ((payload: TestWeixinInstallerSessionEvent) => void) | null = null

    const api = {
      getWeixinInstallerState: vi.fn(async () => snapshot),
      startWeixinInstaller: vi.fn(async () => {
        snapshot = createWeixinSnapshot({
          active: true,
          sessionId: 'wx-session-1',
          phase: 'running',
        })

        setTimeout(() => {
          snapshot = createWeixinSnapshot({
            active: false,
            sessionId: 'wx-session-1',
            phase: 'exited',
            ok: true,
            code: 0,
            afterAccountIds: ['wx-account-1'],
            newAccountIds: ['wx-account-1'],
          })
          // Intentionally do not emit the exit event to simulate the race window.
        }, 10)

        return snapshot
      }),
      onWeixinInstallerEvent: vi.fn((callback: (payload: TestWeixinInstallerSessionEvent) => void) => {
        listener = callback
        return () => {
          if (listener === callback) {
            listener = null
          }
        }
      }),
    }

    const completionPromise = waitForDashboardWeixinInstallerCompletion(api)

    await vi.advanceTimersByTimeAsync(300)

    await expect(completionPromise).resolves.toEqual({
      summary: '微信官方安装器已完成，并新增 1 个微信账号。',
      log: '✅ 微信官方安装器已完成，新增 1 个微信账号',
    })
    expect(api.onWeixinInstallerEvent).toHaveBeenCalledTimes(1)
    expect(api.startWeixinInstaller).toHaveBeenCalledTimes(1)
  })
})

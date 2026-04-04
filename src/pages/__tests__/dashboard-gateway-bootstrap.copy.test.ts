import { describe, expect, it } from 'vitest'

import dashboardSource from '../Dashboard.tsx?raw'
import gatewayBootstrapSource from '../GatewayBootstrapGate.tsx?raw'
import dashboardEntryBootstrapSource from '../../shared/dashboard-entry-bootstrap.ts?raw'

describe('Dashboard and gateway bootstrap approved copy', () => {
  it('matches the DOCX-approved B/D group strings', () => {
    expect(dashboardEntryBootstrapSource).toContain('正在汇总飞书连接情况和配对结果。')
    expect(dashboardSource).toContain('正在重新连接网关，请稍候...')
    expect(dashboardSource).toContain('处理完成')
    expect(dashboardSource).toContain('处理失败')
    expect(dashboardSource).toContain('网关暂时不可用')
    expect(dashboardSource).toContain('默认模型切换失败，请稍后重试。')
    expect(dashboardSource).toContain('插件处理失败，请稍后重试。')
    expect(dashboardSource).not.toContain("message: e instanceof Error ? e.message")
    expect(dashboardSource).not.toContain('setModelError(error instanceof Error ? error.message : String(error))')
    expect(dashboardSource).not.toContain('setPluginCenterError(message)')
    expect(gatewayBootstrapSource).toContain('当前无法读取必要配置，暂时不能进入控制面板。')
    expect(gatewayBootstrapSource).toContain('配置暂时无法读取')
    expect(gatewayBootstrapSource).toContain('暂时无法读取网关状态，控制面板会先按当前已知状态打开。')
    expect(gatewayBootstrapSource).toContain('暂时无法读取最新模型状态，当前先按已有配置显示模型信息。')
    expect(gatewayBootstrapSource).toContain('最终检查未完成')
    expect(gatewayBootstrapSource).toContain('重新配置')
  })
})

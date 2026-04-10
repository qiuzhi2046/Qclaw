import { describe, expect, it } from 'vitest'

import appSource from '../../App.tsx?raw'

describe('env-check plugin repair boundary', () => {
  it('keeps Windows env-check manual plugin repair on the scan-only API', () => {
    expect(appSource).toContain('window.api?.scanIncompatiblePlugins')

    const envCheckRenderStart = appSource.indexOf("if (appState === 'env-check') {")
    const gatewayBootstrapStart = appSource.indexOf("if (appState === 'gateway-bootstrap') {", envCheckRenderStart)

    expect(envCheckRenderStart).toBeGreaterThan(-1)
    expect(gatewayBootstrapStart).toBeGreaterThan(envCheckRenderStart)

    const envCheckRenderBlock = appSource.slice(envCheckRenderStart, gatewayBootstrapStart)
    expect(envCheckRenderBlock).toContain("window.api.platform === 'win32'")
    expect(envCheckRenderBlock).toContain("? runPluginQuarantine('manual')")
  })

  it('preserves macOS env-check manual plugin repair behavior', () => {
    const envCheckRenderStart = appSource.indexOf("if (appState === 'env-check') {")
    const gatewayBootstrapStart = appSource.indexOf("if (appState === 'gateway-bootstrap') {", envCheckRenderStart)

    expect(envCheckRenderStart).toBeGreaterThan(-1)
    expect(gatewayBootstrapStart).toBeGreaterThan(envCheckRenderStart)

    const envCheckRenderBlock = appSource.slice(envCheckRenderStart, gatewayBootstrapStart)
    expect(envCheckRenderBlock).toContain(": runPluginRepair('manual')")
  })
})

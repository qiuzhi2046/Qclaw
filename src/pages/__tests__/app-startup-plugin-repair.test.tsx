import { describe, expect, it } from 'vitest'

import appSource from '../../App.tsx?raw'

describe('App startup plugin repair gating', () => {
  it('does not auto-start startup plugin repair while the env check gate is active', () => {
    expect(appSource).toMatch(
      /useEffect\(\(\) => \{\s*if \(startupRepairAttemptedRef\.current\) return\s*if \(appState === 'startup-update' \|\| appState === 'welcome' \|\| appState === 'env-check'\) return/
    )
  })

  it('does not wire env-check rendering to the startup plugin repair hook', () => {
    const envCheckRenderStart = appSource.indexOf("if (appState === 'env-check') {")
    const gatewayBootstrapStart = appSource.indexOf("if (appState === 'gateway-bootstrap') {", envCheckRenderStart)

    expect(envCheckRenderStart).toBeGreaterThan(-1)
    expect(gatewayBootstrapStart).toBeGreaterThan(envCheckRenderStart)

    const envCheckRenderBlock = appSource.slice(envCheckRenderStart, gatewayBootstrapStart)
    expect(envCheckRenderBlock).not.toContain('onEnsurePluginRepairReady=')
  })

  it('records env-ready and gateway-bootstrap transitions in the shared env-check diagnostics stream', () => {
    expect(appSource).toContain("window.api.appendEnvCheckDiagnostic('app-env-ready'")
    expect(appSource).toContain("window.api.appendEnvCheckDiagnostic('app-state-transition'")
    expect(appSource).toContain("const nextState = resolveAppStateForPhase1Target(nextTarget)")
  })
})

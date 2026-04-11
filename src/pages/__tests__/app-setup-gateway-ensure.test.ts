import { describe, expect, it } from 'vitest'

import appSource from '../../App.tsx?raw'

describe('setup gateway ensure flow', () => {
  it('enters channel connect immediately after api-key setup succeeds', () => {
    expect(appSource).toMatch(
      /<ApiKeys[\s\S]{0,400}onNext=\{\(context\) => \{[\s\S]{0,200}setSetupModelContext\(context\)[\s\S]{0,200}setSetupStep\('channel-connect'\)/
    )
  })

  it('does not block onboarding progression on a duplicate app-level gateway ensure', () => {
    expect(appSource).not.toContain('ensureGatewayReadyBeforeChannelConnect(window.api)')
  })
})

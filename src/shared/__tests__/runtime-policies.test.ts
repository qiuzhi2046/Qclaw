import { describe, expect, it } from 'vitest'

import { MAIN_RUNTIME_DEFAULTS } from '../runtime-policies'

describe('plugin install runtime defaults', () => {
  it('gives non-interactive plugin installs a ten minute budget by default', () => {
    expect(MAIN_RUNTIME_DEFAULTS.cli.pluginInstallTimeoutMs).toBe(600_000)
    expect(MAIN_RUNTIME_DEFAULTS.cli.pluginInstallNpxTimeoutMs).toBe(600_000)
  })
})

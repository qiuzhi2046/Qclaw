import { describe, expect, it } from 'vitest'

describe('cli module load', () => {
  it('loads the cli module under the vitest node runtime', async () => {
    const cliModule = await import('../cli')

    expect(cliModule.runCli).toBeTypeOf('function')
  })
})

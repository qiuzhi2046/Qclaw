import { describe, expect, it } from 'vitest'

const fs = process.getBuiltinModule('node:fs') as typeof import('node:fs')
const path = process.getBuiltinModule('node:path') as typeof import('node:path')

describe('cli command resolution source', () => {
  it('prefers the probed npx path for plugin npx installs', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'electron', 'main', 'cli.ts'),
      'utf8'
    )

    expect(source).toContain('capability.resolvedPath')
  })

  it('prefers the probed openclaw path for managed cli invocations', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'electron', 'main', 'cli.ts'),
      'utf8'
    )

    expect(source).toContain('openClawCapability?.resolvedPath')
  })
})

import { describe, expect, it } from 'vitest'

const fs = process.getBuiltinModule('node:fs') as typeof import('node:fs')
const path = process.getBuiltinModule('node:path') as typeof import('node:path')

describe('ipc command resolution source', () => {
  it('prefers the probed npx path when installing missing skill dependencies via IPC', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'electron', 'main', 'ipc-handlers.ts'),
      'utf8'
    )

    expect(source).toContain("probePlatformCommandCapability('npx'")
    expect(source).toContain('capability.resolvedPath')
    expect(source).toContain('buildCommandCapabilityEnv()')
  })
})

import { describe, expect, it } from 'vitest'

const { readFile } = process.getBuiltinModule('node:fs/promises') as typeof import('node:fs/promises')
const path = process.getBuiltinModule('node:path') as typeof import('node:path')

function extractRunDirectSource(cliSource: string): string {
  const matched = cliSource.match(
    /export async function runDirect\([\s\S]*?\r?\n}\r?\n\r?\nfunction buildCommandCapabilityEnv\(\): NodeJS\.ProcessEnv \{/
  )
  if (!matched) {
    throw new Error('runDirect source block not found')
  }
  return matched[0]
}

describe('runDirect permission auto repair wiring', () => {
  it('routes runDirect through the shared permission auto repair layer', async () => {
    const cliSource = await readFile(path.join(process.cwd(), 'electron/main/cli.ts'), 'utf8')
    const runDirectSource = extractRunDirectSource(cliSource)

    expect(runDirectSource).toContain('return runCliLikeWithPermissionAutoRepair(')
    expect(runDirectSource).toContain("operation: 'direct'")
  })
})

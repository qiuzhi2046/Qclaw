import { describe, expect, it } from 'vitest'

const { readFile } = process.getBuiltinModule('node:fs/promises') as typeof import('node:fs/promises')
const path = process.getBuiltinModule('node:path') as typeof import('node:path')

function extractRunDirectSource(cliSource: string): string {
  const signature = 'export async function runDirect('
  const start = cliSource.indexOf(signature)
  if (start < 0) {
    throw new Error('runDirect source block not found')
  }

  const bodyStart = cliSource.indexOf('{', start)
  if (bodyStart < 0) {
    throw new Error('runDirect source body not found')
  }

  let depth = 0
  for (let index = bodyStart; index < cliSource.length; index += 1) {
    const char = cliSource[index]
    if (char === '{') depth += 1
    if (char === '}') {
      depth -= 1
      if (depth === 0) {
        return cliSource.slice(start, index + 1)
      }
    }
  }

  throw new Error('runDirect source block is unterminated')
}

describe('runDirect permission auto repair wiring', () => {
  it('routes runDirect through the shared permission auto repair layer', async () => {
    const cliSource = await readFile(path.join(process.cwd(), 'electron/main/cli.ts'), 'utf8')
    const runDirectSource = extractRunDirectSource(cliSource)

    expect(runDirectSource).toContain('return runCliLikeWithPermissionAutoRepair(')
    expect(runDirectSource).toContain("operation: 'direct'")
  })
})

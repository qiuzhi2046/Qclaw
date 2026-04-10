import { describe, expect, it } from 'vitest'

const { readFile } = process.getBuiltinModule('node:fs/promises') as typeof import('node:fs/promises')
const path = process.getBuiltinModule('node:path') as typeof import('node:path')

function extractRunDirectSource(cliSource: string): string {
  const matched = cliSource.match(
    /export async function runDirect\([\s\S]*?\n}\n\nfunction buildCommandCapabilityEnv\(\): NodeJS\.ProcessEnv \{/
  )
  if (!matched) {
    throw new Error('runDirect source block not found')
  }
  return matched[0]
}

function extractRunShellAndDirectSource(cliSource: string): string {
  const start = cliSource.indexOf('async function runShellOnce(')
  const end = cliSource.indexOf('export async function runDirect(', start)
  if (start < 0 || end < 0) {
    throw new Error('runShellOnce/runDirectOnce source block not found')
  }
  return cliSource.slice(start, end)
}

describe('runDirect permission auto repair wiring', () => {
  it('routes runDirect through the shared permission auto repair layer', async () => {
    const cliSource = await readFile(path.join(process.cwd(), 'electron/main/cli.ts'), 'utf8')
    const runDirectSource = extractRunDirectSource(cliSource)

    expect(runDirectSource).toContain('return runCliLikeWithPermissionAutoRepair(')
    expect(runDirectSource).toContain("operation: 'direct'")
  })

  it('guards shell and direct child-process spawns against synchronous spawn failures', async () => {
    const cliSource = await readFile(path.join(process.cwd(), 'electron/main/cli.ts'), 'utf8')
    const source = extractRunShellAndDirectSource(cliSource)

    expect(source).toMatch(/try\s*\{\s*const proc = spawn\(/)
    expect(source).toMatch(/catch \(error\)/)
    expect(source).toMatch(/stderr: error instanceof Error \? error\.message : String\(error \|\| ''\)/)
  })
})

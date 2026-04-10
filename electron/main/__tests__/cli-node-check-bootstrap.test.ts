import { describe, expect, it } from 'vitest'

const { readFile } = process.getBuiltinModule('node:fs/promises') as typeof import('node:fs/promises')
const path = process.getBuiltinModule('node:path') as typeof import('node:path')

function extractCheckNodeSource(cliSource: string): string {
  const start = cliSource.indexOf('export async function checkNode(): Promise<NodeCheckResult> {')
  const end = cliSource.indexOf('async function detectNvmDir():', start)
  if (start < 0 || end < 0) {
    throw new Error('checkNode source block not found')
  }
  return cliSource.slice(start, end)
}

function extractResolveNodeInstallPlanSource(cliSource: string): string {
  const start = cliSource.indexOf('export async function resolveNodeInstallPlan(): Promise<NodeInstallPlan> {')
  const end = cliSource.indexOf('async function downloadFile(', start)
  if (start < 0 || end < 0) {
    throw new Error('resolveNodeInstallPlan source block not found')
  }
  return cliSource.slice(start, end)
}

describe('checkNode Windows bootstrap requirement probe', () => {
  it('skips dynamic OpenClaw requirement probing before Windows private Node bootstrap', async () => {
    const cliSource = await readFile(path.join(process.cwd(), 'electron/main/cli.ts'), 'utf8')
    const checkNodeSource = extractCheckNodeSource(cliSource)

    expect(checkNodeSource).toMatch(
      /resolveOpenClawNodeRequirement\(\s*isWin\s*\?\s*\{\s*skipDynamicOpenClawRequirementProbe: true/
    )
    expect(checkNodeSource.indexOf('skipDynamicOpenClawRequirementProbe: true')).toBeLessThan(
      checkNodeSource.indexOf('resolveNodeInstallPlanForNodeCheck()')
    )
  })

  it('skips dynamic OpenClaw requirement probing for the public Node install plan IPC path', async () => {
    const cliSource = await readFile(path.join(process.cwd(), 'electron/main/cli.ts'), 'utf8')
    const resolveNodeInstallPlanSource = extractResolveNodeInstallPlanSource(cliSource)

    expect(resolveNodeInstallPlanSource).toMatch(
      /resolveRuntimeNodeInstallPlan\(\s*isWin\s*\?\s*\{\s*skipDynamicOpenClawRequirementProbe: true/
    )
  })
})

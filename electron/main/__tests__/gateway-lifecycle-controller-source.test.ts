import { describe, expect, it } from 'vitest'

const fs = process.getBuiltinModule('node:fs') as typeof import('node:fs')
const path = process.getBuiltinModule('node:path') as typeof import('node:path')
const source = fs.readFileSync(
  path.join(process.cwd(), 'electron/main/gateway-lifecycle-controller.ts'),
  'utf8'
)

describe('gateway lifecycle controller source', () => {
  it('only stops Qclaw-managed Windows gateway owners for installer sessions', () => {
    expect(source).toContain("owner?.ownerKind === 'scheduled-task'")
    expect(source).toContain("owner?.ownerKind === 'startup-folder'")
    expect(source).toContain('if (!snapshot.wasRunning || !snapshot.wasOwnedByQclaw)')
    expect(source).toContain('stopResult: null')
  })

  it('recovers installer-stopped gateways with the original runtime snapshot', () => {
    expect(source).toContain('activeRuntimeSnapshot: snapshot.runtimeSnapshot || undefined')
    expect(source).toContain('activeRuntimeSnapshot: stopSnapshot.runtimeSnapshot || undefined')
    expect(source).toContain('configRepairPreflightHomeDir: stopSnapshot.runtimeSnapshot?.stateDir || undefined')
    expect(source).toContain('!stopSnapshot.stopped')
  })
})

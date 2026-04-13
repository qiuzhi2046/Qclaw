import { describe, expect, it, vi } from 'vitest'

import {
  buildOpenClawRepairSnapshot,
  buildMacOpenClawElevatedLifecycleTransactionCommand,
  runMacOpenClawElevatedLifecycleTransaction,
} from '../openclaw-elevated-lifecycle-transaction'

const fs = process.getBuiltinModule('node:fs/promises') as typeof import('node:fs/promises')
const os = process.getBuiltinModule('node:os') as typeof import('node:os')
const path = process.getBuiltinModule('node:path') as typeof import('node:path')

const { mkdtemp, mkdir, rm, symlink } = fs
const { tmpdir } = os
const { join } = path

describe('openclaw-elevated-lifecycle-transaction', () => {
  it('freezes a deterministic uninstall repair contract before elevation', async () => {
    const snapshot = await buildOpenClawRepairSnapshot({
      operation: 'uninstall',
      runtimePathsResolver: vi.fn(async () => ({
        homeDir: '/Users/test/Library/Application Support/OpenClaw/profiles/main',
      })),
      homeDir: '/Users/test',
      qclawSafeWorkDir: '/Users/test/Library/Application Support/Qclaw Lite/runtime',
      userDataDir: '/Users/test/Library/Application Support/Qclaw Lite',
    })

    expect(snapshot.stateRootPath).toBe('/Users/test/Library/Application Support/OpenClaw/profiles/main')
    expect(snapshot.fallbackStateRootUsed).toBe(false)
    expect(snapshot.targets.map((target) => target.path)).toEqual([
      '/Users/test/Library/Application Support/OpenClaw/profiles/main',
      '/Users/test/.npm',
    ])
    expect(snapshot.targets.every((target) => target.createIfMissing === false)).toBe(true)
  })

  it('rejects runtime-discovered state roots outside trusted repair scopes', async () => {
    await expect(
      buildOpenClawRepairSnapshot({
        operation: 'upgrade',
        runtimePathsResolver: vi.fn(async () => ({
          homeDir: '/Volumes/External/OpenClaw',
        })),
        homeDir: '/Users/test',
        qclawSafeWorkDir: '/Users/test/Library/Application Support/Qclaw Lite/runtime',
        userDataDir: '/Users/test/Library/Application Support/Qclaw Lite',
      })
    ).rejects.toThrow('outside trusted repair scopes')
  })

  it('rejects symlinked repair targets that resolve outside trusted repair scopes', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'qclaw-home-'))
    const externalDir = await mkdtemp(join(tmpdir(), 'qclaw-external-'))
    const userDataDir = join(homeDir, 'Library', 'Application Support', 'Qclaw Lite')
    const symlinkPath = join(homeDir, '.openclaw-link')

    await mkdir(userDataDir, { recursive: true })
    await symlink(externalDir, symlinkPath)

    try {
      await expect(
        buildOpenClawRepairSnapshot({
          operation: 'install',
          runtimePathsResolver: vi.fn(async () => ({
            homeDir: symlinkPath,
          })),
          homeDir,
          qclawSafeWorkDir: join(userDataDir, 'runtime'),
          userDataDir,
        })
      ).rejects.toThrow('outside trusted repair scopes')
    } finally {
      await rm(homeDir, { recursive: true, force: true })
      await rm(externalDir, { recursive: true, force: true })
    }
  })

  it('rejects repair targets whose parent path escapes trusted scopes through a symlink', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'qclaw-home-'))
    const externalDir = await mkdtemp(join(tmpdir(), 'qclaw-external-'))
    const userDataDir = join(homeDir, 'Library', 'Application Support', 'Qclaw Lite')
    const symlinkParentPath = join(homeDir, 'profiles-link')
    const escapedStateRootPath = join(symlinkParentPath, 'main')

    await mkdir(userDataDir, { recursive: true })
    await mkdir(join(externalDir, 'main'), { recursive: true })
    await symlink(externalDir, symlinkParentPath)

    try {
      await expect(
        buildOpenClawRepairSnapshot({
          operation: 'upgrade',
          runtimePathsResolver: vi.fn(async () => ({
            homeDir: escapedStateRootPath,
          })),
          homeDir,
          qclawSafeWorkDir: join(userDataDir, 'runtime'),
          userDataDir,
        })
      ).rejects.toThrow('outside trusted repair scopes')
    } finally {
      await rm(homeDir, { recursive: true, force: true })
      await rm(externalDir, { recursive: true, force: true })
    }
  })

  it('accepts managed installer roots whose realpath stays inside the trusted safe work directory', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'qclaw-home-'))
    const userDataDir = join(homeDir, 'Library', 'Application Support', 'Qclaw Lite')
    const safeWorkDir = await mkdtemp(join(tmpdir(), 'qclaw-safe-work-'))
    const managedInstallerRoot = join(safeWorkDir, 'openclaw-installer')

    await mkdir(userDataDir, { recursive: true })
    await mkdir(managedInstallerRoot, { recursive: true })

    try {
      const snapshot = await buildOpenClawRepairSnapshot({
        operation: 'install',
        runtimePathsResolver: vi.fn(async () => ({
          homeDir: join(homeDir, '.openclaw'),
        })),
        homeDir,
        qclawSafeWorkDir: safeWorkDir,
        userDataDir,
        includeManagedInstallerRoot: true,
      })

      expect(snapshot.targets).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: 'managedInstallerRoot',
            path: managedInstallerRoot,
          }),
        ])
      )
    } finally {
      await rm(homeDir, { recursive: true, force: true })
      await rm(safeWorkDir, { recursive: true, force: true })
    }
  })

  it('builds a failure-safe shell transaction that reports lifecycle and repair status separately', () => {
    const command = buildMacOpenClawElevatedLifecycleTransactionCommand({
      lifecycleCommand: "npm 'install' '-g' 'openclaw@latest'",
      snapshot: {
        operation: 'install',
        stateRootPath: '/Users/test/.openclaw',
        fallbackStateRootUsed: true,
        targets: [
          {
            role: 'stateRoot',
            path: '/Users/test/.openclaw',
            createIfMissing: true,
          },
          {
            role: 'npmCache',
            path: '/Users/test/.npm',
            createIfMissing: true,
          },
        ],
      },
      userId: 501,
      groupId: 20,
    })

    expect(command).toContain("qclaw_lifecycle_status=\"$?\"")
    expect(command).toContain("mkdir -p '/Users/test/.openclaw'")
    expect(command).toContain("chown -R '501':'20' '/Users/test/.openclaw'")
    expect(command).toContain("chown -R '501':'20' '/Users/test/.npm'")
    expect(command).toContain('printf \'%s\\n\' "__QCLAW_TXN_LIFECYCLE_STATUS__=$qclaw_lifecycle_status"')
    expect(command).toContain('printf \'%s\\n\' "__QCLAW_TXN_REPAIR_STATUS__=$qclaw_repair_status"')
    expect(command).not.toContain('&& (__QCLAW_TXN_LIFECYCLE_STATUS__)')
  })

  it('repairs symlinked targets via chown -h on the link and recursive repair on the resolved real path', () => {
    const command = buildMacOpenClawElevatedLifecycleTransactionCommand({
      lifecycleCommand: "npm 'install' '-g' 'openclaw@latest'",
      snapshot: {
        operation: 'install',
        stateRootPath: '/Users/test/.openclaw-link',
        fallbackStateRootUsed: false,
        targets: [
          {
            role: 'stateRoot',
            path: '/Users/test/.openclaw-link',
            createIfMissing: false,
            realPath: '/Users/test/Library/Application Support/OpenClaw/profiles/main',
            isSymlink: true,
          } as any,
        ],
      },
      userId: 501,
      groupId: 20,
    })

    expect(command).toContain("chown -h '501':'20' '/Users/test/.openclaw-link'")
    expect(command).toContain(
      "chown -R '501':'20' '/Users/test/Library/Application Support/OpenClaw/profiles/main'"
    )
    expect(command).not.toContain("chown -R '501':'20' '/Users/test/.openclaw-link'")
  })

  it('returns lifecycle_failed_environment_repaired when the privileged command fails but repair and verification succeed', async () => {
    const result = await runMacOpenClawElevatedLifecycleTransaction({
      operation: 'upgrade',
      lifecycleCommand: "npm 'install' '-g' 'openclaw@2026.4.12'",
      prompt: 'prompt',
      timeoutMs: 1000,
      controlDomain: 'upgrade',
      snapshotResolver: vi.fn(async () => ({
        operation: 'upgrade' as const,
        stateRootPath: '/Users/test/.openclaw',
        fallbackStateRootUsed: true,
        targets: [
          {
            role: 'stateRoot' as const,
            path: '/Users/test/.openclaw',
            createIfMissing: true,
          },
        ],
      })),
      runDirect: vi.fn(async () => ({
        ok: false,
        stdout: '__QCLAW_TXN_LIFECYCLE_STATUS__=1\n__QCLAW_TXN_REPAIR_STATUS__=0\n',
        stderr: 'npm error code EACCES',
        code: 1,
      })),
      verifyTargetAccess: vi.fn(async () => ({
        ok: true,
      })),
      buildAppleScript: vi.fn((command: string) => command),
    })

    expect(result.ok).toBe(false)
    expect(result.status).toBe('lifecycle_failed_environment_repaired')
    expect(result.lifecycle.ok).toBe(false)
    expect(result.repair.ok).toBe(true)
    expect(result.verification.ok).toBe(true)
  })

  it('returns post_repair_verification_failed when verification still fails after a successful privileged command', async () => {
    const verifyTargetAccess = vi.fn(async () => ({
      ok: false,
      detail: 'owner mismatch',
    }))
    const result = await runMacOpenClawElevatedLifecycleTransaction({
      operation: 'install',
      lifecycleCommand: "npm 'install' '-g' 'openclaw@latest'",
      prompt: 'prompt',
      timeoutMs: 1000,
      controlDomain: 'env-setup',
      snapshotResolver: vi.fn(async () => ({
        operation: 'install' as const,
        stateRootPath: '/Users/test/.openclaw',
        fallbackStateRootUsed: true,
        targets: [
          {
            role: 'stateRoot' as const,
            path: '/Users/test/.openclaw',
            createIfMissing: true,
          },
        ],
      })),
      runDirect: vi.fn(async () => ({
        ok: true,
        stdout: '__QCLAW_TXN_LIFECYCLE_STATUS__=0\n__QCLAW_TXN_REPAIR_STATUS__=0\n',
        stderr: '',
        code: 0,
      })),
      verifyTargetAccess,
      buildAppleScript: vi.fn((command: string) => command),
    })

    expect(result.ok).toBe(false)
    expect(result.status).toBe('post_repair_verification_failed')
    expect(result.lifecycle.ok).toBe(true)
    expect(result.repair.ok).toBe(true)
    expect(result.verification.ok).toBe(false)
    expect(verifyTargetAccess).toHaveBeenCalledWith(
      expect.objectContaining({
        role: 'stateRoot',
        path: '/Users/test/.openclaw',
      })
    )
  })

  it('treats missing uninstall targets as already cleaned up during verification', async () => {
    const missingStateRoot = await mkdtemp(join(tmpdir(), 'qclaw-missing-uninstall-'))
    await rm(missingStateRoot, { recursive: true, force: true })

    const result = await runMacOpenClawElevatedLifecycleTransaction({
      operation: 'uninstall',
      lifecycleCommand: "npm 'uninstall' '-g' 'openclaw'",
      prompt: 'prompt',
      timeoutMs: 1000,
      controlDomain: 'upgrade',
      snapshotResolver: vi.fn(async () => ({
        operation: 'uninstall' as const,
        stateRootPath: missingStateRoot,
        fallbackStateRootUsed: false,
        targets: [
          {
            role: 'stateRoot' as const,
            path: missingStateRoot,
            createIfMissing: false,
          },
        ],
      })),
      runDirect: vi.fn(async () => ({
        ok: true,
        stdout: '__QCLAW_TXN_LIFECYCLE_STATUS__=0\n__QCLAW_TXN_REPAIR_STATUS__=0\n',
        stderr: '',
        code: 0,
      })),
      buildAppleScript: vi.fn((command: string) => command),
    })

    expect(result.ok).toBe(true)
    expect(result.status).toBe('success')
    expect(result.lifecycle.ok).toBe(true)
    expect(result.repair.ok).toBe(true)
    expect(result.verification.ok).toBe(true)
    expect(result.verification.failures).toEqual([])
  })
})

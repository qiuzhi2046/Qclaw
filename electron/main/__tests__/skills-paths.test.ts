import { describe, expect, it } from 'vitest'
import {
  buildClawHubInstallArgs,
  buildClawHubUninstallArgs,
  normalizeOpenClawSkillsListPayload,
  resolveClawHubLockFilePath,
  resolveOpenClawSkillLocations,
} from '../skills-paths'

const path = process.getBuiltinModule('node:path') as typeof import('node:path')

describe('skills paths helpers', () => {
  it('derives managed/workspace locations from skills list payload', () => {
    const locations = resolveOpenClawSkillLocations(
      {
        workspaceDir: '/Users/demo/.openclaw/workspace-feishu-default',
        managedSkillsDir: '/Users/demo/.openclaw/skills',
      },
      {
        pathModule: path.posix as unknown as typeof import('node:path'),
      }
    )

    expect(locations).toEqual({
      workspaceDir: '/Users/demo/.openclaw/workspace-feishu-default',
      workspaceSkillsDir: '/Users/demo/.openclaw/workspace-feishu-default/skills',
      managedSkillsDir: '/Users/demo/.openclaw/skills',
      clawhubWorkdir: '/Users/demo/.openclaw',
      clawhubDir: 'skills',
    })
  })

  it('falls back to ~/.openclaw paths when payload is incomplete', () => {
    const locations = resolveOpenClawSkillLocations({}, {
      homeDir: '/Users/fallback',
      pathModule: path.posix as unknown as typeof import('node:path'),
    })

    expect(locations).toEqual({
      workspaceDir: '/Users/fallback/.openclaw/workspace',
      workspaceSkillsDir: '/Users/fallback/.openclaw/workspace/skills',
      managedSkillsDir: '/Users/fallback/.openclaw/skills',
      clawhubWorkdir: '/Users/fallback/.openclaw',
      clawhubDir: 'skills',
    })
  })

  it('handles windows paths using dirname/basename instead of slash regexes', () => {
    const locations = resolveOpenClawSkillLocations(
      {
        workspaceDir: 'C:\\Users\\demo\\.openclaw\\workspace-personal',
        managedSkillsDir: 'C:\\Users\\demo\\.openclaw\\skills',
      },
      {
        homeDir: 'C:\\Users\\demo',
        pathModule: path.win32 as unknown as typeof import('node:path'),
      }
    )

    expect(locations).toEqual({
      workspaceDir: 'C:\\Users\\demo\\.openclaw\\workspace-personal',
      workspaceSkillsDir: 'C:\\Users\\demo\\.openclaw\\workspace-personal\\skills',
      managedSkillsDir: 'C:\\Users\\demo\\.openclaw\\skills',
      clawhubWorkdir: 'C:\\Users\\demo\\.openclaw',
      clawhubDir: 'skills',
    })
  })

  it('normalizes skills list payload with derived visibility fields', () => {
    const payload = normalizeOpenClawSkillsListPayload(
      {
        workspaceDir: '/Users/demo/.openclaw/workspace-feishu-default',
        managedSkillsDir: '/Users/demo/.openclaw/skills',
        skills: [{ name: 'token-optimizer' }],
      },
      {
        homeDir: '/Users/demo',
        pathModule: path.posix as unknown as typeof import('node:path'),
      }
    )

    expect(payload).toMatchObject({
      workspaceDir: '/Users/demo/.openclaw/workspace-feishu-default',
      workspaceSkillsDir: '/Users/demo/.openclaw/workspace-feishu-default/skills',
      managedSkillsDir: '/Users/demo/.openclaw/skills',
      clawhubWorkdir: '/Users/demo/.openclaw',
      clawhubDir: 'skills',
      skills: [{ name: 'token-optimizer' }],
    })
  })

  it('builds explicit clawhub install/uninstall arguments that target the visible managed dir', () => {
    const locations = resolveOpenClawSkillLocations(
      {
        workspaceDir: '/Users/demo/.openclaw/workspace-feishu-default',
        managedSkillsDir: '/Users/demo/.openclaw/skills',
      },
      {
        homeDir: '/Users/demo',
        pathModule: path.posix as unknown as typeof import('node:path'),
      }
    )

    expect(buildClawHubInstallArgs('token-optimizer', locations)).toEqual([
      '-y',
      'clawhub',
      '--workdir',
      '/Users/demo/.openclaw',
      '--dir',
      'skills',
      'install',
      'token-optimizer',
    ])

    expect(buildClawHubUninstallArgs('token-optimizer', locations)).toEqual([
      '-y',
      'clawhub',
      '--workdir',
      '/Users/demo/.openclaw',
      '--dir',
      'skills',
      'uninstall',
      'token-optimizer',
      '--yes',
    ])

    expect(
      resolveClawHubLockFilePath(locations, {
        pathModule: path.posix as unknown as typeof import('node:path'),
      })
    ).toBe('/Users/demo/.openclaw/.clawhub/lock.json')
  })
})

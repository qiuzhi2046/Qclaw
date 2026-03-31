import { describe, expect, it } from 'vitest'
import {
  findExactSafeSkillSlugMatch,
  isAllowedOpenClawSkillsRoot,
  normalizeSafeSkillSlug,
  resolveManagedSkillFallbackPath,
  resolveSkillPathUnderRoot,
} from '../skills-uninstall-safety'
const path = process.getBuiltinModule('node:path') as typeof import('node:path')

describe('skills uninstall safety', () => {
  const homeDir = '/Users/demo'

  it('accepts normal skill slugs', () => {
    expect(normalizeSafeSkillSlug('token-optimizer')).toBe('token-optimizer')
    expect(normalizeSafeSkillSlug('debug_pro.v2')).toBe('debug_pro.v2')
  })

  it('rejects invalid or unsafe slugs', () => {
    expect(normalizeSafeSkillSlug('')).toBeNull()
    expect(normalizeSafeSkillSlug('   ')).toBeNull()
    expect(normalizeSafeSkillSlug('../escape')).toBeNull()
    expect(normalizeSafeSkillSlug('nested/path')).toBeNull()
    expect(normalizeSafeSkillSlug('name;rm -rf /')).toBeNull()
  })

  it('resolves fallback path only under managed skills root', () => {
    const result = resolveManagedSkillFallbackPath('/Users/demo/.openclaw/skills', 'token-optimizer', {
      homeDir,
      pathModule: path.posix as unknown as typeof import('node:path'),
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.skillsRoot).toBe('/Users/demo/.openclaw/skills')
      expect(result.targetPath).toBe('/Users/demo/.openclaw/skills/token-optimizer')
    }
  })

  it('accepts standard workspace skill roots under .openclaw', () => {
    expect(
      isAllowedOpenClawSkillsRoot('/Users/demo/.openclaw/workspace-feishu-default/skills', {
        homeDir,
        rootKind: 'workspace',
        pathModule: path.posix as unknown as typeof import('node:path'),
      })
    ).toBe(true)

    const result = resolveSkillPathUnderRoot(
      '/Users/demo/.openclaw/workspace-feishu-default/skills',
      'token-manager',
      {
        homeDir,
        rootKind: 'workspace',
        pathModule: path.posix as unknown as typeof import('node:path'),
      }
    )
    expect(result.ok).toBe(true)
  })

  it('rejects unsafe fallback names', () => {
    const result = resolveManagedSkillFallbackPath('/Users/demo/.openclaw/skills', '../../etc', {
      homeDir,
      pathModule: path.posix as unknown as typeof import('node:path'),
    })
    expect(result.ok).toBe(false)
  })

  it('rejects non-standard skills roots outside .openclaw', () => {
    expect(
      resolveManagedSkillFallbackPath('/tmp/openclaw/custom-skills', 'token-optimizer', {
        homeDir,
        pathModule: path.posix as unknown as typeof import('node:path'),
      }).ok
    ).toBe(false)
    expect(
      resolveSkillPathUnderRoot('/Users/demo/.openclaw/custom-skills', 'token-manager', {
        homeDir,
        rootKind: 'workspace',
        pathModule: path.posix as unknown as typeof import('node:path'),
      }).ok
    ).toBe(false)
  })

  it('matches lock slugs by exact safe slug (case-insensitive) only', () => {
    expect(
      findExactSafeSkillSlugMatch('Token-Optimizer', ['token-optimizer', 'debug-pro'])
    ).toBe('token-optimizer')

    expect(
      findExactSafeSkillSlugMatch('token', ['token-optimizer', 'debug-pro'])
    ).toBeNull()

    expect(
      findExactSafeSkillSlugMatch('token-optimizer', ['token-optimizer-v2'])
    ).toBeNull()
  })
})

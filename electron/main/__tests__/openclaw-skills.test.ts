import { describe, expect, it } from 'vitest'
import {
  buildBundledFallbackSkillsPayload,
  findBundledManifestSkillByNameOrKey,
  findNormalizedSkillByNameOrKey,
  isUnsupportedSkillsCommand,
  normalizeOpenClawSkillEntry,
  normalizeOpenClawSkillsPayload,
  normalizeSkillConfigKey,
} from '../openclaw-skills'
const path = process.getBuiltinModule('node:path') as typeof import('node:path')

describe('openclaw skills compatibility helpers', () => {
  it('derives skill metadata from metadata.openclaw when top-level fields are missing', () => {
    expect(
      normalizeOpenClawSkillEntry({
        name: 'Token Optimizer',
        summary: 'Trim token spend',
        source: 'openclaw-workspace',
        metadata: {
          openclaw: {
            skillKey: 'token-optimizer',
            homepage: 'https://example.com/skills/token-optimizer',
            emoji: ':chart_with_upwards_trend:',
            primaryEnv: 'TOKEN_OPTIMIZER_API_KEY',
            apiKeys: ['apiKey'],
            configKeys: ['skills.entries.token-optimizer.enabled'],
            requires: ['python3'],
            install: [{ kind: 'brew', label: 'Install jq', bins: ['jq'] }],
          },
        },
      })
    ).toMatchObject({
      name: 'Token Optimizer',
      skillKey: 'token-optimizer',
      homepage: 'https://example.com/skills/token-optimizer',
      emoji: ':chart_with_upwards_trend:',
      primaryEnv: 'TOKEN_OPTIMIZER_API_KEY',
      apiKeys: ['apiKey'],
      configKeys: ['skills.entries.token-optimizer.enabled'],
      requires: ['python3'],
      install: [{ kind: 'brew', label: 'Install jq', bins: ['jq'] }],
    })
  })

  it('normalizes list payloads and keeps derived location fields', () => {
    const payload = normalizeOpenClawSkillsPayload(
      {
        workspaceDir: '/Users/demo/.openclaw/workspace-default',
        managedSkillsDir: '/Users/demo/.openclaw/skills',
        skills: [
          {
            name: 'Token Optimizer',
            source: 'openclaw-workspace',
            metadata: {
              openclaw: {
                skillKey: 'token-optimizer',
              },
            },
          },
        ],
      },
      {
        pathModule: path.posix as unknown as typeof import('node:path'),
      }
    )

    expect(payload).toMatchObject({
      workspaceDir: '/Users/demo/.openclaw/workspace-default',
      workspaceSkillsDir: '/Users/demo/.openclaw/workspace-default/skills',
      managedSkillsDir: '/Users/demo/.openclaw/skills',
    })
    expect(Array.isArray(payload.skills) ? payload.skills : []).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'Token Optimizer', skillKey: 'token-optimizer' })])
    )
  })

  it('finds a normalized skill by either visible name or skillKey', () => {
    const payload = normalizeOpenClawSkillsPayload({
      skills: [
        {
          name: 'My Skill',
          source: 'openclaw-managed',
          metadata: {
            openclaw: {
              skillKey: 'my-skill-pack',
            },
          },
        },
      ],
    })

    expect(findNormalizedSkillByNameOrKey(payload, 'My Skill')?.skillKey).toBe('my-skill-pack')
    expect(findNormalizedSkillByNameOrKey(payload, 'my-skill-pack')?.name).toBe('My Skill')
  })

  it('injects bundled manifest skills when payload does not expose them', () => {
    const payload = normalizeOpenClawSkillsPayload({}, {
      config: {
        tools: {
          web: {
            search: {
              enabled: true,
            },
          },
        },
      },
    })

    const skills = Array.isArray(payload.skills) ? payload.skills : []
    expect(skills).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          skillKey: 'web-search',
          source: 'openclaw-bundled',
          bundled: true,
          disabled: false,
          configKeys: ['tools.web.search.enabled'],
        }),
        expect.objectContaining({
          skillKey: 'autonomy',
          source: 'openclaw-bundled',
          bundled: true,
        }),
      ])
    )
  })

  it('finds manifest-backed bundled skills by id or label', () => {
    expect(findBundledManifestSkillByNameOrKey('web-search')?.name).toBe('网页搜索')
    expect(findBundledManifestSkillByNameOrKey('自主执行')?.skillKey).toBe('autonomy')
  })

  it('builds a bundled fallback payload even when CLI list data is unavailable', () => {
    const payload = buildBundledFallbackSkillsPayload(null)
    expect(Array.isArray(payload.skills) ? payload.skills : []).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          skillKey: 'web-search',
          source: 'openclaw-bundled',
        }),
      ])
    )
  })

  it('recognizes unsupported newer skills commands for fallback routing', () => {
    expect(
      isUnsupportedSkillsCommand({
        ok: false,
        stdout: '',
        stderr: 'unknown command "status" for "skills"',
      })
    ).toBe(true)

    expect(
      isUnsupportedSkillsCommand({
        ok: false,
        stdout: '',
        stderr: 'network timeout while contacting registry',
      })
    ).toBe(false)

    expect(
      isUnsupportedSkillsCommand({
        ok: false,
        stdout: '',
        stderr: 'Config invalid\nProblem:\n  - channels.openclaw-weixin: unknown channel id: openclaw-weixin',
      })
    ).toBe(false)
  })

  it('accepts human-readable config keys but rejects control characters', () => {
    expect(normalizeSkillConfigKey('my-skill')).toBe('my-skill')
    expect(normalizeSkillConfigKey('My Skill')).toBe('My Skill')
    expect(normalizeSkillConfigKey('bad\nkey')).toBeNull()
  })
})

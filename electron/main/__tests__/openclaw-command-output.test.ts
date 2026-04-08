import { describe, expect, it } from 'vitest'

import { buildGeminiCliMissingMessage } from '../openclaw-oauth-dependencies'
import {
  getCliFailureMessage,
  normalizeCliFailureMessage,
  parseJsonFromCommandResult,
} from '../openclaw-command-output'

const RAW_GEMINI_PTY_FAILURE = `^D\b\b\r
🦞 OpenClaw 2026.3.12 (6472949)
\u001b[?25l│
◇  Gemini CLI OAuth ─╮
│  B                 │
│  r                 │
│  o                 │
│  w                 │
│  s                 │
│  e                 │
│  r                 │
├────────────────────╯
\r\u001b[2K◇  Gemini CLI OAuth failed
\u001b[?25h│
◇  OAuth help ─╮
│  T           │
│  r           │
│  o           │
│  u           │
│  b           │
│  l           │
│  e           │
├──────────────╯
Error: Gemini CLI not found. Install it first: brew install gemini-cli (or npm install -g @google/gemini-cli), or set GEMINI_CLI_OAUTH_CLIENT_ID.
\u001b[0m\u001b[?25h\u001b[?1000l\u001b[?1002l\u001b[?1003l\u001b[?1006l\u001b[?2004l`

const RAW_STALE_PLUGIN_WARNING =
  'Config warnings:\n- plugins.entries.MiniMax-M2.5: plugin not found: MiniMax-M2.5 (stale config entry ignored; remove it from plugins config)'
const RAW_GATEWAY_UNREADY_LOG =
  'I run on caffeine. Config overwrite: /Users/x/openclaw/openclaw.json (sha256 abc -> def). Gateway did not become reachable at ws://127.0.0.1:18789.'
const RAW_ALL_MODELS_FAILED =
  'Followup agent failed before reply: All models failed (4): google/gemini-3.1-pro-preview: API rate limit reached. (rate_limit) | xai/grok-vision-beta: Model context window too small (8192 tokens). Minimum is 16000. (unknown) | xai/grok-4-fast-non-reasoning: No API key found for provider "xai". (auth) | minimax-cn/MiniMax-M2.7-highspeed: No API key found for provider "minimax-cn". (auth)'

describe('normalizeCliFailureMessage', () => {
  it('compresses PTY/clack output into a readable Gemini prerequisite message', () => {
    expect(normalizeCliFailureMessage(RAW_GEMINI_PTY_FAILURE)).toBe(buildGeminiCliMissingMessage())
  })

  it('maps write-permission failures into a user-friendly write error', () => {
    expect(normalizeCliFailureMessage('permission denied')).toBe('配置写入失败，请检查本机权限后重试。')
  })

  it('maps multi-model fallback failures into a concise recovery message', () => {
    expect(normalizeCliFailureMessage(RAW_ALL_MODELS_FAILED)).toBe(
      '当前模型暂时不可用，备用模型也未就绪。请稍后重试，或到模型设置中切换到已配置模型。'
    )
  })
})

describe('getCliFailureMessage', () => {
  it('prefers normalized stderr over stdout', () => {
    expect(
      getCliFailureMessage(
        {
          stdout: 'raw stdout',
          stderr: RAW_GEMINI_PTY_FAILURE,
        },
        'fallback'
      )
    ).toContain('未检测到 Gemini 命令行工具')
  })

  it('prefers stdout when stderr only contains config warnings', () => {
    expect(
      getCliFailureMessage(
        {
          stdout: 'Error: This account requires GOOGLE_CLOUD_PROJECT or GOOGLE_CLOUD_PROJECT_ID to be set.',
          stderr: RAW_STALE_PLUGIN_WARNING,
        },
        'fallback'
      )
    ).toBe('Error: This account requires GOOGLE_CLOUD_PROJECT or GOOGLE_CLOUD_PROJECT_ID to be set.')
  })

  it('returns a structured message for noisy gateway-not-ready logs', () => {
    expect(
      getCliFailureMessage(
        {
          stdout: '',
          stderr: RAW_GATEWAY_UNREADY_LOG,
        },
        'fallback'
      )
    ).toBe('网关 token 已变更，请刷新后重新尝试')
  })

  it('hides internal multi-model fallback chains behind a user-facing recovery message', () => {
    expect(
      getCliFailureMessage(
        {
          stdout: '',
          stderr: RAW_ALL_MODELS_FAILED,
        },
        'fallback'
      )
    ).toBe('当前模型暂时不可用，备用模型也未就绪。请稍后重试，或到模型设置中切换到已配置模型。')
  })
})

describe('parseJsonFromCommandResult', () => {
  it('extracts JSON from stderr when stdout is empty', () => {
    expect(
      parseJsonFromCommandResult<{ skills: Array<{ name: string }> }>({
        stdout: '',
        stderr: 'Config warnings:\\n- stale plugin\\n{"skills":[{"name":"weather"}]}',
      })
    ).toEqual({
      skills: [{ name: 'weather' }],
    })
  })
})

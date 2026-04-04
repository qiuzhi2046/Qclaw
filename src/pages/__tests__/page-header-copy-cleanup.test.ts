import { describe, expect, it } from 'vitest'

const fs = process.getBuiltinModule('node:fs') as typeof import('node:fs')
const path = process.getBuiltinModule('node:path') as typeof import('node:path')

describe('page header copy cleanup', () => {
  it('does not keep the redundant models page catalog summary subtitle', () => {
    const modelsPageSource = fs.readFileSync(
      path.join(process.cwd(), 'src', 'pages', 'ModelsPage.tsx'),
      'utf8'
    )

    expect(modelsPageSource).not.toContain('{catalogSummary.label} · {catalogSummary.detail}')
  })

  it('does not keep the redundant skills page subtitle', () => {
    const skillsPageSource = fs.readFileSync(
      path.join(process.cwd(), 'src', 'pages', 'SkillsPage.tsx'),
      'utf8'
    )

    expect(skillsPageSource).not.toContain('查看和配置 OpenClaw Skills')
  })
})

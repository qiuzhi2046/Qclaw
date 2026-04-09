import { describe, expect, it } from 'vitest'

const fs = process.getBuiltinModule('node:fs') as typeof import('node:fs')
const path = process.getBuiltinModule('node:path') as typeof import('node:path')

describe('QClawUpdateDialog source', () => {
  it('does not expose the direct installer download button in the dialog actions', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/components/QClawUpdateDialog.tsx'),
      'utf8'
    )

    expect(source).not.toContain('直接下载最新安装包')
  })
})

import fs from 'fs'
import path from 'path'

const root = process.cwd()
const includeRoots = ['src', 'electron']
const exts = new Set(['.ts', '.tsx', '.js', '.jsx', '.json'])
const skipDirs = new Set(['node_modules', 'dist', 'dist-electron', 'build', 'docs', '.git', '__tests__'])

const results = []

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skipDirs.has(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(full)
      continue
    }
    if (/\.(test|spec)\./.test(entry.name)) continue
    if (!exts.has(path.extname(entry.name))) continue

    const text = fs.readFileSync(full, 'utf8')
    const lines = text.split('\n')

    for (let index = 0; index < lines.length; index += 1) {
      const raw = lines[index]
      if (!/[\p{Script=Han}]/u.test(raw)) continue
      const trimmed = raw.trim()
      if (!trimmed) continue
      if (
        trimmed.startsWith('//') ||
        trimmed.startsWith('/*') ||
        trimmed.startsWith('*') ||
        trimmed.startsWith('*/')
      ) {
        continue
      }
      results.push({
        file: path.relative(root, full),
        line: index + 1,
        raw: trimmed,
      })
    }
  }
}

for (const relativeRoot of includeRoots) {
  walk(path.join(root, relativeRoot))
}

results.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.raw.localeCompare(b.raw))
process.stdout.write(JSON.stringify(results, null, 2))

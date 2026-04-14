const fs = process.getBuiltinModule('node:fs') as typeof import('node:fs')
const path = process.getBuiltinModule('node:path') as typeof import('node:path')
const { access, chmod, copyFile, lstat, mkdir, readdir } = fs.promises

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath)
    return true
  } catch {
    return false
  }
}

async function copyManagedPath(sourcePath: string, targetPath: string): Promise<void> {
  const sourceStats = await lstat(sourcePath)
  if (sourceStats.isSymbolicLink()) {
    return
  }

  if (sourceStats.isDirectory()) {
    await mkdir(targetPath, { recursive: true })
    const entries = await readdir(sourcePath, { withFileTypes: true })
    for (const entry of entries) {
      await copyManagedPath(
        path.join(sourcePath, entry.name),
        path.join(targetPath, entry.name)
      )
    }
    return
  }

  if (!sourceStats.isFile()) {
    return
  }

  await mkdir(path.dirname(targetPath), { recursive: true })
  await copyFile(sourcePath, targetPath)
  await chmod(targetPath, sourceStats.mode & 0o777).catch(() => undefined)
}

export async function copyManagedPathIfExists(
  sourcePath: string,
  targetPath: string
): Promise<void> {
  if (!(await pathExists(sourcePath))) return
  await copyManagedPath(sourcePath, targetPath)
}

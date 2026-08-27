import { existsSync } from 'node:fs'
import path from 'node:path'

export function findPackageRoot(startDirectory: string): string | null {
  let current = startDirectory
  while (true) {
    if (existsSync(path.join(current, 'package.json'))) return current
    const parent = path.dirname(current)
    if (parent === current) return null
    current = parent
  }
}

import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

type Git = (root: string, args: string[], allowFailure?: boolean) => Promise<{ stdout: string; exitCode: number }>
type Version = [string, string, string, string, string]
type Stamp = [string, Version]
export type StatsDependencies = { key: string; files: Stamp[] }
export type StatsContext = {
  token: string
  active(): boolean
  dependencies(paths: string[]): Promise<StatsDependencies | undefined>
  unchanged(dependencies: StatsDependencies[]): Promise<boolean>
}
type Locations = { paths: string[]; guards: string[]; version: string }
type Configuration = { config: string; paths: string[]; version: string }
type Variables = { attrs: string[]; configs: string[] }

const locations = new WeakMap<Git, Map<string, Locations>>()
const configurations = new WeakMap<Git, Map<string, Configuration>>()
const variables = new WeakMap<Git, Map<string, Variables>>()
const generations = new Map<string, object>()
const MAX_FILES = 1024
const MAX_PATH = 4096
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const environment = () => Object.entries(process.env)
  .filter(([key]) => key.startsWith('GIT_') || ['HOME', 'XDG_CONFIG_HOME', 'PATH', 'PREFIX'].includes(key))
  .sort(([a], [b]) => a.localeCompare(b))

function cacheFor<T>(cache: WeakMap<Git, Map<string, T>>, git: Git): Map<string, T> {
  let entries = cache.get(git)
  if (!entries) cache.set(git, entries = new Map())
  return entries
}

function retain<T>(cache: Map<string, T>, key: string, value: T): void {
  cache.delete(key)
  cache.set(key, value)
  while (cache.size > 256) cache.delete(cache.keys().next().value!)
}

function checkedPath(value: string): string {
  if (!value || value.length > MAX_PATH || value.includes('\0') || !path.isAbsolute(value)) {
    throw new Error('unsupported dependency path')
  }
  return value
}

async function version(file: string): Promise<Version> {
  try {
    const info = await fs.stat(file, { bigint: true })
    // Device writes can change timestamps, but never the empty config/attribute content.
    if (file === '/dev/null' && info.isCharacterDevice()) return ['null', 'null', '0', '0', '0']
    if (!info.isFile() && !info.isDirectory()) throw new Error('unsupported dependency type')
    return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].map(String) as Version
  } catch (error) {
    if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
    const parent = path.dirname(file)
    if (parent === file) throw error
    // Keep deletion evidence for dependencies discovered only after numstat finishes.
    const stamp = await version(parent)
    return [`missing:${hash(stamp)}`, ...stamp.slice(1)] as Version
  }
}

async function snapshot(files: string[], started?: bigint): Promise<Stamp[]> {
  if (files.length > MAX_FILES) throw new Error('too many dependencies')
  return Promise.all([...new Set(files)].sort().map(async (file): Promise<Stamp> => {
    const stamp = await version(checkedPath(file))
    if (started !== undefined && BigInt(stamp[4]) > started) throw new Error('concurrent dependency change')
    return [file, stamp]
  }))
}

async function replacementPaths(root: string): Promise<string[]> {
  const files = [root]
  async function visit(directory: string, depth: number): Promise<void> {
    if (depth > 16) throw new Error('replacement refs too deep')
    let handle
    try { handle = await fs.opendir(directory) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    for await (const entry of handle) {
      if (files.length >= 128 || entry.isSymbolicLink()) throw new Error('unsupported replacement refs')
      const file = checkedPath(path.join(directory, entry.name))
      files.push(file)
      if (entry.isDirectory()) await visit(file, depth + 1)
      else if (!entry.isFile()) throw new Error('unsupported replacement ref')
    }
  }
  await visit(root, 0)
  return files
}

async function headPaths(gitDir: string, commonDir: string): Promise<string[]> {
  const files: string[] = []
  let file = path.join(gitDir, 'HEAD')
  for (let depth = 0; depth < 8; depth++) {
    files.push(file)
    let value: string
    try { value = await fs.readFile(file, 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return files
      throw error
    }
    if (value.length > MAX_PATH) throw new Error('unsupported HEAD')
    if (!value.startsWith('ref: ')) return files
    const ref = value.slice(5).trim()
    if (!ref.startsWith('refs/') || ref.includes('..') || ref.includes('\\')) throw new Error('unsupported HEAD ref')
    file = checkedPath(path.join(commonDir, ref))
  }
  throw new Error('HEAD refs too deep')
}

/** Validate only Git metadata and relevant attribute ancestors, never a worktree walk. */
export async function beginStatsContext(root: string, git: Git): Promise<StatsContext | undefined> {
  const generation = {}
  retain(generations, root, generation)
  const active = () => generations.get(root) === generation
  const started = BigInt(Date.now()) * 1_000_000n
  try {
    if (['GIT_REPLACE_REF_BASE', 'GIT_GRAFT_FILE', 'GIT_ATTR_SOURCE'].some((name) => process.env[name] !== undefined)) return undefined
    const env = environment()
    const envKey = hash(env)
    const run = async (args: string[], allowFailure = false) => {
      const result = await git(root, args, allowFailure)
      if (result.stdout.length > 1024 * 1024) throw new Error('discovery output too large')
      return result
    }
    const repositoryCache = cacheFor(locations, git)
    const repositoryKey = hash([await fs.realpath(root), env])
    const previous = repositoryCache.get(repositoryKey)
    let paths = previous?.paths
    if (!previous || hash(await snapshot(previous.guards)) !== previous.version) {
      paths = (await run(['rev-parse', '--path-format=absolute', '--show-toplevel', '--absolute-git-dir', '--git-common-dir',
        ...['index', 'shallow', 'info/attributes', 'packed-refs', 'refs/replace', 'info/grafts'].flatMap((file) => ['--git-path', file])])).stdout.replace(/\n$/, '').split('\n')
      if (paths.length !== 9 || paths[0] !== root) return undefined
      paths.forEach(checkedPath)
      const guards = [path.join(root, '.git'), path.join(paths[1]!, 'commondir')]
      retain(repositoryCache, repositoryKey, { paths, guards, version: hash(await snapshot(guards)) })
    }
    if (!paths) return undefined
    const [, gitDir, commonDir, index, shallow, infoAttrs, packedRefs, replaceRefs, grafts] = paths as [string, string, string, string, string, string, string, string, string]
    const configCache = cacheFor(configurations, git)
    const configurationKey = hash([paths, env])
    const oldConfig = configCache.get(configurationKey)
    const config = oldConfig && hash(await snapshot(oldConfig.paths)) === oldConfig.version
      ? oldConfig.config : (await run(['config', '--null', '--show-origin', '--list'])).stdout
    const records = config.split('\0')
    if (records.pop() !== '' || records.length % 2) return undefined
    const configFiles: string[] = []
    for (let offset = 0; offset < records.length; offset += 2) {
      const origin = records[offset]!
      const entry = records[offset + 1]!
      // Mutable attribute-tree refs require their own resolved-tree identity; do not cache them.
      if (/^extensions\.refstorage\n(?!files$)/i.test(entry) || /^attr\.tree\n/i.test(entry)) return undefined
      if (origin.startsWith('file:')) configFiles.push(checkedPath(path.resolve(root, origin.slice(5))))
      else if (origin !== 'command line:') return undefined
      const include = /^(?:include|includeif\..*)\.path\n([\s\S]+)$/i.exec(entry)
      if (include) {
        let target = include[1]!
        if (target.startsWith('~/') && process.env.HOME) target = path.join(process.env.HOME, target.slice(2))
        else if (target.startsWith('~') || target.includes('%(')) return undefined
        if (!path.isAbsolute(target) && !origin.startsWith('file:')) return undefined
        configFiles.push(checkedPath(path.resolve(root, path.dirname(origin.slice(5)), target)))
      }
    }
    const variableCache = cacheFor(variables, git)
    const variableKey = hash([root, config, env])
    let discovered = variableCache.get(variableKey)
    if (!discovered) {
      const attrs: string[] = []
      const configs: string[] = []
      for (const name of ['GIT_ATTR_GLOBAL', 'GIT_ATTR_SYSTEM', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM']) {
        const result = await run(['var', name], true)
        if (result.exitCode !== 0 && !(name.startsWith('GIT_CONFIG_') && result.exitCode === 1)) return undefined
        for (const value of result.stdout.replace(/\n$/, '').split('\n').filter(Boolean)) {
          (name.startsWith('GIT_ATTR_') ? attrs : configs).push(checkedPath(value))
        }
      }
      discovered = { attrs, configs }
      retain(variableCache, variableKey, discovered)
    }
    const configPaths = [...configFiles, ...discovered.configs, path.join(gitDir, 'HEAD'),
      path.join(gitDir, 'config'), path.join(commonDir, 'config'), path.join(gitDir, 'config.worktree')]
    const configVersions = await snapshot(configPaths, started)
    retain(configCache, configurationKey, { config, paths: configVersions.map(([file]) => file), version: hash(configVersions) })
    const base = await snapshot([index, shallow, infoAttrs, packedRefs, grafts, ...discovered.attrs, ...configPaths,
      ...await replacementPaths(replaceRefs), ...await headPaths(gitDir, commonDir)], started)
    const token = hash([paths, config, env, base])
    return {
      token, active,
      async dependencies(names) {
        try {
          if (names.length > MAX_FILES) return undefined
          const files = new Set([path.join(root, '.gitattributes')])
          for (const name of names) {
            if (!name || name.length > MAX_PATH || name.includes('\0') || path.isAbsolute(name)) return undefined
            const relative = path.relative(root, path.resolve(root, name))
            if (relative === '..' || relative.startsWith(`..${path.sep}`)) return undefined
            let directory = path.dirname(relative)
            while (directory !== '.') {
              files.add(path.join(root, directory, '.gitattributes'))
              if (files.size > MAX_FILES) return undefined
              directory = path.dirname(directory)
            }
          }
          const versions = await snapshot([...files], started)
          return { key: hash(versions), files: versions }
        } catch { return undefined }
      },
      async unchanged(dependencies) {
        try {
          if (!active() || hash(environment()) !== envKey) return false
          const expected = new Map<string, Version>()
          for (const dependency of dependencies) for (const [file, stamp] of dependency.files) {
            if (expected.has(file) && hash(expected.get(file)) !== hash(stamp)) return false
            expected.set(file, stamp)
          }
          const currentBase = await snapshot(base.map(([file]) => file))
          const currentAttrs = await snapshot([...expected.keys()])
          const sorted = [...expected].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
          return active() && hash(currentBase) === hash(base) && hash(currentAttrs) === hash(sorted)
        } catch { return false }
      },
    }
  } catch { return undefined }
}

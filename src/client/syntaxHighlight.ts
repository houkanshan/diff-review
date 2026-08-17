import type { ThemedToken } from 'shiki'

type HighlightTheme = 'light' | 'dark'

interface FileHighlight {
  language: string
  lines: ThemedToken[][]
}

const cache = new Map<string, Promise<FileHighlight | null>>()

const DIFFT_LANGUAGE_ALIASES: Record<string, string> = {
  typescript: 'typescript',
  'typescript tsx': 'tsx',
  javascript: 'javascript',
  'javascript jsx': 'jsx',
  python: 'python',
  rust: 'rust',
  go: 'go',
  ruby: 'ruby',
  java: 'java',
  json: 'json',
  html: 'html',
  css: 'css',
  scss: 'scss',
  less: 'less',
  markdown: 'markdown',
  yaml: 'yaml',
  toml: 'toml',
  shell: 'bash',
  bash: 'bash',
  sql: 'sql',
  swift: 'swift',
  kotlin: 'kotlin',
  c: 'c',
  'c++': 'cpp',
  cpp: 'cpp',
}

export function syntaxLanguageFor(
  filePath: string,
  language: string | undefined,
): string {
  const fromDifft = language?.trim().toLowerCase()
  if (fromDifft != null && fromDifft !== '' && fromDifft !== 'text' && fromDifft !== 'binary') {
    return DIFFT_LANGUAGE_ALIASES[fromDifft] ?? fromDifft.replaceAll(' ', '')
  }
  const extension = filePath.split('.').pop()?.toLowerCase()
  switch (extension) {
    case 'ts':
    case 'mts':
    case 'cts':
      return 'typescript'
    case 'tsx':
      return 'tsx'
    case 'js':
    case 'mjs':
    case 'cjs':
      return 'javascript'
    case 'jsx':
      return 'jsx'
    case 'py':
      return 'python'
    case 'rs':
      return 'rust'
    case 'go':
      return 'go'
    case 'rb':
      return 'ruby'
    case 'yml':
      return 'yaml'
    case 'md':
      return 'markdown'
    case 'kt':
      return 'kotlin'
    case 'cc':
    case 'cpp':
    case 'cxx':
    case 'hpp':
      return 'cpp'
    case 'css':
    case 'scss':
    case 'less':
    case 'json':
    case 'html':
    case 'xml':
    case 'yaml':
    case 'toml':
    case 'sh':
    case 'bash':
    case 'sql':
    case 'swift':
    case 'java':
    case 'c':
    case 'h':
      return extension
    default:
      return 'text'
  }
}

export async function highlightFileLines(
  source: string,
  language: string,
  theme: HighlightTheme,
): Promise<ThemedToken[][] | null> {
  if (source === '' || language === 'text' || language === 'binary') return null
  const key = `${theme}:${language}:${hashSource(source)}`
  const existing = cache.get(key)
  if (existing != null) return (await existing)?.lines ?? null

  const pending = loadTokens(source, language, theme)
  cache.set(key, pending)
  return (await pending)?.lines ?? null
}

async function loadTokens(
  source: string,
  language: string,
  theme: HighlightTheme,
): Promise<FileHighlight | null> {
  try {
    const { codeToTokens, isSpecialLang, bundledLanguages } = await import('shiki')
    if (!isSpecialLang(language) && !(language in bundledLanguages)) return null
    const result = await codeToTokens(source, {
      lang: language as keyof typeof bundledLanguages,
      theme: theme === 'dark' ? 'github-dark' : 'github-light',
    })
    return { language, lines: result.tokens }
  } catch {
    return null
  }
}

function hashSource(source: string): string {
  let hash = 2166136261
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return `${source.length.toString(36)}:${(hash >>> 0).toString(36)}`
}

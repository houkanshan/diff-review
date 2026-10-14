import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, expect, it, vi } from 'vitest'
import { AuthGate } from '../src/client/AuthGate'

afterEach(() => vi.unstubAllGlobals())

it('shows only a loading status before the initial cookie check completes', () => {
  const browserWindow = { parent: null as unknown }
  browserWindow.parent = browserWindow
  vi.stubGlobal('window', browserWindow)
  const markup = renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <AuthGate><div>Protected review</div></AuthGate>
    </QueryClientProvider>,
  )
  expect(markup).toContain('role="status"')
  expect(markup).toContain('Connecting…')
  expect(markup).not.toContain('<form')
  expect(markup).not.toContain('type="password"')
  expect(markup).not.toContain('Protected review')
})

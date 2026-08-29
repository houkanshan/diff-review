import { WorkerPoolContextProvider } from '@pierre/diffs/react'
import type { ReactNode } from 'react'
import workerUrl from '@pierre/diffs/worker/worker.js?worker&url'

function createPierreHighlightWorker(): Worker {
  return new Worker(workerUrl, { type: 'module' })
}

export function PierreWorkerPool({ children }: { children: ReactNode }) {
  return (
    <WorkerPoolContextProvider
      poolOptions={{
        poolSize: 2,
        workerFactory: createPierreHighlightWorker,
      }}
      highlighterOptions={{
        theme: { dark: 'pierre-dark', light: 'pierre-light' },
        lineDiffType: 'word-alt',
      }}
    >
      {children}
    </WorkerPoolContextProvider>
  )
}

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Tooltip } from '@base-ui/react/tooltip'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import App from './App'
import { ToastHost } from './Toasts'
import './styles.css'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      retry: false,
      refetchOnWindowFocus: false,
    },
  },
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastHost>
        <Tooltip.Provider delay={100}>
          <App />
        </Tooltip.Provider>
      </ToastHost>
    </QueryClientProvider>
  </StrictMode>,
)

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Tooltip } from '@base-ui/react/tooltip'

import App from './App'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Tooltip.Provider delay={100}>
      <App />
    </Tooltip.Provider>
  </StrictMode>,
)

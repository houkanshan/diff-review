import { Toast } from '@base-ui/react/toast'
import type { ReactNode } from 'react'

const toastManager = Toast.createToastManager()

export function showCopiedToast(title = 'Copied') {
  toastManager.add({
    id: 'copied',
    title,
    timeout: 1600,
  })
}

export function ToastHost({ children }: { children: ReactNode }) {
  return (
    <Toast.Provider toastManager={toastManager}>
      {children}
      <Toast.Portal>
        <Toast.Viewport className="toast-viewport">
          <ToastList />
        </Toast.Viewport>
      </Toast.Portal>
    </Toast.Provider>
  )
}

function ToastList() {
  const { toasts } = Toast.useToastManager()
  return toasts.map((toast) => (
    <Toast.Root key={toast.id} toast={toast} className="toast">
      <Toast.Content className="toast-content">
        <Toast.Title className="toast-title" />
      </Toast.Content>
    </Toast.Root>
  ))
}

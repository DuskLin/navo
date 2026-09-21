import { useEffect, useRef, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { OverlayScrollArea } from './OverlayScrollArea'

export function Modal({
  title,
  close,
  children,
  className = '',
  beforeContent,
  footer
}: {
  title: string
  close: () => void
  children: ReactNode
  className?: string
  beforeContent?: ReactNode
  footer?: ReactNode
}) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    ref.current?.showModal()
  }, [])
  return (
    <dialog
      ref={ref}
      className={`modal ${className}`}
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault()
        event.stopPropagation()
        close()
      }}
    >
      <div className="modal-heading">
        <h2>{title}</h2>
        <button type="button" className="icon-button" aria-label="关闭对话框" onClick={close}>
          <X size={18} />
        </button>
      </div>
      {beforeContent}
      <OverlayScrollArea label={`${title}内容`}>{children}</OverlayScrollArea>
      {footer}
    </dialog>
  )
}

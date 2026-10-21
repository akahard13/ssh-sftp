import type { ReactNode, JSX } from 'react'

interface ModalProps {
  title: string
  children: ReactNode
  onClose?: () => void
  footer?: ReactNode
  width?: number
}

export default function Modal({ title, children, onClose, footer, width }: ModalProps): JSX.Element {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <div
        className="modal"
        style={width ? { width } : undefined}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modal-header">
          <h2>{title}</h2>
          {onClose ? (
            <button type="button" className="icon-button" onClick={onClose} aria-label="Cerrar">
              ✕
            </button>
          ) : null}
        </header>
        <div className="modal-body">{children}</div>
        {footer ? <footer className="modal-footer">{footer}</footer> : null}
      </div>
    </div>
  )
}

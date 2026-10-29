import type { JSX } from 'react'
import Modal from './Modal'

interface UploadConfirmProps {
  remoteRoot: string
  backupFolder: string
  relPaths: string[]
  onClose: () => void
  onConfirm: () => void
}

/** Confirma la tanda y vuelve a mostrar la lista exacta de archivos que se subirán. */
export default function UploadConfirm({
  remoteRoot,
  backupFolder,
  relPaths,
  onClose,
  onConfirm
}: UploadConfirmProps): JSX.Element {
  const root = remoteRoot.replace(/\/$/, '')

  return (
    <Modal
      title={`Subir ${relPaths.length} archivo(s)`}
      width={640}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="ghost" onClick={onClose}>
            Cancelar
          </button>
          <button type="button" className="primary" onClick={onConfirm}>
            Subir {relPaths.length} archivo(s)
          </button>
        </>
      }
    >
      <p className="list-note">
        Destino: <code>{root}</code>. La versión actual del servidor se guardará en{' '}
        <code>{`${root}/${backupFolder}/<fecha>/…`}</code> antes de reemplazarla.
      </p>
      <ul className="dir-list">
        {relPaths.map((relPath) => (
          <li key={relPath} className="dir-row muted">
            📄 {relPath}
          </li>
        ))}
      </ul>
    </Modal>
  )
}

import { useState } from 'react'
import type { JSX } from 'react'
import Modal from './Modal'

interface PathListDialogProps {
  localRoot: string
  initial?: string
  onClose: () => void
  onSubmit: (paths: string[]) => void
}

function splitPaths(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

/** Pega rutas del proyecto local, una por línea, para subirlas de forma selectiva. */
export default function PathListDialog({
  localRoot,
  initial,
  onClose,
  onSubmit
}: PathListDialogProps): JSX.Element {
  const [text, setText] = useState(initial ?? '')
  const paths = splitPaths(text)

  return (
    <Modal
      title="Subir archivos por ruta"
      width={620}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="ghost" onClick={onClose}>
            Cancelar
          </button>
          <button
            type="button"
            className="primary"
            onClick={() => onSubmit(paths)}
            disabled={paths.length === 0}
          >
            Mostrar {paths.length || ''} ruta(s)
          </button>
        </>
      }
    >
      <p className="list-note">
        Una ruta por línea. Acepta rutas relativas a <code>{localRoot || 'la raíz local'}</code> o
        rutas absolutas del equipo. Si la ruta es una carpeta se incluyen todos sus archivos.
      </p>
      <textarea
        className="path-input"
        rows={12}
        spellCheck={false}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={'src/app.tsx\napp/Http/Controllers/UserController.php\nC:\\proyecto\\config\\app.php'}
        aria-label="Rutas a subir"
      />
    </Modal>
  )
}

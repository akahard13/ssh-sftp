import { mkdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { ValidationError } from './validate'

/** Evita leer o escribir fuera del directorio local elegido. */
export function assertLocalInside(root: string, target: string): void {
  const rel = relative(root, target)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new ValidationError('Ruta local fuera del directorio permitido.')
  }
}

/**
 * Escribe `payload` en `<localRoot>/<relPath>`, creando las carpetas que falten.
 * No sobrescribe: la descarga solo sirve para archivos que aún no existen en local.
 */
export async function writeLocalFile(
  localRoot: string,
  relPath: string,
  payload: Buffer
): Promise<string> {
  const root = resolve(localRoot)
  const target = resolve(root, ...relPath.split('/'))
  assertLocalInside(root, target)
  if (await stat(target).catch(() => null)) {
    throw new Error('Ya existe un archivo local en esa ruta. Vuelve a comparar para revisarlo.')
  }

  await mkdir(dirname(target), { recursive: true })
  const tmp = `${target}.download-${Date.now().toString(36)}`
  try {
    await writeFile(tmp, payload)
    await rename(tmp, target)
  } catch (err) {
    await unlink(tmp).catch(() => {})
    throw err
  }
  return target
}

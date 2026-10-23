export class ValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ValidationError'
  }
}

export function asObject(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ValidationError(`${field} debe ser un objeto.`)
  }
  return value as Record<string, unknown>
}

export function asString(
  value: unknown,
  field: string,
  opts: { max?: number; allowEmpty?: boolean; trim?: boolean } = {}
): string {
  const max = opts.max ?? 4096
  if (typeof value !== 'string') throw new ValidationError(`${field} debe ser texto.`)
  if (value.length > max) throw new ValidationError(`${field} excede el largo permitido.`)
  // El contenido de archivos, la entrada de terminal y los secretos no se
  // recortan: un salto de línea final o un espacio son parte del dato.
  const text = opts.trim === false ? value : value.trim()
  if (!opts.allowEmpty && text.length === 0) throw new ValidationError(`${field} es obligatorio.`)
  return text
}

export function asOptionalString(
  value: unknown,
  field: string,
  max = 4096,
  opts: { trim?: boolean } = {}
): string | null {
  if (value === null || value === undefined) return null
  const text = asString(value, field, { max, allowEmpty: true, trim: opts.trim })
  return text.length > 0 ? text : null
}

export function asNumber(
  value: unknown,
  field: string,
  opts: { min?: number; max?: number; integer?: boolean } = {}
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ValidationError(`${field} debe ser un número.`)
  }
  if (opts.integer && !Number.isInteger(value)) throw new ValidationError(`${field} debe ser entero.`)
  if (opts.min !== undefined && value < opts.min) throw new ValidationError(`${field} es menor al mínimo.`)
  if (opts.max !== undefined && value > opts.max) throw new ValidationError(`${field} excede el máximo.`)
  return value
}

export function asBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new ValidationError(`${field} debe ser booleano.`)
  return value
}

export function asEnum<T extends string>(value: unknown, field: string, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new ValidationError(`${field} tiene un valor no permitido.`)
  }
  return value as T
}

export function asAbsoluteRemotePath(value: unknown, field: string): string {
  const path = asString(value, field, { max: 2048 })
  if (!path.startsWith('/')) throw new ValidationError(`${field} debe ser una ruta absoluta.`)
  if (path.includes('\0')) throw new ValidationError(`${field} contiene caracteres inválidos.`)
  return path
}

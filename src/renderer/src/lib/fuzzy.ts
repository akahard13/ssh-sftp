/** Separadores y símbolos tras los que una coincidencia vale más. */
const BOUNDARY = '/\\._-: '

export interface FuzzyMatch {
  score: number
  /** Posiciones (en el texto original) de los caracteres que coinciden. */
  indices: number[]
}

/**
 * Coincidencia por subsecuencia, insensible a mayúsculas: cada carácter de
 * `query` debe aparecer en `text` en orden, no necesariamente seguido.
 * Puntúa más las coincidencias consecutivas y las que empiezan palabra, y
 * penaliza un poco las rutas largas para que los nombres cortos queden arriba.
 * Devuelve `null` si no hay coincidencia.
 */
export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  if (query.length === 0) return { score: 0, indices: [] }
  const needle = query.toLowerCase()
  const haystack = text.toLowerCase()
  if (needle.length > haystack.length) return null

  const indices: number[] = []
  let score = 0
  let cursor = 0
  let previous = -2

  for (let i = 0; i < needle.length; i += 1) {
    const found = haystack.indexOf(needle[i], cursor)
    if (found === -1) return null
    const consecutive = found === previous + 1
    const boundary = found === 0 || BOUNDARY.includes(text[found - 1])
    score += 1 + (consecutive ? 8 : 0) + (boundary ? 6 : 0)
    indices.push(found)
    previous = found
    cursor = found + 1
  }

  return { score: score - text.length * 0.05, indices }
}

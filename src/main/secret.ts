import { safeStorage } from 'electron'
import type { SecretCodec } from './store'

/**
 * Cifrado de secretos del escritorio: DPAPI en Windows, Keychain en macOS y
 * libsecret en Linux, siempre a través de Electron.
 */
export const electronSecretCodec: SecretCodec = {
  isAvailable: () => safeStorage.isEncryptionAvailable(),
  encrypt(plain: string): string {
    return safeStorage.encryptString(plain).toString('base64')
  },
  decrypt(stored: string): string | null {
    try {
      return safeStorage.decryptString(Buffer.from(stored, 'base64'))
    } catch {
      return null
    }
  }
}

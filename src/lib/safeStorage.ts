/**
 * Safe wrappers around localStorage that handle all failure modes:
 * - iOS Private Browsing (throws on setItem)
 * - Storage quota exceeded
 * - localStorage undefined (SSR or restricted context)
 */

export function safeGetItem(key: string): string | null {
  try {
    if (typeof localStorage === 'undefined') return null
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

export function safeSetItem(key: string, value: string): boolean {
  try {
    if (typeof localStorage === 'undefined') return false
    localStorage.setItem(key, value)
    return true
  } catch {
    return false
  }
}

export function safeRemoveItem(key: string): void {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.removeItem(key)
  } catch {
    // ignore
  }
}

export function safeSessionGetItem(key: string): string | null {
  try {
    if (typeof sessionStorage === 'undefined') return null
    return sessionStorage.getItem(key)
  } catch {
    return null
  }
}

export function safeSessionSetItem(key: string, value: string): boolean {
  try {
    if (typeof sessionStorage === 'undefined') return false
    sessionStorage.setItem(key, value)
    return true
  } catch {
    return false
  }
}

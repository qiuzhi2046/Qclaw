import { useState, useEffect, useCallback, useRef } from 'react'

interface TranslationResult {
  ok: boolean
  translatedText: string
  error?: string
}

interface UseTranslationOptions {
  enabled?: boolean
  source?: string
  target?: string
  debounceMs?: number
}

interface UseTranslationReturn {
  translated: string
  loading: boolean
  error: string | null
  original: string
  isTranslated: boolean
  retranslate: () => void
}

// Local cache for translations (persists across hook instances)
const localCache = new Map<string, string>()

// Callbacks to notify when cache is cleared
const clearCallbacks = new Set<() => void>()

/**
 * Hook for translating text using LibreTranslate API
 */
export function useTranslation(
  text: string,
  options: UseTranslationOptions = {}
): UseTranslationReturn {
  const {
    enabled = true,
    source = 'en',
    target = 'zh',
    debounceMs = 300,
  } = options

  const [translated, setTranslated] = useState(text)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null)
  const abortControllerRef = useRef<AbortController | null>(null)
  const cacheVersionRef = useRef(0)

  const cacheKey = `${source}:${target}:${text}`
  const isTranslated = translated !== text && !loading

  // Register for cache clear notifications
  useEffect(() => {
    const onCacheClear = () => {
      // Reset translated text to force re-translation
      setTranslated(text)
      cacheVersionRef.current++
    }

    clearCallbacks.add(onCacheClear)

    return () => {
      clearCallbacks.delete(onCacheClear)
    }
  }, [text])

  const doTranslate = useCallback(async () => {
    if (!enabled || !text) {
      setTranslated(text)
      return
    }

    console.log(`[useTranslation] Translating: "${text.substring(0, 30)}${text.length > 30 ? '...' : ''}"`)

    // Check if text contains Chinese (no translation needed)
    const hasChinese = /[\u4e00-\u9fa5]/.test(text)
    if (hasChinese) {
      console.log(`[useTranslation] Already contains Chinese`)
      setTranslated(text)
      return
    }

    // Check local cache first
    const cached = localCache.get(cacheKey)
    if (cached) {
      console.log(`[useTranslation] Local cache hit`)
      setTranslated(cached)
      return
    }

    // Abort previous request
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
    }
    abortControllerRef.current = new AbortController()

    setLoading(true)
    setError(null)

    try {
      console.log(`[useTranslation] Calling API...`)
      const result = (await window.api.translateText(
        text,
        source,
        target
      )) as TranslationResult

      console.log(`[useTranslation] API result:`, result)

      if (result.ok && result.translatedText) {
        localCache.set(cacheKey, result.translatedText)
        setTranslated(result.translatedText)
      } else {
        // Translation failed, use original text
        console.log(`[useTranslation] Translation failed:`, result.error)
        setTranslated(text)
        if (result.error) {
          setError(result.error)
        }
      }
    } catch (err) {
      // Error occurred, use original text
      console.error(`[useTranslation] Error:`, err)
      setTranslated(text)
      setError(err instanceof Error ? err.message : 'Translation failed')
    } finally {
      setLoading(false)
    }
  }, [text, enabled, source, target, cacheKey])

  const retranslate = useCallback(() => {
    localCache.delete(cacheKey)
    void doTranslate()
  }, [cacheKey, doTranslate])

  useEffect(() => {
    if (!enabled) {
      setTranslated(text)
      return
    }

    // Clear previous timer
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current)
    }

    // Debounce the translation
    debounceTimerRef.current = setTimeout(() => {
      void doTranslate()
    }, debounceMs)

    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current)
      }
      if (abortControllerRef.current) {
        abortControllerRef.current.abort()
      }
    }
  }, [enabled, text, debounceMs, doTranslate])

  return {
    translated,
    loading,
    error,
    original: text,
    isTranslated,
    retranslate,
  }
}

/**
 * Clear local translation cache and trigger re-translation
 */
export function clearLocalTranslationCache(): void {
  localCache.clear()
  // Notify all registered callbacks to re-translate
  clearCallbacks.forEach((callback) => callback())
}

/**
 * Get local cache size
 */
export function getLocalTranslationCacheSize(): number {
  return localCache.size
}

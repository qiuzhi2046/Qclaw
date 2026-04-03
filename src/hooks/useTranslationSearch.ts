import { useState, useEffect, useMemo, useRef } from 'react'

interface TranslationResult {
  ok: boolean
  translatedText: string
  error?: string
}

/**
 * Hook for searching items with translation support
 * Pre-translates all descriptions to support Chinese search
 */
export function useTranslationSearch<T>(
  items: T[],
  getText: (item: T) => string,
  searchQuery: string
): { filteredItems: T[]; isTranslating: boolean; translatedMap: Map<string, string> } {
  const [translatedMap, setTranslatedMap] = useState<Map<string, string>>(new Map())
  const [isTranslating, setIsTranslating] = useState(false)
  const abortControllerRef = useRef<AbortController | null>(null)

  // Translate all unique texts
  useEffect(() => {
    const uniqueTexts = [...new Set(items.map(getText).filter(Boolean))]
    
    // Filter out already translated texts or texts with Chinese
    const textsToTranslate = uniqueTexts.filter(text => {
      if (translatedMap.has(text)) return false
      // Already contains Chinese, no translation needed
      if (/[\u4e00-\u9fa5]/.test(text)) {
        return false
      }
      return true
    })

    if (textsToTranslate.length === 0) return

    // Abort previous translations
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
    }
    abortControllerRef.current = new AbortController()

    const translateAll = async () => {
      setIsTranslating(true)
      
      try {
        // Batch translate with concurrency limit
        const batchSize = 5
        const results = new Map<string, string>()
        
        for (let i = 0; i < textsToTranslate.length; i += batchSize) {
          if (abortControllerRef.current?.signal.aborted) break
          
          const batch = textsToTranslate.slice(i, i + batchSize)
          const translations = await Promise.all(
            batch.map(async (text) => {
              try {
                const result = await window.api.translateText(text, 'en', 'zh') as TranslationResult
                return { text, translated: result.ok ? result.translatedText : text }
              } catch {
                return { text, translated: text }
              }
            })
          )
          
          translations.forEach(({ text, translated }) => {
            results.set(text, translated)
          })
        }
        
        setTranslatedMap(prev => new Map([...prev, ...results]))
      } catch (error) {
        // Ignore abort errors
        if (error instanceof Error && error.message.includes('abort')) return
        console.error('Translation batch failed:', error)
      } finally {
        setIsTranslating(false)
      }
    }

    void translateAll()

    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort()
      }
    }
  }, [items, getText, translatedMap])

  // Filter items based on search query
  const filteredItems = useMemo(() => {
    if (!searchQuery.trim()) return items
    
    const query = searchQuery.toLowerCase()
    
    return items.filter(item => {
      const text = getText(item)
      const original = text.toLowerCase()
      const translated = translatedMap.get(text)?.toLowerCase() || original
      
      // Match against both original and translated text
      return original.includes(query) || translated.includes(query)
    })
  }, [items, getText, searchQuery, translatedMap])

  return { filteredItems, isTranslating, translatedMap }
}

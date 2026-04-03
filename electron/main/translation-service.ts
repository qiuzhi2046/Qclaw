/**
 * Translation service using multiple translation APIs
 * Primary: MyMemory API (free, no API key, works reliably in China)
 * Fallback: Google Translate (unofficial free API, used when MyMemory quota is exceeded)
 * https://mymemory.translated.net/doc/spec.php
 */

import { app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'

interface TranslationResult {
  ok: boolean
  translatedText: string
  error?: string
}

interface TranslateRequest {
  text: string
  source?: string
  target?: string
}

interface TranslationCacheData {
  version: number
  translations: Record<string, string>
}

// In-memory cache for translations
const translationCache = new Map<string, string>()

// Persistent cache file path
let cacheFilePath: string | null = null
let saveTimeout: NodeJS.Timeout | null = null
let isCacheLoaded = false

const CACHE_VERSION = 1
const SAVE_DELAY_MS = 2000 // Save after 2 seconds of inactivity

// Request queue with rate limiting
interface QueuedRequest {
  text: string
  source: string
  target: string
  resolve: (result: TranslationResult) => void
  reject: (error: Error) => void
}

const requestQueue: QueuedRequest[] = []
let isProcessingQueue = false
let lastRequestTime = 0
const REQUEST_INTERVAL_MS = 500 // Wait 500ms between requests (2 requests/second)
const CONCURRENT_LIMIT = 3 // Max 3 concurrent requests

/**
 * Detect if text contains Chinese characters
 */
export function containsChinese(text: string): boolean {
  return /[\u4e00-\u9fa5]/.test(text)
}

/**
 * Check if text needs translation (is English and not too short)
 */
export function needsTranslation(text: string): boolean {
  if (!text || text.length < 2) return false
  if (containsChinese(text)) return false
  // Check if text is primarily English (letters, numbers, common punctuation)
  const englishPattern = /^[A-Za-z0-9\s.,!?;:'"()\[\]{}@#$%^&*\-_+=<>\/\\|`~]+$/
  return englishPattern.test(text)
}



/**
 * Get the cache file path
 */
function getCacheFilePath(): string {
  if (!cacheFilePath) {
    const userDataPath = app.getPath('userData')
    cacheFilePath = path.join(userDataPath, 'translation-cache.json')
  }
  return cacheFilePath
}

/**
 * Load translation cache from disk
 */
export function loadTranslationCache(): void {
  if (isCacheLoaded) return

  try {
    const filePath = getCacheFilePath()
    if (fs.existsSync(filePath)) {
      const data = fs.readFileSync(filePath, 'utf-8')
      const cacheData = JSON.parse(data) as TranslationCacheData

      if (cacheData.version === CACHE_VERSION && cacheData.translations) {
        Object.entries(cacheData.translations).forEach(([key, value]) => {
          translationCache.set(key, value)
        })
      }
    }
  } catch (error) {
    // Silent error handling
  } finally {
    isCacheLoaded = true
  }
}

/**
 * Clear translation cache (both memory and disk)
 */
export function clearTranslationCache(): void {
  try {
    // Clear in-memory cache
    const size = translationCache.size
    translationCache.clear()
    
    // Delete cache file
    const filePath = getCacheFilePath()
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath)
    }
  } catch (error) {
    // Silent error handling
  }
}

/**
 * Save translation cache to disk (debounced)
 */
function saveCacheToDisk(): void {
  if (saveTimeout) {
    clearTimeout(saveTimeout)
  }

  saveTimeout = setTimeout(() => {
    try {
      const filePath = getCacheFilePath()
      const cacheData: TranslationCacheData = {
        version: CACHE_VERSION,
        translations: Object.fromEntries(translationCache),
      }
      fs.writeFileSync(filePath, JSON.stringify(cacheData, null, 2), 'utf-8')
    } catch (error) {
      // Silent error handling
    }
  }, SAVE_DELAY_MS)
}

/**
 * Initialize translation service - call on app ready
 */
export function initTranslationService(): void {
  loadTranslationCache()

  // Save cache on app quit
  app.on('will-quit', () => {
    if (saveTimeout) {
      clearTimeout(saveTimeout)
    }
    // Synchronous save on quit
    try {
      const filePath = getCacheFilePath()
      const cacheData: TranslationCacheData = {
        version: CACHE_VERSION,
        translations: Object.fromEntries(translationCache),
      }
      fs.writeFileSync(filePath, JSON.stringify(cacheData), 'utf-8')
    } catch {
      // Ignore errors during quit
    }
  })
}

/**
 * Translate using MyMemory API (free, no API key required)
 * https://mymemory.translated.net/doc/spec.php
 * This is the primary translation service as it works reliably in China
 */
async function translateWithMyMemory(
  text: string,
  source: string,
  target: string
): Promise<TranslationResult> {
  try {
    const langPair = `${source}|${target}`
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${langPair}`

    // Create abort controller for timeout
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 15000) // 15 second timeout (increased for slow networks)

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      signal: controller.signal,
    })

    clearTimeout(timeoutId)

    if (!response.ok) {
      return { ok: false, translatedText: text, error: `HTTP ${response.status}` }
    }

    const data = (await response.json()) as {
      responseStatus?: number
      responseData?: { translatedText?: string }
      matches?: Array<{ translation?: string; quality?: number }>
      quotaFinished?: boolean
    }

    // Check if quota is finished
    if (data.quotaFinished) {
      return { ok: false, translatedText: text, error: 'API quota exceeded' }
    }

    // Check response status
    if (data.responseStatus !== 200) {
      return { ok: false, translatedText: text, error: 'Translation failed' }
    }

    // Get the best translation
    let translatedText = data.responseData?.translatedText

    // If we have matches, use the highest quality one
    if (data.matches && data.matches.length > 0) {
      const bestMatch = data.matches.reduce((best, current) => {
        return (current.quality || 0) > (best.quality || 0) ? current : best
      })
      if (bestMatch.translation) {
        translatedText = bestMatch.translation
      }
    }

    if (translatedText) {
      return { ok: true, translatedText }
    }

    return { ok: false, translatedText: text, error: 'No translation returned' }
  } catch (error) {
    // Don't log errors during process shutdown to avoid EPIPE
    const errorMessage = error instanceof Error ? error.message : 'Network error'

    // Ignore abort errors and return original text
    if (errorMessage.includes('abort') || errorMessage.includes('EPIPE')) {
      return { ok: false, translatedText: text, error: 'Request cancelled' }
    }

    return {
      ok: false,
      translatedText: text,
      error: errorMessage,
    }
  }
}

/**
 * Translate using Google Translate (unofficial free API)
 * Fallback when MyMemory quota is exceeded
 * Note: This is an unofficial API that may have limitations
 */
async function translateWithGoogle(
  text: string,
  source: string,
  target: string
): Promise<TranslationResult> {
  try {
    // Google Translate uses different language codes
    const langMap: Record<string, string> = {
      'zh': 'zh-CN',
      'en': 'en',
    }

    const sourceLang = langMap[source] || source
    const targetLang = langMap[target] || target

    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${sourceLang}&tl=${targetLang}&dt=t&q=${encodeURIComponent(text)}`

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 15000)

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      signal: controller.signal,
    })

    clearTimeout(timeoutId)

    if (!response.ok) {
      return { ok: false, translatedText: text, error: `HTTP ${response.status}` }
    }

    const data = await response.json() as any[]

    // Parse response: data[0] contains an array of [translation, source] tuples
    if (data && data[0]) {
      const translatedText = data[0].map((item: any) => item[0]).filter(Boolean).join('')

      if (translatedText) {
        return { ok: true, translatedText }
      }
    }

    return { ok: false, translatedText: text, error: 'No translation returned' }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Network error'

    if (errorMessage.includes('abort') || errorMessage.includes('EPIPE')) {
      return { ok: false, translatedText: text, error: 'Request cancelled' }
    }

    return {
      ok: false,
      translatedText: text,
      error: errorMessage,
    }
  }
}

/**
 * Internal translation function without queue (used by queue processor)
 * Uses MyMemory API as primary, Google Translate as fallback
 */
async function doTranslateInternal(text: string, source: string, target: string): Promise<TranslationResult> {
  // Check cache
  const cacheKey = `${source}:${target}:${text}`
  const cached = translationCache.get(cacheKey)
  if (cached) {
    return { ok: true, translatedText: cached }
  }

  // Try MyMemory first (works reliably in China, provides complete translations)
  const myMemoryResult = await translateWithMyMemory(text, source, target)

  // If MyMemory succeeds, cache and return
  if (myMemoryResult.ok && myMemoryResult.translatedText !== text) {
    translationCache.set(cacheKey, myMemoryResult.translatedText)
    saveCacheToDisk()
    return myMemoryResult
  }

  // If MyMemory fails due to quota, try Google Translate as fallback
  if (myMemoryResult.error?.includes('quota') || myMemoryResult.error?.includes('429')) {
    console.log(`[Translation] MyMemory quota exceeded, falling back to Google Translate`)
    const googleResult = await translateWithGoogle(text, source, target)

    if (googleResult.ok && googleResult.translatedText !== text) {
      translationCache.set(cacheKey, googleResult.translatedText)
      saveCacheToDisk()
      return {
        ok: true,
        translatedText: googleResult.translatedText,
      }
    }

    // Both services failed
    return {
      ok: false,
      translatedText: text,
      error: `Translation failed (MyMemory: ${myMemoryResult.error}, Google: ${googleResult.error})`,
    }
  }

  // Translation failed for other reasons
  return {
    ok: false,
    translatedText: text,
    error: myMemoryResult.error || 'Translation service unavailable',
  }
}

/**
 * Process translation queue with rate limiting
 */
async function processQueue(): Promise<void> {
  if (isProcessingQueue || requestQueue.length === 0) {
    return
  }

  isProcessingQueue = true

  const processNext = async (): Promise<void> => {
    if (requestQueue.length === 0) {
      isProcessingQueue = false
      return
    }

    // Enforce rate limiting
    const now = Date.now()
    const timeSinceLastRequest = now - lastRequestTime
    if (timeSinceLastRequest < REQUEST_INTERVAL_MS) {
      await new Promise((resolve) => setTimeout(resolve, REQUEST_INTERVAL_MS - timeSinceLastRequest))
    }

    // Process up to CONCURRENT_LIMIT requests
    const batch = requestQueue.splice(0, Math.min(CONCURRENT_LIMIT, requestQueue.length))
    lastRequestTime = Date.now()

    await Promise.all(
      batch.map(async (req) => {
        try {
          const result = await doTranslateInternal(req.text, req.source, req.target)
          req.resolve(result)
        } catch (error) {
          req.reject(error instanceof Error ? error : new Error(String(error)))
        }
      })
    )

    // Continue processing next batch
    await processNext()
  }

  await processNext()
}

/**
 * Translate text using multiple translation APIs with fallback (with rate limiting)
 */
export async function translateText(request: TranslateRequest): Promise<TranslationResult> {
  const { text, source = 'en', target = 'zh' } = request

  // Return original text if it contains Chinese
  if (containsChinese(text)) {
    return { ok: true, translatedText: text }
  }

  // Check cache first
  const cacheKey = `${source}:${target}:${text}`
  const cached = translationCache.get(cacheKey)
  if (cached) {
    return { ok: true, translatedText: cached }
  }

  // Add to queue and wait for result
  return new Promise((resolve, reject) => {
    requestQueue.push({
      text,
      source,
      target,
      resolve,
      reject,
    })
    
    // Start processing queue
    processQueue().catch(() => {
      // Silent error handling
    })
  })
}

/**
 * Batch translate multiple texts
 */
export async function translateBatch(
  texts: string[],
  options?: { source?: string; target?: string }
): Promise<TranslationResult[]> {
  return Promise.all(
    texts.map((text) =>
      translateText({
        text,
        source: options?.source,
        target: options?.target,
      })
    )
  )
}

/**
 * Get cache size
 */
export function getTranslationCacheSize(): number {
  return translationCache.size
}

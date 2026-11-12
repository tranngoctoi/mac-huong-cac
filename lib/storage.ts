import {
  Chapter,
  CustomFontRecord,
  GlossaryEntry,
  InstructionProfile,
  ModelConfigState,
  NovelLibrarySummary,
  NovelProject,
  ReaderHighlight,
  ReaderSettings,
  ReadingBookmark,
} from './types';
import {
  DEFAULT_EDITORIAL_INSTRUCTION_ID,
  DEFAULT_GLOSSARY_ENTRIES,
  DEFAULT_INSTRUCTION_ID,
  DEFAULT_INSTRUCTION_PROFILES,
  DEFAULT_NOVEL_ID,
  DEFAULT_NOVEL_PROJECT,
  DEFAULT_READER_SETTINGS,
  SEED_CHAPTER_FILES,
} from './seed-data';
import { cleanRawChapterBody } from './file-engine';
import { DEFAULT_QA_VALIDATION_RULES } from './qa-scanner';
import { logger, safeFetchJson } from './logger';

const DB_NAME = 'MacHuongCacStudioDB';
const DB_VERSION = 2;

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('novels')) {
        db.createObjectStore('novels', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('chapters')) {
        const chapterStore = db.createObjectStore('chapters', { keyPath: 'id' });
        chapterStore.createIndex('novelId', 'novelId', { unique: false });
      }
      if (!db.objectStoreNames.contains('glossary')) {
        const glossaryStore = db.createObjectStore('glossary', { keyPath: 'id' });
        glossaryStore.createIndex('novelId', 'novelId', { unique: false });
      }
      if (!db.objectStoreNames.contains('instructions')) {
        db.createObjectStore('instructions', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('customFonts')) {
        db.createObjectStore('customFonts', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('highlights')) {
        const hlStore = db.createObjectStore('highlights', { keyPath: 'id' });
        hlStore.createIndex('novelId', 'novelId', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function getAllNovels(): Promise<NovelProject[]> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('novels', 'readonly');
    const req = tx.objectStore('novels').getAll();
    req.onsuccess = () => {
      const items = (req.result as NovelProject[]) || [];
      items.sort((a, b) => {
        if (Boolean(a.pinned) !== Boolean(b.pinned)) {
          return a.pinned ? -1 : 1;
        }
        return b.updatedAt - a.updatedAt;
      });
      resolve(items);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function saveNovel(novel: NovelProject): Promise<void> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('novels', 'readwrite');
    tx.objectStore('novels').put(novel);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function deleteNovelAndData(novelId: string): Promise<void> {
  const db = await openDatabase();
  const chapters = await getChaptersByNovel(novelId);
  const glossary = await getGlossaryByNovel(novelId);
  const highlights = await getHighlightsByNovel(novelId);
  if (typeof window !== 'undefined') {
    localStorage.removeItem(`mhc_reading_bookmark_${novelId}`);
  }
  return new Promise((resolve, reject) => {
    const tx = db.transaction(
      ['novels', 'chapters', 'glossary', 'highlights'],
      'readwrite'
    );
    tx.objectStore('novels').delete(novelId);
    const chStore = tx.objectStore('chapters');
    for (const ch of chapters) chStore.delete(ch.id);
    const glStore = tx.objectStore('glossary');
    for (const g of glossary) glStore.delete(g.id);
    const hlStore = tx.objectStore('highlights');
    for (const h of highlights) hlStore.delete(h.id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function deleteAllNovelsAndData(): Promise<void> {
  const db = await openDatabase();
  const novels = await getAllNovels();
  if (typeof window !== 'undefined') {
    for (const n of novels) {
      localStorage.removeItem(`mhc_reading_bookmark_${n.id}`);
    }
    localStorage.removeItem('mhc_active_novel_id_v1');
    localStorage.setItem('mhc_initial_seed_completed_v1', 'true');
  }
  return new Promise((resolve, reject) => {
    const tx = db.transaction(
      ['novels', 'chapters', 'glossary', 'highlights'],
      'readwrite'
    );
    tx.objectStore('novels').clear();
    tx.objectStore('chapters').clear();
    tx.objectStore('glossary').clear();
    tx.objectStore('highlights').clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getAllNovelLibrarySummaries(
  novels: NovelProject[]
): Promise<Record<string, NovelLibrarySummary>> {
  const result: Record<string, NovelLibrarySummary> = {};
  for (const n of novels) {
    result[n.id] = {
      novelId: n.id,
      totalChapters: 0,
      translatedChapters: 0,
      editedChapters: 0,
      rawChapters: 0,
      errorChapters: 0,
      totalRawChars: 0,
      totalTranslatedWords: 0,
      glossaryCount: 0,
      highlightCount: 0,
      bookmark: loadReadingBookmark(n.id),
    };
  }
  if (novels.length === 0) return result;

  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['chapters', 'glossary', 'highlights'], 'readonly');
    const chReq = tx.objectStore('chapters').getAll();
    const glReq = tx.objectStore('glossary').getAll();
    const hlReq = tx.objectStore('highlights').getAll();

    tx.oncomplete = () => {
      const allChapters = (chReq.result as Chapter[]) || [];
      for (const ch of allChapters) {
        const summary = result[ch.novelId];
        if (!summary) continue;
        summary.totalChapters++;
        summary.totalRawChars += ch.charCount || 0;
        const cleanBody = (ch.translatedContent || '')
          .replace(/\u200B/g, '')
          .trim();
        const effectiveStatus =
          (ch.status === 'translated' ||
            ch.status === 'edited' ||
            ch.status === 'translating' ||
            ch.status === 'queued') &&
          cleanBody.length === 0
            ? 'raw'
            : ch.status;

        if (effectiveStatus === 'translated' || effectiveStatus === 'edited') {
          summary.translatedChapters++;
        }
        if (effectiveStatus === 'edited') {
          summary.editedChapters++;
        }
        if (effectiveStatus === 'raw') {
          summary.rawChapters++;
        }
        if (effectiveStatus === 'error') {
          summary.errorChapters++;
        }
        if (cleanBody) {
          summary.totalTranslatedWords += cleanBody
            .split(/\s+/)
            .filter(Boolean).length;
        }
      }

      const allGlossary = (glReq.result as GlossaryEntry[]) || [];
      for (const g of allGlossary) {
        if (result[g.novelId]) {
          result[g.novelId].glossaryCount++;
        }
      }

      const allHighlights = (hlReq.result as ReaderHighlight[]) || [];
      for (const h of allHighlights) {
        if (result[h.novelId]) {
          result[h.novelId].highlightCount++;
        }
      }

      resolve(result);
    };
    tx.onerror = () => reject(tx.error);
  });
}

export async function duplicateNovelProject(
  sourceNovel: NovelProject,
  copyGlossary = true
): Promise<NovelProject> {
  const now = Date.now();
  const newNovelId = `novel-${now}`;
  const clonedNovel: NovelProject = {
    ...sourceNovel,
    id: newNovelId,
    title: `${sourceNovel.title} (Bản sao)`,
    pinned: false,
    createdAt: now,
    updatedAt: now,
  };
  await saveNovel(clonedNovel);

  if (copyGlossary) {
    const sourceGlossary = await getGlossaryByNovel(sourceNovel.id);
    if (sourceGlossary.length > 0) {
      const clonedGlossary: GlossaryEntry[] = sourceGlossary.map((g, idx) => ({
        ...g,
        id: `gl-${newNovelId}-${idx + 1}`,
        novelId: newNovelId,
      }));
      await saveGlossaryEntriesBulk(clonedGlossary);
    }
  }

  return clonedNovel;
}

export async function getChaptersByNovel(novelId: string): Promise<Chapter[]> {
  const db = await openDatabase();
  const { list, healedToPersist } = await new Promise<{
    list: Chapter[];
    healedToPersist: Chapter[];
  }>((resolve, reject) => {
    const tx = db.transaction('chapters', 'readonly');
    const idx = tx.objectStore('chapters').index('novelId');
    const req = idx.getAll(novelId);
    req.onsuccess = () => {
      const healedToPersist: Chapter[] = [];
      const list = ((req.result as Chapter[]) || []).map((ch) => {
        const cleanTitle = normalizeVietnameseText(ch.titleTranslated || '');
        const cleanContent = normalizeVietnameseText(ch.translatedContent || '');
        const hasVisibleContent =
          cleanContent.replace(/\u200B/g, '').trim().length > 0;

        // Auto-heal ghost-translated or stuck chapters whose translatedContent is empty
        if (
          !hasVisibleContent &&
          (ch.status === 'translated' ||
            ch.status === 'edited' ||
            ch.status === 'translating' ||
            ch.status === 'queued')
        ) {
          const healed: Chapter = {
            ...ch,
            titleTranslated: '',
            translatedContent: '',
            status: 'raw',
            translatedByModel: undefined,
            lastKeyUsed: undefined,
            alignment: undefined,
            qaReport: undefined,
            lastError: undefined,
            updatedAt: Date.now(),
          };
          healedToPersist.push(healed);
          return healed;
        }

        return {
          ...ch,
          titleTranslated: cleanTitle,
          translatedContent: cleanContent,
        };
      });
      list.sort((a, b) => {
        const cmpPrefix = a.orderPrefix.localeCompare(b.orderPrefix, undefined, {
          numeric: true,
        });
        if (cmpPrefix !== 0) return cmpPrefix;
        return a.chapterNumber - b.chapterNumber;
      });
      resolve({ list, healedToPersist });
    };
    req.onerror = () => reject(req.error);
  });

  if (healedToPersist.length > 0) {
    logger.info(
      'STORAGE',
      `⚡ Đã tự động khôi phục ${healedToPersist.length} chương bị trạng thái "Hoàn thành ảo / Đang dịch kẹt" (nội dung dịch trống 0 ký tự) về trạng thái "Chưa dịch" để sẵn sàng dịch lại: ${healedToPersist
        .slice(0, 12)
        .map((c) => `#${c.orderPrefix}`)
        .join(', ')}${healedToPersist.length > 12 ? '...' : ''}`,
      {
        novelId,
        healedCount: healedToPersist.length,
        healedOrderPrefixes: healedToPersist.map((c) => c.orderPrefix),
      }
    );
    try {
      await saveChaptersBulk(healedToPersist);
    } catch {
      // Ignore background persistence error
    }
  }

  return list;
}

export async function saveChapter(chapter: Chapter): Promise<void> {
  const db = await openDatabase();
  const cleanTitle = normalizeVietnameseText(chapter.titleTranslated || '');
  const cleanContent = normalizeVietnameseText(chapter.translatedContent || '');
  const hasVisibleContent =
    cleanContent.replace(/\u200B/g, '').trim().length > 0;
  const safeStatus =
    !hasVisibleContent &&
    (chapter.status === 'translated' || chapter.status === 'edited')
      ? 'raw'
      : chapter.status;

  const normalized: Chapter = {
    ...chapter,
    titleTranslated: cleanTitle,
    translatedContent: cleanContent,
    status: safeStatus,
    translatedByModel:
      safeStatus === 'raw' ? undefined : chapter.translatedByModel,
    alignment: safeStatus === 'raw' ? undefined : chapter.alignment,
  };
  return new Promise((resolve, reject) => {
    const tx = db.transaction('chapters', 'readwrite');
    tx.objectStore('chapters').put(normalized);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function saveChaptersBulk(chapters: Chapter[]): Promise<void> {
  if (chapters.length === 0) return;
  const db = await openDatabase();
  const CHUNK_SIZE = 400;
  for (let i = 0; i < chapters.length; i += CHUNK_SIZE) {
    const slice = chapters.slice(i, i + CHUNK_SIZE);
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('chapters', 'readwrite');
      const store = tx.objectStore('chapters');
      for (const ch of slice) {
        const cleanTitle = normalizeVietnameseText(ch.titleTranslated || '');
        const cleanContent = normalizeVietnameseText(ch.translatedContent || '');
        const hasVisibleContent =
          cleanContent.replace(/\u200B/g, '').trim().length > 0;
        const safeStatus =
          !hasVisibleContent &&
          (ch.status === 'translated' || ch.status === 'edited')
            ? 'raw'
            : ch.status;

        store.put({
          ...ch,
          titleTranslated: cleanTitle,
          translatedContent: cleanContent,
          status: safeStatus,
          translatedByModel:
            safeStatus === 'raw' ? undefined : ch.translatedByModel,
          alignment: safeStatus === 'raw' ? undefined : ch.alignment,
        });
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
}

export async function deleteChaptersBulk(chapterIds: string[]): Promise<void> {
  if (chapterIds.length === 0) return;
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('chapters', 'readwrite');
    const store = tx.objectStore('chapters');
    for (const id of chapterIds) {
      store.delete(id);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getGlossaryByNovel(novelId: string): Promise<GlossaryEntry[]> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('glossary', 'readonly');
    const idx = tx.objectStore('glossary').index('novelId');
    const req = idx.getAll(novelId);
    req.onsuccess = () => resolve((req.result as GlossaryEntry[]) || []);
    req.onerror = () => reject(req.error);
  });
}

export async function saveGlossaryEntriesBulk(entries: GlossaryEntry[]): Promise<void> {
  if (entries.length === 0) return;
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('glossary', 'readwrite');
    const store = tx.objectStore('glossary');
    for (const item of entries) {
      store.put(item);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function deleteGlossaryEntry(id: string): Promise<void> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('glossary', 'readwrite');
    tx.objectStore('glossary').delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function deleteGlossaryEntriesBulk(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('glossary', 'readwrite');
    const store = tx.objectStore('glossary');
    for (const id of ids) {
      store.delete(id);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getAllInstructions(): Promise<InstructionProfile[]> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('instructions', 'readonly');
    const req = tx.objectStore('instructions').getAll();
    req.onsuccess = () => resolve((req.result as InstructionProfile[]) || []);
    req.onerror = () => reject(req.error);
  });
}

export async function saveInstructionProfile(profile: InstructionProfile): Promise<void> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('instructions', 'readwrite');
    tx.objectStore('instructions').put(profile);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function deleteInstructionProfile(id: string): Promise<void> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('instructions', 'readwrite');
    tx.objectStore('instructions').delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getAllCustomFonts(): Promise<CustomFontRecord[]> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('customFonts', 'readonly');
    const req = tx.objectStore('customFonts').getAll();
    req.onsuccess = () => resolve((req.result as CustomFontRecord[]) || []);
    req.onerror = () => reject(req.error);
  });
}

export async function saveCustomFont(font: CustomFontRecord): Promise<void> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('customFonts', 'readwrite');
    tx.objectStore('customFonts').put(font);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function deleteCustomFont(id: string): Promise<void> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('customFonts', 'readwrite');
    tx.objectStore('customFonts').delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getHighlightsByNovel(novelId: string): Promise<ReaderHighlight[]> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('highlights', 'readonly');
    const idx = tx.objectStore('highlights').index('novelId');
    const req = idx.getAll(novelId);
    req.onsuccess = () => {
      const list = (req.result as ReaderHighlight[]) || [];
      list.sort((a, b) => b.createdAt - a.createdAt);
      resolve(list);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function saveHighlight(highlight: ReaderHighlight): Promise<void> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('highlights', 'readwrite');
    tx.objectStore('highlights').put(highlight);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function saveHighlightsBulk(highlights: ReaderHighlight[]): Promise<void> {
  if (highlights.length === 0) return;
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('highlights', 'readwrite');
    const store = tx.objectStore('highlights');
    for (const h of highlights) {
      store.put(h);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function deleteHighlight(id: string): Promise<void> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('highlights', 'readwrite');
    tx.objectStore('highlights').delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

const READER_SETTINGS_KEY = 'mhc_reader_settings_v1';
const MODEL_CONFIG_KEY = 'mhc_model_config_v1';
const READING_BOOKMARK_PREFIX = 'mhc_reading_bookmark_';
const ACTIVE_NOVEL_ID_KEY = 'mhc_active_novel_id_v1';
const INITIAL_SEED_COMPLETED_KEY = 'mhc_initial_seed_completed_v1';

export function loadActiveNovelId(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return localStorage.getItem(ACTIVE_NOVEL_ID_KEY);
  } catch {
    return null;
  }
}

export function saveActiveNovelId(novelId: string): void {
  if (typeof window === 'undefined') return;
  try {
    if (!novelId) {
      localStorage.removeItem(ACTIVE_NOVEL_ID_KEY);
    } else {
      localStorage.setItem(ACTIVE_NOVEL_ID_KEY, novelId);
    }
  } catch {
    // Ignore storage quota errors
  }
}

export function loadReadingBookmark(novelId: string): ReadingBookmark | null {
  if (typeof window === 'undefined' || !novelId) return null;
  try {
    const raw = localStorage.getItem(`${READING_BOOKMARK_PREFIX}${novelId}`);
    if (!raw) return null;
    return JSON.parse(raw) as ReadingBookmark;
  } catch {
    return null;
  }
}

export function saveReadingBookmark(bookmark: ReadingBookmark): void {
  if (typeof window === 'undefined' || !bookmark.novelId) return;
  localStorage.setItem(
    `${READING_BOOKMARK_PREFIX}${bookmark.novelId}`,
    JSON.stringify(bookmark)
  );
}

export function normalizeVietnameseText(input: string): string {
  if (!input) return '';
  return input
    .replace(/([aăâeêioôơuưyAĂÂEÊIOÔƠUƯY])[\u00B4\u02CA]/g, '$1\u0301')
    .replace(/([aăâeêioôơuưyAĂÂEÊIOÔƠUƯY])\u0060/g, '$1\u0300')
    .normalize('NFC');
}

export function loadReaderSettings(): ReaderSettings {
  if (typeof window === 'undefined') return DEFAULT_READER_SETTINGS;
  try {
    const raw = localStorage.getItem(READER_SETTINGS_KEY);
    if (!raw) return DEFAULT_READER_SETTINGS;
    const parsed = JSON.parse(raw);
    const cleanedFontFamily =
      typeof parsed.fontFamily === 'string'
        ? parsed.fontFamily.replace(/,\s*Georgia/gi, ', var(--font-noto-serif)')
        : DEFAULT_READER_SETTINGS.fontFamily;
    return {
      ...DEFAULT_READER_SETTINGS,
      ...parsed,
      fontFamily: cleanedFontFamily,
      alwaysJustify: true,
    };
  } catch {
    return DEFAULT_READER_SETTINGS;
  }
}

export function saveReaderSettings(settings: ReaderSettings): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(
    READER_SETTINGS_KEY,
    JSON.stringify({ ...settings, alwaysJustify: true })
  );
}

export function loadModelConfig(): ModelConfigState {
  const fallback: ModelConfigState = {
    selectedModel: 'gemini-flash-latest',
    thinkingLevel: 'high',
    concurrency: 5,
    autoFallbackEnabled: true,
    fallbackModel: 'gemini-3.1-flash-lite',
    customBannedWords: [],
    qaRules: DEFAULT_QA_VALIDATION_RULES,
  };
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = localStorage.getItem(MODEL_CONFIG_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    const validThinkingLevels = ['minimal', 'low', 'medium', 'high'] as const;
    const rawLevel =
      typeof parsed.thinkingLevel === 'string'
        ? parsed.thinkingLevel.trim().toLowerCase()
        : '';
    const resolvedThinkingLevel = (
      validThinkingLevels as readonly string[]
    ).includes(rawLevel)
      ? (rawLevel as ModelConfigState['thinkingLevel'])
      : 'high';
    return {
      selectedModel: parsed.selectedModel || 'gemini-flash-latest',
      thinkingLevel: resolvedThinkingLevel,
      concurrency: Math.min(10, Math.max(1, Number(parsed.concurrency) || 5)),
      autoFallbackEnabled:
        typeof parsed.autoFallbackEnabled === 'boolean'
          ? parsed.autoFallbackEnabled
          : true,
      fallbackModel:
        typeof parsed.fallbackModel === 'string' && parsed.fallbackModel.trim()
          ? parsed.fallbackModel.trim()
          : 'gemini-3.1-flash-lite',
      customBannedWords: Array.isArray(parsed.customBannedWords)
        ? parsed.customBannedWords
        : [],
      qaRules: {
        ...DEFAULT_QA_VALIDATION_RULES,
        ...(parsed.qaRules || {}),
      },
    };
  } catch {
    return fallback;
  }
}

export function saveModelConfig(config: ModelConfigState): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(
    MODEL_CONFIG_KEY,
    JSON.stringify({
      ...config,
      thinkingLevel: config.thinkingLevel || 'high',
    })
  );
}

const PROJECT_API_KEYS_STORAGE_KEY = 'mhc_project_api_keys_v1';

export function loadProjectKeysLocal(): string {
  if (typeof window === 'undefined') return '';
  try {
    return localStorage.getItem(PROJECT_API_KEYS_STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

export function saveProjectKeysLocal(rawKeys: string): void {
  if (typeof window === 'undefined') return;
  try {
    const cleaned = (rawKeys || '').trim();
    if (!cleaned) {
      localStorage.removeItem(PROJECT_API_KEYS_STORAGE_KEY);
    } else {
      localStorage.setItem(PROJECT_API_KEYS_STORAGE_KEY, cleaned);
    }
  } catch {
    // Ignore storage quota errors
  }
}

/**
 * Two-way sync between Server (/data/project-key-pool.json) and Browser (localStorage)
 * so the user never has to re-paste their API key list across reloads or sessions.
 */
export async function syncProjectKeysWithServer(model?: string): Promise<string> {
  if (typeof window === 'undefined') return '';
  const localRaw = loadProjectKeysLocal().trim();
  try {
    const res = await safeFetchJson<{ savedRawKeys?: string }>(
      `/api/models?model=${encodeURIComponent(model || 'gemini-flash-latest')}`,
      { method: 'GET' },
      {
        scope: 'KEY_POOL',
        label: 'Sync Key Pool (GET /api/models)',
        silentSuccessLog: true,
      }
    );
    const serverRaw =
      typeof res.data?.savedRawKeys === 'string' ? res.data.savedRawKeys.trim() : '';

    if (serverRaw && !localRaw) {
      saveProjectKeysLocal(serverRaw);
      logger.info(
        'KEY_POOL',
        'Đã đồng bộ Key từ Server về localStorage trình duyệt'
      );
      return serverRaw;
    }
    if (localRaw && !serverRaw) {
      await safeFetchJson(
        '/api/models',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'save_keys',
            rawKeys: localRaw,
            model: model || 'gemini-flash-latest',
          }),
        },
        {
          scope: 'KEY_POOL',
          label: 'Sync Key Pool (POST save_keys)',
        }
      );
      return localRaw;
    }
    if (serverRaw) {
      saveProjectKeysLocal(serverRaw);
      return serverRaw;
    }
  } catch (err) {
    logger.warn('KEY_POOL', 'Không thể đồng bộ Key với Server (dùng bản local)', {
      error: (err as Error)?.message,
    });
  }
  return localRaw;
}


export async function ensureSeedDataInitialized(): Promise<{
  novels: NovelProject[];
  instructions: InstructionProfile[];
}> {
  let instructions = await getAllInstructions();
  if (instructions.length === 0) {
    for (const inst of DEFAULT_INSTRUCTION_PROFILES) {
      await saveInstructionProfile(inst);
    }
    instructions = DEFAULT_INSTRUCTION_PROFILES;
  } else {
    // Ensure new default 1.14.1 & 1.14.0 translation & editorial presets exist and auto-refresh presets with autoUpdate !== false
    const existingById = new Map(instructions.map((i) => [i.id, i]));
    let changedAny = false;
    for (const def of DEFAULT_INSTRUCTION_PROFILES) {
      const existing = existingById.get(def.id);
      if (!existing) {
        await saveInstructionProfile(def);
        changedAny = true;
      } else if (
        existing.autoUpdate !== false &&
        (existing.updatedAt < def.updatedAt ||
          existing.systemInstruction !== def.systemInstruction)
      ) {
        await saveInstructionProfile({
          ...def,
          includeGlossary: existing.includeGlossary ?? false,
        });
        changedAny = true;
      }
    }
    if (changedAny) {
      instructions = await getAllInstructions();
    }
  }

  let novels = await getAllNovels();
  const hasSeededBefore =
    typeof window !== 'undefined' &&
    localStorage.getItem(INITIAL_SEED_COMPLETED_KEY) === 'true';

  if (novels.length === 0 && !hasSeededBefore) {
    await saveNovel(DEFAULT_NOVEL_PROJECT);
    await saveGlossaryEntriesBulk(DEFAULT_GLOSSARY_ENTRIES);

    const seededChapters: Chapter[] = [];
    for (const item of SEED_CHAPTER_FILES) {
      let rawText = '';
      try {
        const res = await fetch(item.assetUrl);
        if (res.ok) {
          rawText = await res.text();
        }
      } catch {
        // Fallback if fetch fails
      }
      const cleanedBody = cleanRawChapterBody(rawText || item.titleRaw, item.titleRaw);
      seededChapters.push({
        id: `ch-${DEFAULT_NOVEL_ID}-${item.orderPrefix}`,
        novelId: DEFAULT_NOVEL_ID,
        orderPrefix: item.orderPrefix,
        chapterNumber: item.chapterNumber,
        fileNameOriginal: item.fileNameOriginal,
        titleRaw: item.titleRaw,
        titleTranslated: '',
        rawContent: cleanedBody,
        translatedContent: '',
        charCount: cleanedBody.replace(/\s+/g, '').length,
        status: 'raw',
        updatedAt: Date.now(),
      });
    }
    await saveChaptersBulk(seededChapters);
    novels = [DEFAULT_NOVEL_PROJECT];
    if (typeof window !== 'undefined') {
      localStorage.setItem(INITIAL_SEED_COMPLETED_KEY, 'true');
    }
  } else {
    if (typeof window !== 'undefined' && !hasSeededBefore) {
      localStorage.setItem(INITIAL_SEED_COMPLETED_KEY, 'true');
    }
    // Ensure existing novels have editorialProfileId and default includeGlossary = false if undefined
    for (const n of novels) {
      let changed = false;
      if (!n.editorialProfileId) {
        n.editorialProfileId = DEFAULT_EDITORIAL_INSTRUCTION_ID;
        changed = true;
      }
      if (!n.instructionProfileId) {
        n.instructionProfileId = DEFAULT_INSTRUCTION_ID;
        changed = true;
      }
      if (n.includeGlossary === undefined) {
        n.includeGlossary = false;
        changed = true;
      }
      if (changed) {
        await saveNovel(n);
      }
    }
  }

  return { novels, instructions };
}

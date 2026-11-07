import fs from 'fs';
import path from 'path';
import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import { createRequestId, KeyAttemptTrace, logger } from './logger';
import {
  DEFAULT_THINKING_LEVEL,
  THINKING_LEVEL_OPTIONS,
  ThinkingLevelMeta,
  ThinkingLevelOption,
} from './types';

export interface KeyPoolSlot {
  index: number;
  sourceEnv: string;
  apiKey: string;
  maskedKey: string;
  cooldownUntil: number;
  modelCooldowns: Record<string, number>;
  invalidKey: boolean;
  activeRequests: number; // Number of concurrent chapters/requests actively using this key right now
  totalRequests: number;
  rateLimitHits: number;
  lastUsedAt: number;
  lastLatencyMs?: number;
  lastCheckedAt?: number;
  lastError?: string;
}

export interface KeySlotSummary {
  index: number;
  sourceEnv: string;
  maskedKey: string;
  status: 'ready' | 'in_use' | 'cooldown' | 'invalid';
  activeRequests: number;
  cooldownRemainingSec: number;
  totalRequests: number;
  rateLimitHits: number;
  lastLatencyMs?: number;
  lastCheckedAt?: number;
  lastError?: string;
}

export interface ApiEndpointCheckResult {
  endpoint: string;
  method: 'GET' | 'POST';
  name: string;
  description: string;
  status: 'ok' | 'warning' | 'error';
  latencyMs: number;
  detail: string;
}

export interface KeyHealthCheckResult {
  index: number;
  sourceEnv: string;
  maskedKey: string;
  status: 'ready' | 'cooldown' | 'invalid';
  latencyMs: number;
  modelTested: string;
  flashLiteReady?: boolean;
  message: string;
}

const MAX_KEYS = 50;
const DEFAULT_COOLDOWN_MS = 60_000;
const PROJECT_KEY_STORE_DIR = path.join(process.cwd(), 'data');
const PROJECT_KEY_STORE_FILE = path.join(
  PROJECT_KEY_STORE_DIR,
  'project-key-pool.json'
);

function maskApiKey(key: string): string {
  const clean = key.trim();
  if (clean.length <= 10) return '********';
  return `${clean.slice(0, 6)}...${clean.slice(-4)}`;
}

function parseRetryAfterMs(errorMessage: string): number {
  // Parse patterns like "retry in 4h3m49s", "retry in 45s", "retry in 12m30s"
  const hmsMatch = errorMessage.match(
    /retry in\s*(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:(\d+(?:\.\d+)?)s)?/i
  );
  if (hmsMatch && (hmsMatch[1] || hmsMatch[2] || hmsMatch[3])) {
    const hours = parseInt(hmsMatch[1] || '0', 10);
    const mins = parseInt(hmsMatch[2] || '0', 10);
    const secs = parseFloat(hmsMatch[3] || '0');
    const totalMs = (hours * 3600 + mins * 60 + secs) * 1000;
    if (totalMs > 0) {
      // Cap automatic lock at 30 minutes so user can still retry if quota resets
      return Math.min(totalMs, 30 * 60_000);
    }
  }
  return DEFAULT_COOLDOWN_MS;
}

function normalizeModelBucket(model?: string): string {
  const m = (model || 'gemini-flash-latest').trim().toLowerCase();
  if (m === 'gemini-flash-latest' || m === 'gemini-3.8-flash') {
    return 'gemini-3.8-flash';
  }
  return m;
}

class ServerGeminiKeyPool {
  private slots: KeyPoolSlot[] = [];
  private roundRobinCursor = 0;
  private initialized = false;
  private savedProjectRawKeys = '';

  private loadProjectSavedKeysFromDisk(): string {
    try {
      if (fs.existsSync(PROJECT_KEY_STORE_FILE)) {
        const rawJson = fs.readFileSync(PROJECT_KEY_STORE_FILE, 'utf-8');
        const parsed = JSON.parse(rawJson) as { rawKeys?: string; keys?: string[] };
        if (typeof parsed.rawKeys === 'string') {
          return parsed.rawKeys.trim();
        }
        if (Array.isArray(parsed.keys)) {
          return parsed.keys.join('\n').trim();
        }
      }
    } catch {
      // Ignore disk read error and fall back to in-memory
    }
    return this.savedProjectRawKeys;
  }

  public getSavedProjectKeysRaw(): string {
    if (!this.initialized) {
      this.refreshFromEnv();
    }
    return this.savedProjectRawKeys;
  }

  public saveProjectKeysToDisk(rawKeysText: string): {
    savedCount: number;
    totalPoolKeys: number;
  } {
    const cleanedLines = (rawKeysText || '')
      .split(/[\r\n,;]+/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('#'));

    const normalizedRaw = cleanedLines.join('\n');
    this.savedProjectRawKeys = normalizedRaw;

    try {
      if (!normalizedRaw) {
        if (fs.existsSync(PROJECT_KEY_STORE_FILE)) {
          fs.unlinkSync(PROJECT_KEY_STORE_FILE);
        }
      } else {
        if (!fs.existsSync(PROJECT_KEY_STORE_DIR)) {
          fs.mkdirSync(PROJECT_KEY_STORE_DIR, { recursive: true });
        }
        fs.writeFileSync(
          PROJECT_KEY_STORE_FILE,
          JSON.stringify(
            {
              version: 1,
              updatedAt: Date.now(),
              rawKeys: normalizedRaw,
            },
            null,
            2
          ),
          'utf-8'
        );
      }
    } catch {
      // Keep in memory if filesystem is read-only
    }

    this.refreshFromEnv();
    return {
      savedCount: cleanedLines.length,
      totalPoolKeys: this.slots.length,
    };
  }

  /**
   * Parse multi-line or comma-separated lists of keys or KEY=VALUE lines.
   * Allows pasting up to 50 lines (1 variable or 1 key per line).
   */
  private extractKeysFromRawString(
    raw: string,
    labelPrefix: string,
    seen: Set<string>,
    out: KeyPoolSlot[]
  ) {
    if (!raw || !raw.trim()) return;
    const lines = raw
      .split(/[\r\n,;]+/)
      .map((l) => l.trim())
      .filter(Boolean);

    let localCounter = 0;
    for (const line of lines) {
      if (out.length >= MAX_KEYS) break;
      if (line.startsWith('#')) continue;

      let candidate = line;
      const eqIdx = line.indexOf('=');
      if (eqIdx !== -1) {
        candidate = line.slice(eqIdx + 1).trim();
      }
      candidate = candidate.replace(/^["']|["']$/g, '').trim();

      if (
        candidate &&
        candidate.length >= 16 &&
        candidate !== 'MY_GEMINI_API_KEY' &&
        !seen.has(candidate)
      ) {
        seen.add(candidate);
        localCounter += 1;
        out.push({
          index: out.length + 1,
          sourceEnv: `${labelPrefix}#${localCounter}`,
          apiKey: candidate,
          maskedKey: maskApiKey(candidate),
          cooldownUntil: 0,
          modelCooldowns: {},
          invalidKey: false,
          activeRequests: 0,
          totalRequests: 0,
          rateLimitHits: 0,
          lastUsedAt: 0,
        });
      }
    }
  }

  public refreshFromEnv(): void {
    const seen = new Set<string>();
    const nextSlots: KeyPoolSlot[] = [];

    // CHỈ nạp các API Key do chính người dùng tự thêm và lưu trên giao diện ứng dụng (/data/project-key-pool.json).
    // TUYỆT ĐỐI KHÔNG tự động nạp bất kỳ Key nào từ process.env (GEMINI_API_KEY, GEMINI_API_KEYS, GEMINI_API_KEY_1..50, GOOGLE_API_KEY)
    // để đảm bảo dự án không bao giờ chứa sẵn Key mặc định — ai muốn dùng phải tự thêm Key của mình.
    const diskKeys = this.loadProjectSavedKeysFromDisk();
    this.savedProjectRawKeys = diskKeys;
    if (diskKeys) {
      this.extractKeysFromRawString(diskKeys, 'USER_KEY', seen, nextSlots);
    }

    // Preserve in-flight activeRequests, stats, and cooldowns for keys that already existed
    const prevMap = new Map(this.slots.map((s) => [s.apiKey, s]));
    this.slots = nextSlots.slice(0, MAX_KEYS).map((slot, idx) => {
      const prev = prevMap.get(slot.apiKey);
      if (prev) {
        return {
          ...prev,
          index: idx + 1,
          sourceEnv: slot.sourceEnv,
          maskedKey: slot.maskedKey,
        };
      }
      return { ...slot, index: idx + 1 };
    });

    this.initialized = true;
  }

  public resetAllCooldowns(): void {
    if (!this.initialized) this.refreshFromEnv();
    for (const slot of this.slots) {
      slot.cooldownUntil = 0;
      slot.modelCooldowns = {};
      slot.invalidKey = false;
      slot.lastError = undefined;
    }
  }

  private getSlotCooldownUntil(slot: KeyPoolSlot, model?: string): number {
    if (!model) return slot.cooldownUntil;
    const bucket = normalizeModelBucket(model);
    return slot.modelCooldowns[bucket] || 0;
  }

  private setSlotCooldown(
    slot: KeyPoolSlot,
    durationMs: number,
    model?: string,
    errorMsg?: string
  ): void {
    const until = Date.now() + durationMs;
    slot.cooldownUntil = Math.max(slot.cooldownUntil, until);
    if (model) {
      const bucket = normalizeModelBucket(model);
      slot.modelCooldowns[bucket] = until;
    }
    if (errorMsg) {
      slot.lastError = errorMsg;
    }
  }

  public getPoolStatus(activeModel?: string) {
    if (!this.initialized) this.refreshFromEnv();
    const now = Date.now();
    const total = this.slots.length;

    const slotsSummary: KeySlotSummary[] = this.slots.map((s) => {
      const cdUntil = activeModel
        ? this.getSlotCooldownUntil(s, activeModel)
        : s.cooldownUntil;
      const isCooling = cdUntil > now;
      const status: KeySlotSummary['status'] = s.invalidKey
        ? 'invalid'
        : isCooling
          ? 'cooldown'
          : s.activeRequests > 0
            ? 'in_use'
            : 'ready';
      return {
        index: s.index,
        sourceEnv: s.sourceEnv,
        maskedKey: s.maskedKey,
        status,
        activeRequests: s.activeRequests,
        cooldownRemainingSec: isCooling ? Math.ceil((cdUntil - now) / 1000) : 0,
        totalRequests: s.totalRequests,
        rateLimitHits: s.rateLimitHits,
        lastLatencyMs: s.lastLatencyMs,
        lastCheckedAt: s.lastCheckedAt,
        lastError: s.lastError,
      };
    });

    const invalidCount = slotsSummary.filter((s) => s.status === 'invalid').length;
    const coolingDown = slotsSummary.filter((s) => s.status === 'cooldown').length;
    const inUse = slotsSummary.filter((s) => s.status === 'in_use').length;
    const idleReady = slotsSummary.filter((s) => s.status === 'ready').length;
    const ready = idleReady + inUse;

    return {
      maxSupportedKeys: MAX_KEYS,
      maxConcurrency: 10,
      totalConfiguredKeys: total,
      readyKeys: ready,
      idleReadyKeys: idleReady,
      inUseKeys: inUse,
      coolingDownKeys: coolingDown,
      invalidKeys: invalidCount,
      hasProjectSavedKeys: Boolean(this.savedProjectRawKeys.trim()),
      projectSavedKeyCount: this.savedProjectRawKeys
        ? this.savedProjectRawKeys.split(/\r?\n/).filter(Boolean).length
        : 0,
      slotsSummary,
    };
  }

  /**
   * Acquires and locks a key slot for a single chapter/request attempt:
   * - Priority 1 (Dedicated 1-key-per-thread + Idle Rotation):
   *   Finds the next key in round-robin order that is IDLE (`activeRequests === 0`),
   *   VALID (`!invalidKey`), NOT cooling down for `model`, and NOT yet tried by this request.
   * - Priority 2 (Idle & Ready even if previously tried in this call)
   * - Priority 3 (When total configured keys < active threads):
   *   Picks a non-cooldown key with the lowest `activeRequests` count (preferring untried).
   * - Priority 4 (When all keys are in 429 cooldown):
   *   Prefers an IDLE (`activeRequests === 0`) slot whose cooldown for `model` expires soonest.
   */
  private acquireSlot(triedIndices: Set<number>, model?: string): KeyPoolSlot {
    if (!this.initialized || this.slots.length === 0) {
      this.refreshFromEnv();
    }
    if (this.slots.length === 0) {
      throw new Error(
        'Chưa có API Key nào trong Bể Key! Vui lòng mở mục [Preset & Model → Bể 50 Key & Kiểm Tra API] để dán danh sách Gemini API Key của bạn vào rồi bấm Lưu trước khi dịch.'
      );
    }

    const now = Date.now();
    const count = this.slots.length;

    const isSlotReadyForModel = (slot: KeyPoolSlot) =>
      !slot.invalidKey && this.getSlotCooldownUntil(slot, model) <= now;

    // Pass 1: Strictly IDLE (activeRequests === 0), READY (not in cooldown), and UNTRIED in this request
    for (let offset = 0; offset < count; offset++) {
      const idx = (this.roundRobinCursor + offset) % count;
      const slot = this.slots[idx];
      if (
        slot.activeRequests === 0 &&
        isSlotReadyForModel(slot) &&
        !triedIndices.has(slot.index)
      ) {
        this.roundRobinCursor = (idx + 1) % count;
        slot.activeRequests += 1;
        slot.totalRequests += 1;
        slot.lastUsedAt = now;
        return slot;
      }
    }

    // Pass 2: Strictly IDLE (activeRequests === 0) and READY (not in cooldown), even if tried earlier
    for (let offset = 0; offset < count; offset++) {
      const idx = (this.roundRobinCursor + offset) % count;
      const slot = this.slots[idx];
      if (slot.activeRequests === 0 && isSlotReadyForModel(slot)) {
        this.roundRobinCursor = (idx + 1) % count;
        slot.activeRequests += 1;
        slot.totalRequests += 1;
        slot.lastUsedAt = now;
        return slot;
      }
    }

    // Pass 3: Fallback only if user configured fewer keys than concurrent threads.
    // Pick a READY (not in cooldown) slot with the lowest activeRequests, preferring untried slots.
    let bestReadySlot: KeyPoolSlot | null = null;
    for (let offset = 0; offset < count; offset++) {
      const idx = (this.roundRobinCursor + offset) % count;
      const slot = this.slots[idx];
      if (isSlotReadyForModel(slot)) {
        if (!bestReadySlot) {
          bestReadySlot = slot;
        } else {
          const slotUntried = !triedIndices.has(slot.index);
          const bestUntried = !triedIndices.has(bestReadySlot.index);
          if (slotUntried && !bestUntried) {
            bestReadySlot = slot;
          } else if (
            slotUntried === bestUntried &&
            slot.activeRequests < bestReadySlot.activeRequests
          ) {
            bestReadySlot = slot;
          }
        }
      }
    }

    if (bestReadySlot) {
      this.roundRobinCursor = bestReadySlot.index % count;
      bestReadySlot.activeRequests += 1;
      bestReadySlot.totalRequests += 1;
      bestReadySlot.lastUsedAt = now;
      return bestReadySlot;
    }

    // Pass 4: All keys are in cooldown — pick the non-invalid IDLE key whose cooldown for `model` expires soonest
    const candidates = this.slots.filter((s) => !s.invalidKey);
    const poolToSearch = candidates.length > 0 ? candidates : this.slots;
    let earliestSlot = poolToSearch[0];
    for (const s of poolToSearch) {
      const sIdle = s.activeRequests === 0;
      const earliestIdle = earliestSlot.activeRequests === 0;
      const sCd = this.getSlotCooldownUntil(s, model);
      const earliestCd = this.getSlotCooldownUntil(earliestSlot, model);
      if (sIdle && !earliestIdle) {
        earliestSlot = s;
      } else if (sIdle === earliestIdle && sCd < earliestCd) {
        earliestSlot = s;
      }
    }
    this.roundRobinCursor = earliestSlot.index % count;
    earliestSlot.activeRequests += 1;
    earliestSlot.totalRequests += 1;
    earliestSlot.lastUsedAt = now;
    return earliestSlot;
  }

  private releaseSlot(slot: KeyPoolSlot): void {
    slot.activeRequests = Math.max(0, slot.activeRequests - 1);
  }

  private hasAnyReadySlotForModel(
    model?: string,
    excludeIndices?: Set<number>
  ): boolean {
    const now = Date.now();
    return this.slots.some(
      (s) =>
        !s.invalidKey &&
        this.getSlotCooldownUntil(s, model) <= now &&
        (!excludeIndices || !excludeIndices.has(s.index))
    );
  }

  /**
   * Execute a Gemini operation with:
   * 1. Dedicated 1-key-per-concurrent-thread locking (`activeRequests` tracking so 10 threads use 10 distinct keys).
   * 2. Failover rotation across ALL idle (non-in-flight, non-cooldown) keys in the 50-key pool.
   * 3. Per-model cooldown isolation & automatic skipping of invalid keys.
   * 4. Optional `fallbackModel`: ONLY when all keys in the pool hit 429 on `model` AND the user enabled `fallbackModel`, automatically retries rotation on `fallbackModel`.
   * 5. Wire-1 (Sợi dây 1) Renewal & Per-Attempt Timeout: If an attempt fails after Sợi dây 1 has already been open >= 20s, signals the client to open a brand-new HTTP request (resetting the 300s gateway clock to 0s) for the next key.
   */
  public async executeWithKeyRotation<T>(
    operation: (
      ai: GoogleGenAI,
      slotInfo: { keyIndex: number; totalKeys: number; activeModel: string }
    ) => Promise<T>,
    model?: string,
    fallbackModel?: string,
    traceContext?: {
      reqId?: string;
      endpoint?: string;
      label?: string;
      signal?: AbortSignal;
      initialTriedKeys?: number[];
    }
  ): Promise<{
    result: T;
    keyIndexUsed: number;
    totalKeys: number;
    modelUsed: string;
    didFallback: boolean;
    attempts: KeyAttemptTrace[];
    totalDurationMs: number;
  }> {
    if (!this.initialized) this.refreshFromEnv();
    const reqId = traceContext?.reqId || createRequestId('keypool');
    const opStartMs = Date.now();
    const attempts: KeyAttemptTrace[] = [];

    if (this.slots.length === 0) {
      logger.error(
        'KEY_POOL',
        `✖ Từ chối thực thi (${traceContext?.endpoint || 'API'}) vì Bể Key đang trống (0 Key).`,
        { reqId, endpoint: traceContext?.endpoint },
        reqId
      );
      throw new Error(
        'Chưa có API Key nào trong Bể Key! Vui lòng mở mục [Preset & Model → Bể 50 Key & Kiểm Tra API] để dán danh sách Gemini API Key của bạn vào rồi bấm Lưu trước khi dịch.'
      );
    }

    const primaryModel = (model || 'gemini-flash-latest').trim();
    const cleanFallback = (fallbackModel || '').trim();
    const modelsToTry =
      cleanFallback &&
      normalizeModelBucket(cleanFallback) !== normalizeModelBucket(primaryModel)
        ? [primaryModel, cleanFallback]
        : [primaryModel];

    const totalKeys = Math.max(1, this.slots.length);
    let lastError: unknown = null;
    let sawRateLimitOnAllAttempts = false;

    const PER_KEY_ATTEMPT_TIMEOUT_MS = 180_000; // 180s max per key so a hung socket never hits 300s
    const MAX_WIRE1_ELAPSED_BEFORE_RENEW_MS = 20_000; // Renew Sợi dây 1 if >= 20s already spent on this HTTP connection

    for (let mIdx = 0; mIdx < modelsToTry.length; mIdx++) {
      const targetModel = modelsToTry[mIdx];
      const isFallbackPass = mIdx > 0;
      const maxAttempts = Math.max(totalKeys, 2);
      const triedIndices = new Set<number>(
        !isFallbackPass && Array.isArray(traceContext?.initialTriedKeys)
          ? traceContext.initialTriedKeys.filter(
              (k) => Number.isInteger(k) && k >= 1 && k <= totalKeys
            )
          : []
      );
      let rateLimitHitsInPass = 0;

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        if (traceContext?.signal?.aborted) {
          const abortErr = new Error('[CLIENT_ABORTED] Đã hủy yêu cầu từ trình duyệt.');
          abortErr.name = 'AbortError';
          throw abortErr;
        }

        // If we already tried at least 1 key in this pass and there are NO ready (non-cooldown) keys left for targetModel,
        // stop hammering cooldown keys and move immediately to fallbackModel or throw POOL_EXHAUSTED_429.
        if (
          attempt > 0 &&
          !this.hasAnyReadySlotForModel(targetModel, triedIndices) &&
          !this.hasAnyReadySlotForModel(targetModel)
        ) {
          sawRateLimitOnAllAttempts = true;
          break;
        }

        // Cách 1: If this HTTP connection (Sợi dây 1) has already been open >= 20s and we need to switch to a new key,
        // close Sợi dây 1 and tell the browser to immediately open a brand-new Sợi dây 1 (resetting the 300s clock to 0s)!
        const elapsedOnWireMs = Date.now() - opStartMs;
        if (
          attempts.length > 0 &&
          elapsedOnWireMs >= MAX_WIRE1_ELAPSED_BEFORE_RENEW_MS &&
          (this.hasAnyReadySlotForModel(targetModel, triedIndices) ||
            this.hasAnyReadySlotForModel(targetModel) ||
            mIdx + 1 < modelsToTry.length)
        ) {
          logger.info(
            'KEY_POOL',
            `🔄 [Làm mới Sợi dây 1] Đã qua ${(elapsedOnWireMs / 1000).toFixed(1)}s trên kết nối hiện tại — Đóng Sợi dây 1 cũ để trình duyệt mở Sợi dây 1 MỚI (reset đồng hồ 300s) cho Key tiếp theo`,
            {
              reqId,
              elapsedOnWireMs,
              triedKeys: Array.from(triedIndices),
              attemptsCount: attempts.length,
            },
            reqId,
            elapsedOnWireMs
          );
          const renewErr = new Error(
            '[RENEW_WIRE_1] Làm mới kết nối Sợi dây 1 để reset bộ đếm 300 giây khi chuyển sang Key mới.'
          ) as Error & {
            renewWire1?: boolean;
            triedKeyIndices?: number[];
            attempts?: KeyAttemptTrace[];
            totalDurationMs?: number;
          };
          renewErr.renewWire1 = true;
          renewErr.triedKeyIndices = Array.from(triedIndices);
          renewErr.attempts = attempts;
          renewErr.totalDurationMs = elapsedOnWireMs;
          throw renewErr;
        }

        const slot = this.acquireSlot(triedIndices, targetModel);
        triedIndices.add(slot.index);

        const startMs = Date.now();
        logger.info(
          'KEY_POOL',
          `🔑 [Attempt #${attempts.length + 1}] Khóa Key #${slot.index}/${totalKeys} (${slot.sourceEnv} • ${slot.maskedKey}) cho model=${targetModel}${isFallbackPass ? ' [FALLBACK]' : ''}`,
          {
            reqId,
            endpoint: traceContext?.endpoint,
            label: traceContext?.label,
            keyIndex: slot.index,
            sourceEnv: slot.sourceEnv,
            maskedKey: slot.maskedKey,
            targetModel,
            activeRequestsOnSlot: slot.activeRequests,
          },
          reqId
        );

        const ai = new GoogleGenAI({
          apiKey: slot.apiKey,
          httpOptions: {
            headers: {
              'User-Agent': 'aistudio-build',
            },
          },
        });

        let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
        let onClientAbort: (() => void) | null = null;

        try {
          const result = await new Promise<T>((resolve, reject) => {
            timeoutHandle = setTimeout(() => {
              reject(
                new Error(
                  `[KEY_ATTEMPT_TIMEOUT] Key #${slot.index} phản hồi quá ${Math.round(
                    PER_KEY_ATTEMPT_TIMEOUT_MS / 1000
                  )}s — tự động ngắt sớm để chuyển sang Key khác trên kết nối mới.`
                )
              );
            }, PER_KEY_ATTEMPT_TIMEOUT_MS);

            if (traceContext?.signal) {
              if (traceContext.signal.aborted) {
                const abortErr = new Error('[CLIENT_ABORTED] Đã hủy yêu cầu từ trình duyệt.');
                abortErr.name = 'AbortError';
                reject(abortErr);
                return;
              }
              onClientAbort = () => {
                const abortErr = new Error('[CLIENT_ABORTED] Đã hủy yêu cầu từ trình duyệt.');
                abortErr.name = 'AbortError';
                reject(abortErr);
              };
              traceContext.signal.addEventListener('abort', onClientAbort, {
                once: true,
              });
            }

            operation(ai, {
              keyIndex: slot.index,
              totalKeys,
              activeModel: targetModel,
            }).then(resolve, reject);
          });
          const latencyMs = Date.now() - startMs;
          slot.lastLatencyMs = latencyMs;
          slot.lastCheckedAt = Date.now();
          slot.lastError = undefined;
          slot.invalidKey = false;
          if (targetModel) {
            delete slot.modelCooldowns[normalizeModelBucket(targetModel)];
          }

          attempts.push({
            attempt: attempts.length + 1,
            keyIndex: slot.index,
            sourceEnv: slot.sourceEnv,
            maskedKey: slot.maskedKey,
            targetModel,
            isFallbackModel: isFallbackPass,
            activeRequestsOnSlot: slot.activeRequests,
            latencyMs,
            outcome: 'success',
          });

          const totalDurationMs = Date.now() - opStartMs;
          logger.info(
            'KEY_POOL',
            `✔ Key #${slot.index} (${slot.maskedKey}) hoàn tất thành công trên ${targetModel} sau ${(latencyMs / 1000).toFixed(2)}s`,
            {
              reqId,
              endpoint: traceContext?.endpoint,
              keyIndexUsed: slot.index,
              modelUsed: targetModel,
              didFallback: isFallbackPass,
              latencyMs,
              totalDurationMs,
              totalAttempts: attempts.length,
            },
            reqId,
            latencyMs
          );

          return {
            result,
            keyIndexUsed: slot.index,
            totalKeys,
            modelUsed: targetModel,
            didFallback: isFallbackPass,
            attempts,
            totalDurationMs,
          };
        } catch (err: unknown) {
          lastError = err;
          const latencyMs = Date.now() - startMs;
          const msg = err instanceof Error ? err.message : String(err);
          const lower = msg.toLowerCase();

          if (
            traceContext?.signal?.aborted ||
            msg.includes('[CLIENT_ABORTED]') ||
            (err instanceof Error && err.name === 'AbortError')
          ) {
            throw err;
          }

          const isRateLimit =
            msg.includes('429') ||
            msg.includes('RESOURCE_EXHAUSTED') ||
            lower.includes('quota') ||
            lower.includes('rate limit');

          if (isRateLimit) {
            rateLimitHitsInPass += 1;
            slot.rateLimitHits += 1;
            const retryMs = parseRetryAfterMs(msg);
            this.setSlotCooldown(slot, retryMs, targetModel, msg.slice(0, 180));

            attempts.push({
              attempt: attempts.length + 1,
              keyIndex: slot.index,
              sourceEnv: slot.sourceEnv,
              maskedKey: slot.maskedKey,
              targetModel,
              isFallbackModel: isFallbackPass,
              activeRequestsOnSlot: slot.activeRequests,
              latencyMs,
              outcome: 'rate_limit_429',
              errorMessage: msg.slice(0, 300),
              cooldownAppliedMs: retryMs,
            });

            logger.warn(
              'KEY_POOL',
              `⚠️ Key #${slot.index} (${slot.maskedKey}) chạm 429 Rate Limit trên ${targetModel} sau ${latencyMs}ms → Cooldown ${Math.round(retryMs / 1000)}s, xoay sang Key tiếp theo...`,
              {
                reqId,
                keyIndex: slot.index,
                targetModel,
                cooldownSec: Math.round(retryMs / 1000),
                errorPreview: msg.slice(0, 250),
              },
              reqId,
              latencyMs
            );
            continue;
          }

          const isInvalidKey =
            msg.includes('API_KEY_INVALID') ||
            lower.includes('api key not valid') ||
            lower.includes('api key expired') ||
            msg.includes('PERMISSION_DENIED') ||
            msg.includes('401') ||
            msg.includes('403');

          if (isInvalidKey) {
            slot.invalidKey = true;
            slot.lastError = msg.slice(0, 180);

            attempts.push({
              attempt: attempts.length + 1,
              keyIndex: slot.index,
              sourceEnv: slot.sourceEnv,
              maskedKey: slot.maskedKey,
              targetModel,
              isFallbackModel: isFallbackPass,
              activeRequestsOnSlot: slot.activeRequests,
              latencyMs,
              outcome: 'invalid_key',
              errorMessage: msg.slice(0, 300),
            });

            logger.error(
              'KEY_POOL',
              `✖ Key #${slot.index} (${slot.maskedKey}) không hợp lệ / bị từ chối (401/403) → Đánh dấu Invalid & xoay Key khác`,
              {
                reqId,
                keyIndex: slot.index,
                errorPreview: msg.slice(0, 250),
              },
              reqId,
              latencyMs
            );
            continue;
          }

          // Transient server/network/timeout errors (500, 502, 503, 504, overloaded, fetch failed, socket hang, per-attempt timeout):
          // put key on short cooldown and rotate to another idle key (renewing Sợi dây 1 if >= 20s elapsed)
          const isTransientOrTimeout =
            msg.includes('[KEY_ATTEMPT_TIMEOUT]') ||
            msg.includes('503') ||
            msg.includes('502') ||
            msg.includes('504') ||
            msg.includes('UNAVAILABLE') ||
            msg.includes('DEADLINE_EXCEEDED') ||
            msg.includes('UND_ERR_') ||
            lower.includes('overloaded') ||
            lower.includes('internal error') ||
            lower.includes('fetch failed') ||
            lower.includes('network') ||
            lower.includes('timeout') ||
            lower.includes('socket hang up') ||
            lower.includes('econnreset');

          if (isTransientOrTimeout) {
            const transientCooldownMs = msg.includes('[KEY_ATTEMPT_TIMEOUT]')
              ? 15_000
              : 10_000;
            this.setSlotCooldown(
              slot,
              transientCooldownMs,
              targetModel,
              msg.slice(0, 180)
            );

            attempts.push({
              attempt: attempts.length + 1,
              keyIndex: slot.index,
              sourceEnv: slot.sourceEnv,
              maskedKey: slot.maskedKey,
              targetModel,
              isFallbackModel: isFallbackPass,
              activeRequestsOnSlot: slot.activeRequests,
              latencyMs,
              outcome: 'transient_5xx',
              errorMessage: msg.slice(0, 300),
              cooldownAppliedMs: transientCooldownMs,
            });

            logger.warn(
              'KEY_POOL',
              `⚠️ Key #${slot.index} gặp lỗi tạm thời/timeout trên ${targetModel} sau ${(latencyMs / 1000).toFixed(1)}s → Cooldown ${Math.round(transientCooldownMs / 1000)}s & chuyển sang Key tiếp theo`,
              {
                reqId,
                keyIndex: slot.index,
                targetModel,
                errorPreview: msg.slice(0, 250),
              },
              reqId,
              latencyMs
            );
            continue;
          }

          attempts.push({
            attempt: attempts.length + 1,
            keyIndex: slot.index,
            sourceEnv: slot.sourceEnv,
            maskedKey: slot.maskedKey,
            targetModel,
            isFallbackModel: isFallbackPass,
            activeRequestsOnSlot: slot.activeRequests,
            latencyMs,
            outcome: 'fatal_error',
            errorMessage: msg.slice(0, 400),
          });

          logger.error(
            'KEY_POOL',
            `✖ Lỗi nghiêm trọng (Fatal Error) tại Key #${slot.index} trên ${targetModel}: ${msg.slice(0, 200)}`,
            {
              reqId,
              keyIndex: slot.index,
              targetModel,
              errorMessage: msg,
              attempts,
            },
            reqId,
            latencyMs
          );

          const fatalErr = (
            err instanceof Error ? err : new Error(msg)
          ) as Error & {
            attempts?: KeyAttemptTrace[];
            totalDurationMs?: number;
          };
          fatalErr.attempts = attempts;
          fatalErr.totalDurationMs = Date.now() - opStartMs;
          throw fatalErr;
        } finally {
          if (timeoutHandle) clearTimeout(timeoutHandle);
          if (onClientAbort && traceContext?.signal) {
            traceContext.signal.removeEventListener('abort', onClientAbort);
          }
          this.releaseSlot(slot);
        }
      }

      if (rateLimitHitsInPass > 0) {
        sawRateLimitOnAllAttempts = true;
      }
    }

    const totalDurationMs = Date.now() - opStartMs;
    const rawErrMsg =
      lastError instanceof Error ? lastError.message : String(lastError || '');
    if (
      sawRateLimitOnAllAttempts ||
      rawErrMsg.includes('429') ||
      rawErrMsg.includes('RESOURCE_EXHAUSTED') ||
      rawErrMsg.includes('20 requests per day') ||
      rawErrMsg.includes('gemini-3.8-flash')
    ) {
      const triedModelsLabel = modelsToTry.join(' → ');
      const exhaustedErr = new Error(
        `[POOL_EXHAUSTED_429] Tất cả ${totalKeys} Key trong bể đều đã chạm giới hạn 429 trên model (${triedModelsLabel}). Hãy đổi sang model khác hoặc thêm Key mới rồi bấm Tiếp tục!`
      ) as Error & {
        attempts?: KeyAttemptTrace[];
        totalDurationMs?: number;
      };
      exhaustedErr.attempts = attempts;
      exhaustedErr.totalDurationMs = totalDurationMs;
      logger.error(
        'KEY_POOL',
        `🚨 [POOL_EXHAUSTED_429] Toàn bộ ${totalKeys} Key đã chạm giới hạn 429 trên (${triedModelsLabel}) sau ${attempts.length} lần thử (${(totalDurationMs / 1000).toFixed(2)}s)`,
        {
          reqId,
          triedModels: modelsToTry,
          totalKeys,
          totalDurationMs,
          attempts,
        },
        reqId,
        totalDurationMs
      );
      throw exhaustedErr;
    }

    const fallbackErr = (
      lastError instanceof Error
        ? lastError
        : new Error(
            '[POOL_EXHAUSTED_429] Tất cả khóa rảnh trong bể đều đang chạm giới hạn Rate Limit (429).'
          )
    ) as Error & {
      attempts?: KeyAttemptTrace[];
      totalDurationMs?: number;
    };
    fallbackErr.attempts = attempts;
    fallbackErr.totalDurationMs = totalDurationMs;
    throw fallbackErr;
  }

  public async executeWithFailover<T>(
    operation: (
      ai: GoogleGenAI,
      slotInfo: { keyIndex: number; totalKeys: number; activeModel: string }
    ) => Promise<T>,
    model?: string,
    fallbackModel?: string
  ): Promise<T> {
    const { result } = await this.executeWithKeyRotation(
      operation,
      model,
      fallbackModel
    );
    return result;
  }

  /**
   * Comprehensive Live Health Check for all configured keys in the pool + Studio API routes.
   */
  public async checkAllKeysAndApis(selectedModel = 'gemini-flash-latest'): Promise<{
    testedAt: number;
    modelTested: string;
    keyResults: KeyHealthCheckResult[];
    endpointResults: ApiEndpointCheckResult[];
    poolStatus: ReturnType<ServerGeminiKeyPool['getPoolStatus']>;
  }> {
    this.refreshFromEnv();
    const targetModel = selectedModel.trim() || 'gemini-flash-latest';

    // Test keys with concurrency 8 so checking even 50 keys finishes in ~2-3 seconds
    const keyResults: KeyHealthCheckResult[] = new Array(this.slots.length);
    let cursor = 0;

    const testSingleSlot = async (slot: KeyPoolSlot): Promise<KeyHealthCheckResult> => {
      const startMs = Date.now();
      const ai = new GoogleGenAI({
        apiKey: slot.apiKey,
        httpOptions: {
          headers: { 'User-Agent': 'aistudio-build' },
        },
      });

      try {
        await ai.interactions.create({
          model: targetModel,
          store: false,
          input: 'OK',
          generation_config: {
            max_output_tokens: 16,
          },
        });
        const latencyMs = Date.now() - startMs;
        slot.lastLatencyMs = latencyMs;
        slot.lastCheckedAt = Date.now();
        slot.invalidKey = false;
        slot.lastError = undefined;
        delete slot.modelCooldowns[normalizeModelBucket(targetModel)];
        if (slot.cooldownUntil <= Date.now()) {
          slot.cooldownUntil = 0;
        }
        return {
          index: slot.index,
          sourceEnv: slot.sourceEnv,
          maskedKey: slot.maskedKey,
          status: 'ready',
          latencyMs,
          modelTested: targetModel,
          flashLiteReady: true,
          message: `Hoạt động tốt trên ${targetModel} (${latencyMs}ms)`,
        };
      } catch (err: unknown) {
        const latencyMs = Date.now() - startMs;
        const msg = err instanceof Error ? err.message : String(err);
        const lower = msg.toLowerCase();
        slot.lastLatencyMs = latencyMs;
        slot.lastCheckedAt = Date.now();

        const isRateLimit =
          msg.includes('429') ||
          msg.includes('RESOURCE_EXHAUSTED') ||
          lower.includes('quota') ||
          lower.includes('rate limit');

        if (isRateLimit) {
          slot.rateLimitHits += 1;
          const retryMs = parseRetryAfterMs(msg);
          this.setSlotCooldown(slot, retryMs, targetModel, msg.slice(0, 180));

          // Also check if gemini-3.1-flash-lite is still available on this key when targetModel is flash-latest/3.8-flash
          let flashLiteReady = false;
          if (targetModel !== 'gemini-3.1-flash-lite') {
            try {
              await ai.interactions.create({
                model: 'gemini-3.1-flash-lite',
                store: false,
                input: 'OK',
                generation_config: { max_output_tokens: 16 },
              });
              flashLiteReady = true;
            } catch {
              flashLiteReady = false;
            }
          }

          const retryMatch = msg.match(/retry in\s+([0-9hms.]+)/i);
          const retryHint = retryMatch ? ` (Hồi sau ${retryMatch[1]})` : '';
          return {
            index: slot.index,
            sourceEnv: slot.sourceEnv,
            maskedKey: slot.maskedKey,
            status: 'cooldown',
            latencyMs,
            modelTested: targetModel,
            flashLiteReady,
            message: flashLiteReady
              ? `Chạm hạn mức 429 trên ${targetModel}${retryHint} • Nhưng SẴN SÀNG chạy ngay với gemini-3.1-flash-lite!`
              : `Chạm hạn mức 429 trên ${targetModel}${retryHint}`,
          };
        }

        slot.invalidKey = true;
        slot.lastError = msg.slice(0, 180);
        return {
          index: slot.index,
          sourceEnv: slot.sourceEnv,
          maskedKey: slot.maskedKey,
          status: 'invalid',
          latencyMs,
          modelTested: targetModel,
          flashLiteReady: false,
          message: `Key không hợp lệ hoặc bị từ chối: ${msg.slice(0, 110)}`,
        };
      }
    };

    const workers = Array.from(
      { length: Math.min(8, Math.max(1, this.slots.length)) },
      async () => {
        while (true) {
          const i = cursor++;
          if (i >= this.slots.length) break;
          keyResults[i] = await testSingleSlot(this.slots[i]);
        }
      }
    );
    await Promise.all(workers);

    const anyReadyOnTarget = keyResults.some((k) => k.status === 'ready');
    const anyReadyOnLite = keyResults.some((k) => k.flashLiteReady);
    const avgLatency =
      keyResults.length > 0
        ? Math.round(
            keyResults.reduce((acc, k) => acc + k.latencyMs, 0) / keyResults.length
          )
        : 0;

    const aiStatus: 'ok' | 'warning' | 'error' =
      keyResults.length === 0
        ? 'error'
        : anyReadyOnTarget
          ? 'ok'
          : anyReadyOnLite
            ? 'warning'
            : 'error';

    const aiStatusDetail =
      keyResults.length === 0
        ? 'Bể Key đang trống (0 Key). Hãy dán danh sách Gemini API Key của bạn vào ô bên trên rồi bấm Lưu!'
        : anyReadyOnTarget
          ? `Sẵn sàng (${keyResults.filter((k) => k.status === 'ready').length}/${keyResults.length} Key hoạt động tốt trên ${targetModel})`
          : anyReadyOnLite
            ? `Hết hạn mức ${targetModel}, nhưng SẴN SÀNG chạy trên gemini-3.1-flash-lite (hoặc thêm Key mới)`
            : `Tất cả ${keyResults.length} Key đang chạm giới hạn 429 hoặc lỗi. Hãy dán thêm Key mới!`;

    const endpointResults: ApiEndpointCheckResult[] = [
      {
        endpoint: '/api/translate',
        method: 'POST',
        name: 'API Dịch Chương 1:1 Block-ID (Structured JSON Schema)',
        description:
          'Dịch trọn vẹn 1 chương/request qua SDK @google/genai 2.31.0 (ai.interactions.create) khớp 1:1 TITLE, P0001..Pxxxx.',
        status: aiStatus,
        latencyMs: avgLatency,
        detail: aiStatusDetail,
      },
      {
        endpoint: '/api/editor/assist',
        method: 'POST',
        name: 'API Biên Tập AI & Dọn Lỗi Đích Danh Block ID',
        description:
          'Dọn chữ Hán sót, khử từ tiếng Anh lọt câu, chuốt văn phong & gợi ý 3 phương án diễn đạt.',
        status: aiStatus,
        latencyMs: avgLatency,
        detail: aiStatusDetail,
      },
      {
        endpoint: '/api/glossary/extract',
        method: 'POST',
        name: 'API AI Quét & Trích Xuất Thuật Ngữ Hán-Việt',
        description:
          'Tự động phát hiện tên nhân vật, địa danh, cảnh giới, công pháp kèm phân loại chuẩn.',
        status: aiStatus,
        latencyMs: avgLatency,
        detail: aiStatusDetail,
      },
      {
        endpoint: '/api/models',
        method: 'GET',
        name: 'API Quản Lý Model, Lưu Bể 50 Key Dự Án & Chẩn Đoán',
        description:
          'Lưu trữ bền vững danh sách Key trong dự án (/data/project-key-pool.json) & xoay vòng độc lập 1 luồng = 1 Key.',
        status: 'ok',
        latencyMs: 12,
        detail: `Hoạt động tốt • Đang lưu ${this.slots.length} Key trong dự án`,
      },
      {
        endpoint: '/api/fetch-url',
        method: 'POST',
        name: 'API Tải Chương Truyện Nguyên Tác Từ URL',
        description:
          'Tự động giải mã UTF-8 / GB18030 / GBK và lọc sạch thẻ rác HTML từ trang truyện tiếng Trung.',
        status: 'ok',
        latencyMs: 8,
        detail: 'Hoạt động tốt (Bộ giải mã đa bảng mã CJK sẵn sàng)',
      },
    ];

    return {
      testedAt: Date.now(),
      modelTested: targetModel,
      keyResults,
      endpointResults,
      poolStatus: this.getPoolStatus(targetModel),
    };
  }
}

declare global {
  var __MHC_GEMINI_KEY_POOL__: ServerGeminiKeyPool | undefined;
}

export const geminiKeyPool: ServerGeminiKeyPool =
  globalThis.__MHC_GEMINI_KEY_POOL__ ??
  (globalThis.__MHC_GEMINI_KEY_POOL__ = new ServerGeminiKeyPool());

export const MANDATORY_HIGH_THINKING_CONFIG = {
  thinkingConfig: {
    thinkingLevel: ThinkingLevel.HIGH,
  },
  maxOutputTokens: 65536,
};

/**
 * Default generation_config for Gemini Interactions API (`ai.interactions.create`)
 * in @google/genai >= 2.31.0 when user does not override thinkingLevel.
 */
export const MANDATORY_INTERACTION_GENERATION_CONFIG = {
  thinking_level: 'high' as const,
  max_output_tokens: 65536,
};

const VALID_THINKING_LEVELS: readonly ThinkingLevelOption[] = [
  'minimal',
  'low',
  'medium',
  'high',
];

/**
 * Normalizes any incoming thinkingLevel string against @google/genai ThinkingLevel values.
 * Defaults to 'high' if omitted or invalid.
 */
export function normalizeThinkingLevel(
  level?: string | null
): ThinkingLevelOption {
  if (!level || typeof level !== 'string') {
    return DEFAULT_THINKING_LEVEL;
  }
  const clean = level.trim().toLowerCase() as ThinkingLevelOption;
  if (VALID_THINKING_LEVELS.includes(clean)) {
    return clean;
  }
  return DEFAULT_THINKING_LEVEL;
}

/**
 * Resolves a safe `thinking_level` for the target model according to official @google/genai docs:
 * - `'minimal'` is ONLY supported on Flash-Lite models (e.g. `gemini-3.1-flash-lite`, `gemini-flash-lite-latest`).
 * - Passing `'minimal'` to `gemini-3.8-flash`, `gemini-flash-latest`, or `gemini-4-argon` returns a 400 error,
 *   so it is automatically upgraded to `'low'` on non-lite models.
 */
export function resolveThinkingLevelForModel(
  level?: string | null,
  modelName?: string | null
): ThinkingLevelOption {
  const normalized = normalizeThinkingLevel(level);
  if (normalized === 'minimal') {
    const cleanModel = (modelName || '').trim().toLowerCase();
    const isLiteModel = cleanModel.includes('lite');
    if (!isLiteModel) {
      return 'low';
    }
  }
  return normalized;
}

/**
 * Dynamically inspects @google/genai SDK's `ThinkingLevel` enum + model capability metadata
 * to return the list of available thinking levels (`minimal`, `low`, `medium`, `high`),
 * with `'high'` marked as default.
 */
export function getAvailableThinkingLevelsFromSdk(
  modelName?: string,
  modelSupportsThinking = true
): ThinkingLevelMeta[] {
  const sdkValues = new Set<string>(
    Object.values(ThinkingLevel || {}).map((v) =>
      String(v).trim().toLowerCase()
    )
  );
  const cleanModel = (modelName || '').trim().toLowerCase();
  const isLiteModel = !cleanModel || cleanModel.includes('lite');
  const orderedIds: ThinkingLevelOption[] = isLiteModel
    ? ['minimal', 'low', 'medium', 'high']
    : ['low', 'medium', 'high'];
  const presetMap = new Map<ThinkingLevelOption, ThinkingLevelMeta>(
    THINKING_LEVEL_OPTIONS.map((item) => [item.id, item])
  );

  const sourceTag = modelSupportsThinking
    ? `SDK @google/genai (${modelName || 'gemini-flash-latest'})`
    : `SDK @google/genai`;

  return orderedIds
    .filter((id) => sdkValues.size === 0 || sdkValues.has(id))
    .map((id) => {
      const preset = presetMap.get(id);
      return {
        id,
        label: preset?.label || `${id}`,
        badge: preset?.badge || (id === 'high' ? 'Mặc định' : 'Tùy chọn'),
        description: preset?.description || `Mức suy luận ${id}`,
        isDefault: id === DEFAULT_THINKING_LEVEL,
        source: sourceTag,
      };
    });
}

/**
 * Builds generation_config for `ai.interactions.create` in @google/genai >= 2.31.0:
 * - Resolves `thinking_level` safely per model (`'minimal'` -> `'low'` on non-lite models to prevent 400 errors).
 * - Strips deprecated sampling parameters (`temperature`, `top_p`, `topP`, `topK`, `top_k`) per official @google/genai docs.
 * - Sets `max_output_tokens: 65536`.
 */
export function buildInteractionGenerationConfig(
  thinkingLevel?: string | null,
  extra?: Record<string, unknown>,
  modelName?: string | null
): {
  thinking_level: ThinkingLevelOption;
  max_output_tokens: number;
  [key: string]: unknown;
} {
  const sanitizedExtra: Record<string, unknown> = {};
  if (extra && typeof extra === 'object') {
    for (const [k, v] of Object.entries(extra)) {
      if (
        k === 'temperature' ||
        k === 'top_p' ||
        k === 'topP' ||
        k === 'top_k' ||
        k === 'topK' ||
        k === 'candidateCount' ||
        k === 'candidate_count'
      ) {
        continue;
      }
      sanitizedExtra[k] = v;
    }
  }
  return {
    ...sanitizedExtra,
    thinking_level: resolveThinkingLevelForModel(thinkingLevel, modelName),
    max_output_tokens: 65536,
  };
}

/**
 * Maximum number of items where `enum` + `minItems`/`maxItems` are enforced at the JSON Schema level.
 * Per @google/genai docs (`TextResponseFormat_2`), overly large `maxItems`/`enum` constraints on nested arrays
 * can trigger a `400 INVALID_ARGUMENT` (schema state-space complexity) error, so chapters > 64 blocks
 * rely on deterministic post-parse ID validation in `materializeBlocksToChapter`.
 */
export const MAX_SCHEMA_ENUM_AND_BOUNDS_ITEMS = 64;

/**
 * Builds the official Structured Output `response_format` schema for 1:1 Block-ID Chapter Translation
 * and Full-Chapter Re-Alignment (`blocks-v1`).
 */
export function buildBlocksResponseFormat(
  expectedBlockIds: string[],
  blocksDescription = 'Danh sách đầy đủ các block đã dịch theo đúng thứ tự nguyên văn, bắt đầu bằng TITLE rồi đến P0001, P0002...'
): Record<string, unknown> {
  const idPropertySchema: Record<string, unknown> = {
    type: 'string',
    description:
      'Mã định danh block nguyên gốc (TITLE, P0001, P0002...). Phải khớp 1:1 với input.',
  };
  const blocksArraySchema: Record<string, unknown> = {
    type: 'array',
    description: blocksDescription,
    items: {
      type: 'object',
      properties: {
        id: idPropertySchema,
        translation: {
          type: 'string',
          description:
            'Bản dịch tiếng Việt mượt mà của block này (1 đoạn duy nhất, không chứa ký tự xuống dòng).',
        },
      },
      required: ['id', 'translation'],
      additionalProperties: false,
    },
  };

  if (
    expectedBlockIds.length > 0 &&
    expectedBlockIds.length <= MAX_SCHEMA_ENUM_AND_BOUNDS_ITEMS
  ) {
    idPropertySchema.enum = expectedBlockIds;
    blocksArraySchema.minItems = expectedBlockIds.length;
    blocksArraySchema.maxItems = expectedBlockIds.length;
  }

  return {
    type: 'object',
    properties: {
      blocks: blocksArraySchema,
    },
    required: ['blocks'],
    additionalProperties: false,
  };
}

/**
 * Builds the official Structured Output `response_format` schema for Targeted Block-ID Cleanup (`block-cleanup-v1`).
 */
export function buildBlockUpdatesResponseFormat(
  targetIds: string[]
): Record<string, unknown> {
  const idPropertySchema: Record<string, unknown> = {
    type: 'string',
    description: 'Mã Block ID (TITLE, P0001, P0002...).',
  };
  const updatesArraySchema: Record<string, unknown> = {
    type: 'array',
    description:
      'Danh sách các block đã được làm sạch tương ứng 1:1 với các id trong targets.',
    items: {
      type: 'object',
      properties: {
        id: idPropertySchema,
        translation: {
          type: 'string',
          description:
            'Bản tiếng Việt hoàn chỉnh, sạch 100% Hán tự và từ tiếng Anh thừa, không xuống dòng.',
        },
      },
      required: ['id', 'translation'],
      additionalProperties: false,
    },
  };

  if (
    targetIds.length > 0 &&
    targetIds.length <= MAX_SCHEMA_ENUM_AND_BOUNDS_ITEMS
  ) {
    idPropertySchema.enum = targetIds;
    updatesArraySchema.minItems = targetIds.length;
    updatesArraySchema.maxItems = targetIds.length;
  }

  return {
    type: 'object',
    properties: {
      updates: updatesArraySchema,
    },
    required: ['updates'],
    additionalProperties: false,
  };
}

/**
 * Builds the official Structured Output `response_format` schema for Alternative Phrasings (`minItems: 3, maxItems: 3`).
 */
export function buildAlternativesResponseFormat(
  count = 3
): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      alternatives: {
        type: 'array',
        minItems: count,
        maxItems: count,
        items: { type: 'string' },
        description: `${count} phương án viết lại đoạn văn.`,
      },
    },
    required: ['alternatives'],
    additionalProperties: false,
  };
}

/**
 * Builds the official Structured Output `response_format` schema for Single-Passage / Full-Chapter Editorial Polish (`{ translation }`).
 * Synchronized with Editorial Presets v1.14.1 and v1.14.0 Mode A (`{"translation":"..."}`).
 */
export function buildEditedTextResponseFormat(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      translation: {
        type: 'string',
        description:
          'Toàn bộ văn bản tiếng Việt sau khi đã biên tập hoàn chỉnh.',
      },
    },
    required: ['translation'],
    additionalProperties: false,
  };
}

/**
 * Builds the official Structured Output `response_format` schema for Pre-Translation Glossary Extraction (`maxItems: 120`).
 */
export function buildGlossaryExtractResponseFormat(
  maxItems = 120
): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      terms: {
        type: 'array',
        maxItems,
        items: {
          type: 'object',
          properties: {
            sourceTerm: {
              type: 'string',
              description: 'Từ gốc tiếng Trung chính tắc (chữ Hán).',
            },
            targetTerm: {
              type: 'string',
              description: 'Bản dịch Hán Việt / Tiếng Việt chuẩn cố định.',
            },
            aliases: {
              type: 'array',
              items: { type: 'string' },
              description:
                'Danh sách các cách viết tiếng Trung khác / biệt danh / đạo hiệu của cùng thực thể này (nếu có, nếu không trả về mảng rỗng []).',
            },
            policy: {
              type: 'string',
              enum: ['force', 'prefer', 'contextual', 'keep_source'],
              description:
                'Chính sách dịch: force (cố định) | prefer (ưu tiên) | contextual (tùy ngữ cảnh) | keep_source (giữ nguyên).',
            },
            category: {
              type: 'string',
              enum: [
                'character',
                'location',
                'cultivation',
                'skill',
                'organization',
                'item',
                'title',
                'pronoun',
                'other',
              ],
              description:
                'Phân loại: character | location | cultivation | skill | organization | item | title | pronoun | other',
            },
            notes: {
              type: 'string',
              description:
                'Ghi chú ngắn gọn về vai trò, giới tính, quan hệ và quy tắc xưng hô.',
            },
          },
          required: [
            'sourceTerm',
            'targetTerm',
            'aliases',
            'policy',
            'category',
            'notes',
          ],
          additionalProperties: false,
        },
      },
    },
    required: ['terms'],
    additionalProperties: false,
  };
}

/**
 * Extracts output text from a Gemini Interactions API response (`ai.interactions.create`).
 * - Validates `interaction.status` and `interaction.errors` first so `failed`, `cancelled`, or `incomplete`
 *   interactions throw an explicit error rather than silently returning empty/partial text.
 * - Strictly extracts text from `model_output` steps (never mixing `thought` reasoning steps),
 *   falling back to `interaction.output_text`.
 */
export function extractInteractionText(
  interaction: {
    status?: string | null;
    errors?: Array<{ code?: string | number; message?: string }> | null;
    output_text?: string | null;
    steps?: Array<{
      type?: string;
      finish_reason?: string;
      content?:
        | Array<{ type?: string; text?: string }>
        | { type?: string; text?: string };
    }>;
  },
  contextLabel = 'InteractionOutput'
): string {
  const status =
    typeof interaction?.status === 'string'
      ? interaction.status.trim().toLowerCase()
      : '';

  if (Array.isArray(interaction?.errors) && interaction.errors.length > 0) {
    const errDetail = interaction.errors
      .map((e) => `${e?.code ? `[${e.code}] ` : ''}${e?.message || 'Lỗi từ Gemini Interactions API'}`)
      .join('; ');
    logger.error(
      'KEY_POOL',
      `✖ [${contextLabel}] Interaction trả về lỗi hệ thống (status=${status || 'unknown'}): ${errDetail}`
    );
    throw new Error(`[INTERACTION_ERROR] Phản hồi từ Gemini bị lỗi (${status || 'error'}): ${errDetail}`);
  }

  if (status === 'failed' || status === 'cancelled') {
    logger.error(
      'KEY_POOL',
      `✖ [${contextLabel}] Interaction kết thúc với trạng thái "${status}".`
    );
    throw new Error(
      `[INTERACTION_${status.toUpperCase()}] Phiên xử lý AI kết thúc với trạng thái "${status}" (có thể do bộ lọc an toàn Safety hoặc ngắt kết nối).`
    );
  }

  // Prefer concatenating all chronological `model_output` steps (as recommended by @google/genai Interactions docs
  // so multi-step outputs are never truncated to only the trailing step, while strictly ignoring `thought` steps)
  let extractedText = '';
  if (Array.isArray(interaction?.steps)) {
    const chunks: string[] = [];
    for (const step of interaction.steps) {
      if (step?.type === 'model_output' && step.content) {
        const items = Array.isArray(step.content)
          ? step.content
          : [step.content];
        for (const item of items) {
          if (item?.type === 'text' && typeof item.text === 'string') {
            chunks.push(item.text);
          }
        }
      }
    }
    if (chunks.length > 0) {
      extractedText = chunks.join('');
    }
  }

  if (
    !extractedText.trim() &&
    typeof interaction?.output_text === 'string' &&
    interaction.output_text.trim()
  ) {
    extractedText = interaction.output_text;
  }

  if (status === 'incomplete') {
    logger.warn(
      'KEY_POOL',
      `⚠️ [${contextLabel}] Interaction có trạng thái "incomplete" (chạm giới hạn token đầu ra max_output_tokens hoặc bị ngắt sớm). Độ dài text=${extractedText.length}.`
    );
    if (!extractedText.trim()) {
      throw new Error(
        '[INTERACTION_INCOMPLETE] Phản hồi từ AI bị ngắt giữa chừng (status=incomplete) và không có dữ liệu đầu ra.'
      );
    }
  }

  return extractedText;
}

/**
 * Safely parses JSON from an Interaction output string, stripping markdown code fences if present
 * and detecting truncated JSON outputs (e.g. when max_output_tokens is exceeded).
 */
export function safeParseInteractionJson<T>(
  rawText: string,
  contextLabel = 'InteractionOutput'
): T {
  const trimmed = (rawText || '').trim();
  if (!trimmed) {
    logger.error('KEY_POOL', `✖ [${contextLabel}] Model trả về phản hồi rỗng (0 ký tự).`);
    throw new Error('[EMPTY_STRUCTURED_OUTPUT] Model trả về phản hồi rỗng (có thể do bộ lọc Safety hoặc chạm giới hạn suy luận).');
  }
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = fenceMatch ? fenceMatch[1].trim() : trimmed;
  try {
    return JSON.parse(candidate) as T;
  } catch (firstErr) {
    // Check if the JSON was clearly truncated mid-stream (starts with '{' or '[' but doesn't end with '}' or ']')
    const startsLikeJson =
      candidate.startsWith('{') || candidate.startsWith('[');
    const endsLikeJson =
      candidate.endsWith('}') || candidate.endsWith(']');

    if (startsLikeJson && !endsLikeJson) {
      logger.error(
        'KEY_POOL',
        `✖ [${contextLabel}] Chuỗi JSON từ AI bị cắt cụt giữa chừng (Truncated JSON — khả năng cao vượt max_output_tokens)`,
        {
          contextLabel,
          rawLength: trimmed.length,
          rawHeadPreview: trimmed.slice(0, 400),
          rawTailPreview: trimmed.slice(-400),
        }
      );
      throw new Error(
        `[TRUNCATED_JSON_OUTPUT] Chuỗi JSON trả về từ AI bị cắt cụt giữa chừng (độ dài ${trimmed.length} ký tự, có thể do chương quá dài chạm trần max_output_tokens).`
      );
    }

    const objMatch = candidate.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
    if (objMatch) {
      try {
        return JSON.parse(objMatch[1]) as T;
      } catch (secondErr) {
        logger.error(
          'KEY_POOL',
          `✖ [${contextLabel}] Lỗi JSON.parse trên phản hồi từ AI`,
          {
            contextLabel,
            parseError:
              secondErr instanceof Error ? secondErr.message : String(secondErr),
            rawLength: trimmed.length,
            rawHeadPreview: trimmed.slice(0, 600),
            rawTailPreview: trimmed.slice(-600),
          }
        );
        throw new Error(
          `Phản hồi từ AI không đúng định dạng JSON hợp lệ (${
            secondErr instanceof Error ? secondErr.message : 'Parse error'
          }). Đã ghi nội dung thô vào Console.`
        );
      }
    }
    logger.error(
      'KEY_POOL',
      `✖ [${contextLabel}] Phản hồi từ AI không chứa cấu trúc JSON hợp lệ`,
      {
        contextLabel,
        parseError:
          firstErr instanceof Error ? firstErr.message : String(firstErr),
        rawLength: trimmed.length,
        rawHeadPreview: trimmed.slice(0, 600),
        rawTailPreview: trimmed.slice(-600),
      }
    );
    throw new Error('Phản hồi từ AI không đúng định dạng JSON hợp lệ.');
  }
}

/**
 * Parses the `X-MHC-Tried-Keys` header sent by `safeFetchJson` when Sợi dây 1 is renewed
 * so the new HTTP request skips keys already tried in previous connections.
 */
export function parseTriedKeysHeader(headerValue?: string | null): number[] {
  if (!headerValue || typeof headerValue !== 'string') return [];
  return headerValue
    .split(',')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isInteger(n) && n > 0);
}

/**
 * Cách 2 (Streaming Heartbeat trên Sợi dây 1):
 * - Gửi ngay HTTP 200 Headers + ký tự khoảng trắng đầu tiên ở t=0ms (TTFB < 10ms) để triệt tiêu lỗi First-Byte / headersTimeout.
 * - Cứ mỗi 10 giây trong lúc chờ AI suy nghĩ, gửi 1 ký tự khoảng trắng (" ") qua Sợi dây 1 để giữ kết nối sống trước mọi Reverse Proxy / Cloud Run.
 * - Khi `work()` hoàn tất, ghi chuỗi JSON kết quả (kèm `__httpStatus`) vào cuối luồng; vì khoảng trắng ở đầu hợp lệ 100% theo chuẩn RFC 8259 JSON nên `JSON.parse()` ở trình duyệt đọc mượt mà.
 */
export function createWire1HeartbeatStream(
  work: () => Promise<{ body: Record<string, unknown>; status?: number }>
): Response {
  const encoder = new TextEncoder();
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let streamClosed = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const safeEnqueue = (chunk: string) => {
        if (streamClosed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          streamClosed = true;
        }
      };

      // Immediately flush initial whitespace so HTTP headers & first byte cross the proxy immediately
      safeEnqueue(' \n');

      heartbeatTimer = setInterval(() => {
        safeEnqueue(' ');
      }, 10_000);

      try {
        const { body, status = 200 } = await work();
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = null;
        }
        const payload =
          status !== 200 ? { ...body, __httpStatus: status } : body;
        safeEnqueue(JSON.stringify(payload));
      } catch (unexpectedErr: unknown) {
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = null;
        }
        const message =
          unexpectedErr instanceof Error
            ? unexpectedErr.message
            : 'Lỗi không xác định trên máy chủ.';
        safeEnqueue(
          JSON.stringify({
            error: message,
            __httpStatus: 500,
          })
        );
      } finally {
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = null;
        }
        if (!streamClosed) {
          streamClosed = true;
          try {
            controller.close();
          } catch {
            // ignore already closed controller
          }
        }
      }
    },
    cancel() {
      streamClosed = true;
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    },
  });
}

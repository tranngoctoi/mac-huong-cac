import { NextRequest, NextResponse } from 'next/server';
import {
  buildBlocksResponseFormat,
  buildInteractionGenerationConfig,
  createWire1HeartbeatStream,
  DEFAULT_INTERACTION_REQUEST_OPTIONS,
  extractBlocksArrayFromParsedJson,
  extractInteractionText,
  geminiKeyPool,
  parseTriedKeysHeader,
  resolveThinkingLevelForModel,
  safeParseInteractionJson,
} from '@/lib/gemini-server';
import {
  createRequestId,
  KeyAttemptTrace,
  logger,
  ServerDebugTrace,
} from '@/lib/logger';
import { GlossaryEntry } from '@/lib/types';
import {
  buildContextualGlossaryPromptSection,
  materializeBlocksToChapter,
  splitRawIntoBlocks,
} from '@/lib/block-engine';
import { normalizeVietnameseText } from '@/lib/storage';

const DEFAULT_TRANSLATION_SYSTEM_PROMPT = `Bạn là Dịch Giả Tiểu Thuyết Trung Quốc (Hán Việt / Tiên Hiệp / Huyền Huyễn / Ngôn Tình / Đô Thị) chuyên nghiệp hàng đầu.
Nhiệm vụ của bạn là dịch trọn vẹn từng Block ID của chương truyện tiếng Trung sang tiếng Việt mượt mà, giàu hình ảnh văn học, đúng ngữ cảnh và xưng hô.

QUY TẮC BẮT BUỘC (STRUCTURED BLOCKS-V1):
1. Đầu vào được cung cấp dưới dạng JSON gồm các Block có mã định danh cố định: "TITLE" (tiêu đề chương) và "P0001", "P0002", ... (từng đoạn văn).
2. Bắt buộc trả về đúng chuẩn JSON Schema gồm mảng "blocks", trong đó MỖI phần tử {"id", "translation"} khớp chính xác 1:1 với "id" của đầu vào.
3. KHÔNG ĐƯỢC gộp 2 block làm 1, KHÔNG ĐƯỢC tách 1 block thành 2, KHÔNG ĐƯỢC bỏ sót bất kỳ mã ID nào.
4. Mỗi "translation" là một đoạn văn đơn, KHÔNG chứa ký tự xuống dòng (\\n).
5. TUYỆT ĐỐI KHÔNG để sót bất kỳ chữ Hán (ký tự Trung Quốc) nào trong kết quả tiếng Việt.
6. TUYỆT ĐỐI KHÔNG chêm từ tiếng Anh vô duyên (như "but", "however", "and", "so", "well", "ok"...) vào câu văn tiếng Việt.
7. Tiêu đề chương (block "TITLE") dịch chuẩn định dạng "Chương X: [Tên chương tiếng Việt]".`;

export async function POST(req: NextRequest) {
  const reqId =
    req.headers.get('x-mhc-request-id') || createRequestId('translate');
  const initialTriedKeys = parseTriedKeysHeader(
    req.headers.get('x-mhc-tried-keys')
  );
  const wireRenewalCount = parseInt(
    req.headers.get('x-mhc-wire-renewal') || '0',
    10
  );
  const maxWireRenewals = parseInt(
    req.headers.get('x-mhc-max-wire-renewals') || '50',
    10
  );
  const allowWireRenewal =
    Number.isNaN(wireRenewalCount) ||
    Number.isNaN(maxWireRenewals) ||
    wireRenewalCount < maxWireRenewals;

  const routeStartMs = Date.now();
  let selectedModel = 'gemini-flash-latest';
  let cleanFallbackModel: string | undefined;
  let resolvedThinkingLevel = resolveThinkingLevelForModel('high', selectedModel);
  let chapterNumForTrace = 1;
  let expectedBlocksCount = 0;
  let rawCharCount = 0;

  let body: {
    titleRaw?: string;
    rawContent?: string;
    chapterNumber?: number;
    model?: string;
    fallbackModel?: string;
    thinkingLevel?: string;
    systemInstruction?: string;
    includeGlossary?: boolean;
    glossary?: GlossaryEntry[];
  };

  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: 'Payload yêu cầu dịch không hợp lệ.' },
      { status: 400 }
    );
  }

  const {
    titleRaw = '',
    rawContent = '',
    chapterNumber = 1,
    model,
    fallbackModel,
    thinkingLevel,
    systemInstruction = '',
    includeGlossary = false,
    glossary = [],
  } = body;

  chapterNumForTrace = chapterNumber;
  rawCharCount = rawContent.length;
  selectedModel =
    typeof model === 'string' && model.trim()
      ? model.trim()
      : 'gemini-flash-latest';
  resolvedThinkingLevel = resolveThinkingLevelForModel(
    thinkingLevel,
    selectedModel
  );

  if (!rawContent || !rawContent.trim()) {
    logger.warn(
      'TRANSLATE',
      `✖ Từ chối dịch Chương #${chapterNumber}: rawContent trống.`,
      { reqId, chapterNumber },
      reqId
    );
    return NextResponse.json(
      { error: 'Nội dung chương nguyên tác (rawContent) đang trống.' },
      { status: 400 }
    );
  }

  return createWire1HeartbeatStream(async () => {
    try {
      cleanFallbackModel =
        typeof fallbackModel === 'string' && fallbackModel.trim()
          ? fallbackModel.trim()
          : undefined;

      // Build deterministic 1:1 Block-ID input for the ENTIRE chapter in 1 single request (TITLE, P0001, P0002...)
      const rawBlocks = splitRawIntoBlocks(titleRaw, rawContent);
      const expectedBlockIds = rawBlocks.map((b) => b.id);
      expectedBlocksCount = expectedBlockIds.length;
      const expectedBodyCount = Math.max(0, rawBlocks.length - 1);

      // Optional Dynamic Context-Aware Glossary injection (DEFAULT OFF — only active when user enables includeGlossary)
      let glossarySection = '';
      let matchedGlossaryCount = 0;
      if (includeGlossary && Array.isArray(glossary) && glossary.length > 0) {
        const contextual = buildContextualGlossaryPromptSection(
          glossary,
          `${titleRaw}\n${rawContent}`,
          '',
          chapterNumber
        );
        glossarySection = contextual.promptSection;
        matchedGlossaryCount = contextual.matchedCount;
      }

      logger.info(
        'TRANSLATE',
        `▶ Bắt đầu dịch nguyên Chương #${chapterNumber} (1 Request = 1 Chương • "${titleRaw.slice(0, 40)}") — ${rawBlocks.length} blocks, ${rawContent.length} ký tự Hán, Glossary=${includeGlossary ? `BẬT (${matchedGlossaryCount} mục khớp)` : 'TẮT'}, model=${selectedModel}, thinkingLevel=${resolvedThinkingLevel}`,
        {
          reqId,
          chapterNumber,
          titleRaw,
          blockCount: rawBlocks.length,
          rawChars: rawContent.length,
          includeGlossary,
          matchedGlossaryCount,
          selectedModel,
          fallbackModel: cleanFallbackModel,
          thinkingLevel: resolvedThinkingLevel,
          initialTriedKeys,
        },
        reqId
      );

      const customInstructionSection = systemInstruction.trim()
        ? `\n\n[CHỈ DẪN PHONG CÁCH & XƯNG HÔ RIÊNG CỦA BỘ TRUYỆN]:\n${systemInstruction.trim()}`
        : '';

      const fullSystemPrompt = `${DEFAULT_TRANSLATION_SYSTEM_PROMPT}${customInstructionSection}${glossarySection}`;

      // Send 100% of the chapter in a single compact JSON payload
      const wireInputJson = JSON.stringify({
        schema: 'blocks-v1',
        chapterNumber,
        expectedBlockCount: rawBlocks.length,
        blocks: rawBlocks.map((b) => ({
          id: b.id,
          source: b.source,
        })),
      });

      const responseFormatSchema = buildBlocksResponseFormat(expectedBlockIds);

      const {
        result: validatedOutput,
        keyIndexUsed,
        totalKeys,
        modelUsed,
        didFallback,
        attempts,
      } = await geminiKeyPool.executeWithKeyRotation(
        async (ai, slotInfo) => {
          // If an earlier attempt on a long chapter timed out or truncated output, step down thinking_level
          // on subsequent attempts so output tokens are never starved while still sending 100% of the chapter in 1 request.
          let attemptThinking = thinkingLevel;
          if (slotInfo.attemptIndex > 0 && rawContent.length >= 6000) {
            const baseLevel = resolveThinkingLevelForModel(
              thinkingLevel,
              slotInfo.activeModel
            );
            if (baseLevel === 'high') {
              attemptThinking = 'low';
            }
          }

          const effectiveLevel = resolveThinkingLevelForModel(
            attemptThinking,
            slotInfo.activeModel
          );

          const interaction = await ai.interactions.create(
            {
              model: slotInfo.activeModel,
              store: false,
              system_instruction: fullSystemPrompt,
              input: wireInputJson,
              generation_config: buildInteractionGenerationConfig(
                effectiveLevel,
                undefined,
                slotInfo.activeModel
              ),
              response_format: responseFormatSchema,
            },
            DEFAULT_INTERACTION_REQUEST_OPTIONS
          );

          const contextLabel = `TranslateChapter#${chapterNumber}[${reqId}:K${slotInfo.keyIndex}]`;
          const rawText = extractInteractionText(interaction, contextLabel).trim();
          const parsed = safeParseInteractionJson<unknown>(rawText, contextLabel);
          const returnedBlocks = extractBlocksArrayFromParsedJson(parsed);

          if (!Array.isArray(returnedBlocks) || returnedBlocks.length === 0) {
            logger.error(
              'TRANSLATE',
              `✖ [${contextLabel}] Structured Output không chứa mảng "blocks" hợp lệ hoặc mảng rỗng.`,
              { reqId, chapterNumber, rawPreview: rawText.slice(0, 500) },
              reqId
            );
            throw new Error(
              '[INVALID_STRUCTURED_OUTPUT] Model trả về JSON nhưng mảng "blocks" đang rỗng hoặc sai cấu trúc.'
            );
          }

          const materialized = materializeBlocksToChapter(
            returnedBlocks,
            rawBlocks,
            chapterNumber
          );

          const cleanTitleVi = normalizeVietnameseText(
            materialized.titleTranslated
          );
          const cleanBodyVi = normalizeVietnameseText(
            materialized.translatedContent
          );
          const visibleBodyChars = cleanBodyVi
            .replace(/\u200B/g, '')
            .trim().length;

          if (
            expectedBodyCount > 0 &&
            (materialized.alignment.translatedBlockCount === 0 ||
              visibleBodyChars === 0)
          ) {
            logger.error(
              'TRANSLATE',
              `✖ [${contextLabel}] Tất cả ${expectedBodyCount} đoạn thân chương đều bị trống sau khi đối chiếu Block ID.`,
              {
                reqId,
                chapterNumber,
                returnedBlocksCount: returnedBlocks.length,
                missingIds: materialized.missingIds.slice(0, 20),
                emptyIds: materialized.emptyIds.slice(0, 20),
                unexpectedIds: materialized.unexpectedIds.slice(0, 20),
              },
              reqId
            );
            throw new Error(
              `[INVALID_STRUCTURED_OUTPUT] Không có đoạn thân chương nào hợp lệ khớp với mã ID nguyên tác (thiếu ${materialized.missingIds.length} ID, rỗng ${materialized.emptyIds.length} ID).`
            );
          }

          return {
            materialized,
            returnedBlocksCount: returnedBlocks.length,
            cleanTitleVi,
            cleanBodyVi,
            effectiveLevel,
          };
        },
        selectedModel,
        cleanFallbackModel,
        {
          reqId,
          endpoint: '/api/translate',
          label: `Chapter #${chapterNumber} (${rawBlocks.length} blocks • thinking=${resolvedThinkingLevel})`,
          signal: req.signal,
          initialTriedKeys,
          allowWireRenewal,
        }
      );

      const {
        materialized,
        returnedBlocksCount,
        cleanTitleVi,
        cleanBodyVi,
        effectiveLevel,
      } = validatedOutput;
      resolvedThinkingLevel = effectiveLevel;

      if (
        materialized.missingIds.length > 0 ||
        materialized.duplicateIds.length > 0 ||
        materialized.emptyIds.length > 0 ||
        materialized.unexpectedIds.length > 0
      ) {
        logger.warn(
          'TRANSLATE',
          `⚠️ [TranslateChapter#${chapterNumber}[${reqId}]] Phát hiện sai lệch cục bộ trên Structured Output Chương #${chapterNumber} (đã bảo toàn vị trí slot 1:1): thiếu=${materialized.missingIds.length}, rỗng=${materialized.emptyIds.length}, trùng=${materialized.duplicateIds.length}, ID lạ=${materialized.unexpectedIds.length}`,
          {
            reqId,
            chapterNumber,
            missingIds: materialized.missingIds.slice(0, 20),
            emptyIds: materialized.emptyIds.slice(0, 20),
            duplicateIds: materialized.duplicateIds.slice(0, 20),
            unexpectedIds: materialized.unexpectedIds.slice(0, 20),
          },
          reqId
        );
      }

      const routeDurationMs = Date.now() - routeStartMs;
      const debugTrace: ServerDebugTrace = {
        reqId,
        endpoint: '/api/translate',
        startedAt: new Date(routeStartMs).toISOString(),
        totalDurationMs: routeDurationMs,
        requestedModel: selectedModel,
        fallbackModel: cleanFallbackModel,
        modelUsed,
        thinkingLevelUsed: resolvedThinkingLevel,
        didFallback,
        keyIndexUsed,
        totalPoolKeys: totalKeys,
        inputSummary: {
          chapterNumber,
          expectedBlocksCount: rawBlocks.length,
          rawCharCount: rawContent.length,
          includeGlossary,
          matchedGlossaryCount,
          thinkingLevel: resolvedThinkingLevel,
        },
        outputSummary: {
          returnedBlocksCount,
          translatedCharCount: cleanBodyVi.length,
          isAligned: materialized.alignment.isAligned,
          missingIdsCount: materialized.missingIds.length,
          duplicateIdsCount: materialized.duplicateIds.length,
          emptyIdsCount: materialized.emptyIds.length,
          unexpectedIdsCount: materialized.unexpectedIds.length,
        },
        attempts,
      };

      logger.info(
        'TRANSLATE',
        `✔ Hoàn tất dịch Chương #${chapterNumber} qua ${modelUsed} (thinking=${resolvedThinkingLevel}, Key #${keyIndexUsed}/${totalKeys}) — ${materialized.alignment.translatedBlockCount}/${expectedBodyCount} đoạn thân (aligned=${materialized.alignment.isAligned}) trong ${(routeDurationMs / 1000).toFixed(2)}s`,
        {
          reqId,
          chapterNumber,
          modelUsed,
          thinkingLevelUsed: resolvedThinkingLevel,
          keyIndexUsed,
          returnedBlocksCount,
          expectedBlocksCount: rawBlocks.length,
          isAligned: materialized.alignment.isAligned,
          routeDurationMs,
        },
        reqId,
        routeDurationMs
      );

      return {
        status: 200,
        body: {
          titleTranslated: cleanTitleVi,
          translatedContent: cleanBodyVi,
          alignment: materialized.alignment,
          missingIds: materialized.missingIds,
          duplicateIds: materialized.duplicateIds,
          emptyIds: materialized.emptyIds,
          unexpectedIds: materialized.unexpectedIds,
          modelUsed,
          thinkingLevelUsed: resolvedThinkingLevel,
          didFallback,
          keyUsed: keyIndexUsed,
          totalKeys,
          matchedGlossaryCount,
          debugTrace,
        },
      };
    } catch (err) {
      const routeDurationMs = Date.now() - routeStartMs;
      const message =
        err instanceof Error ? err.message : 'Lỗi không xác định khi dịch chương.';
      const isPoolExhausted = message.includes('[POOL_EXHAUSTED_429]');
      const errWithTrace = err as Error & {
        attempts?: KeyAttemptTrace[];
        renewWire1?: boolean;
        triedKeyIndices?: number[];
      };

      const debugTrace: ServerDebugTrace = {
        reqId,
        endpoint: '/api/translate',
        startedAt: new Date(routeStartMs).toISOString(),
        totalDurationMs: routeDurationMs,
        requestedModel: selectedModel,
        fallbackModel: cleanFallbackModel,
        thinkingLevelUsed: resolvedThinkingLevel,
        totalPoolKeys: geminiKeyPool.getPoolStatus(selectedModel).totalConfiguredKeys,
        inputSummary: {
          chapterNumber: chapterNumForTrace,
          expectedBlocksCount,
          rawCharCount,
        },
        attempts: errWithTrace?.attempts || [],
        errorDetail: {
          name: err instanceof Error ? err.name : 'Error',
          message,
          stackPreview:
            err instanceof Error && err.stack
              ? err.stack.split('\n').slice(0, 5).join('\n')
              : undefined,
        },
      };

      if (errWithTrace?.renewWire1) {
        return {
          status: 200,
          body: {
            renewWire1: true,
            triedKeyIndices: errWithTrace.triedKeyIndices || initialTriedKeys,
            debugTrace,
          },
        };
      }

      logger.error(
        'TRANSLATE',
        `✖ Lỗi dịch Chương #${chapterNumForTrace} sau ${(routeDurationMs / 1000).toFixed(2)}s: ${message}`,
        {
          reqId,
          chapterNumber: chapterNumForTrace,
          isPoolExhausted,
          debugTrace,
        },
        reqId,
        routeDurationMs
      );

      return {
        status: isPoolExhausted ? 429 : 500,
        body: {
          error: message.replace('[POOL_EXHAUSTED_429] ', ''),
          poolExhausted429: isPoolExhausted,
          debugTrace,
        },
      };
    }
  });
}


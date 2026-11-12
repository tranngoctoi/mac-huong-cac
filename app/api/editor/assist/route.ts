import { NextRequest, NextResponse } from 'next/server';
import {
  buildAlternativesResponseFormat,
  buildBlocksResponseFormat,
  buildBlockUpdatesResponseFormat,
  buildEditedTextResponseFormat,
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
  normalizeReturnedBlockId,
  splitRawIntoBlocks,
  splitTranslatedBodyIntoParagraphs,
} from '@/lib/block-engine';
import { normalizeVietnameseText } from '@/lib/storage';

interface DirtyBlockTarget {
  id: string;
  source: string;
  translation: string;
  contextBefore?: string;
  contextAfter?: string;
}

type AssistAction =
  | 'polish'
  | 'fix_pronouns'
  | 'fix_qa'
  | 'alternatives'
  | 'translate_title'
  | 'block_cleanup'
  | 'realign_chapter'
  | 'custom';

export async function POST(req: NextRequest) {
  const reqId =
    req.headers.get('x-mhc-request-id') || createRequestId('ai_editor');
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
  let actionForTrace: string = 'polish';

  let body: {
    action?: AssistAction;
    selectedText?: string;
    surroundingContext?: string;
    rawReference?: string;
    titleRaw?: string;
    rawContent?: string;
    titleTranslated?: string;
    translatedContent?: string;
    pronounRule?: string;
    systemInstruction?: string;
    customPrompt?: string;
    includeGlossary?: boolean;
    glossary?: GlossaryEntry[];
    targets?: DirtyBlockTarget[];
    chapterNumber?: number;
    model?: string;
    fallbackModel?: string;
    thinkingLevel?: string;
  };

  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: 'Payload yêu cầu biên tập không hợp lệ.' },
      { status: 400 }
    );
  }

  return createWire1HeartbeatStream(async () => {
    try {
      const {
        action = 'polish',
        selectedText = '',
        surroundingContext = '',
        rawReference = '',
        titleRaw = '',
        rawContent = '',
        titleTranslated = '',
        translatedContent = '',
        pronounRule = '',
        systemInstruction = '',
        customPrompt = '',
        includeGlossary = false,
        glossary = [],
        targets = [],
        chapterNumber,
        model,
        fallbackModel,
        thinkingLevel,
      } = body;

      actionForTrace = action;

      selectedModel =
        typeof model === 'string' && model.trim()
          ? model.trim()
          : 'gemini-flash-latest';

      cleanFallbackModel =
        typeof fallbackModel === 'string' && fallbackModel.trim()
          ? fallbackModel.trim()
          : undefined;

      resolvedThinkingLevel = resolveThinkingLevelForModel(
        thinkingLevel,
        selectedModel
      );

      logger.info(
        'AI_EDITOR',
        `▶ Bắt đầu AI Editor (action=${action}, model=${selectedModel}, thinkingLevel=${resolvedThinkingLevel}, targets=${targets?.length || 0}, selectedTextChars=${selectedText.length || translatedContent.length})`,
        {
          reqId,
          action,
          chapterNumber,
          targetsCount: targets?.length || 0,
          selectedTextChars: selectedText.length || translatedContent.length,
          includeGlossary,
          selectedModel,
          fallbackModel: cleanFallbackModel,
          thinkingLevel: resolvedThinkingLevel,
          initialTriedKeys,
        },
        reqId
      );

      let glossaryNote = '';
      if (includeGlossary && Array.isArray(glossary) && glossary.length > 0) {
        const combinedSource =
          action === 'block_cleanup'
            ? targets.map((t) => t.source || '').join('\n')
            : action === 'realign_chapter'
              ? `${titleRaw}\n${rawContent}`
              : `${rawReference}\n${selectedText}`;
        const combinedTranslated =
          action === 'block_cleanup'
            ? targets
                .map(
                  (t) =>
                    `${t.contextBefore || ''} ${t.translation || ''} ${t.contextAfter || ''}`
                )
                .join('\n')
            : action === 'realign_chapter'
              ? `${titleTranslated}\n${translatedContent}`
              : `${selectedText}\n${surroundingContext}`;
        const contextual = buildContextualGlossaryPromptSection(
          glossary,
          combinedSource,
          combinedTranslated,
          chapterNumber
        );
        glossaryNote = contextual.promptSection;
      }

      const editorialPersonaNote = systemInstruction.trim()
        ? `\n[CHỈ DẪN BIÊN TẬP CỦA DỰ ÁN]:\n${systemInstruction.trim()}`
        : '';

      const systemPrompt = `Bạn là Biên Tập Viên Tiểu Thuyết Trung - Việt cao cấp của Mặc Hương Các Studio.
Quy tắc bắt buộc:
- Biên tập, dịch bù chữ Hán sót, khử từ tiếng Anh lọt vào câu ('but', 'however', 'and'...) và chuốt văn phong tiếng Việt mượt mà.
- Không tự ý cắt bỏ tình tiết, giữ nguyên bố cục đoạn văn theo yêu cầu.
- Quy tắc xưng hô áp dụng: ${pronounRule || 'Theo đúng ngữ cảnh cổ trang / tiên hiệp'}.${editorialPersonaNote}${glossaryNote}`;

      // MODE 0: Full-Chapter Re-Alignment & Editorial (`realign_chapter` — 1 Request sends 100% of the chapter)
      if (action === 'realign_chapter') {
        if (!rawContent || !rawContent.trim()) {
          return {
            status: 400,
            body: {
              error:
                'Chương thiếu nguyên bản tiếng Trung (rawContent) để căn chỉnh lại đoạn 1:1.',
            },
          };
        }

        const rawBlocks = splitRawIntoBlocks(titleRaw, rawContent);
        const expectedBlockIds = rawBlocks.map((b) => b.id);
        const rawBodyCount = Math.max(0, rawBlocks.length - 1);
        const draftParagraphs = splitTranslatedBodyIntoParagraphs(
          translatedContent,
          rawBodyCount,
          'auto'
        );

        const fullRealignSystemPrompt = `${systemPrompt}

QUY TẮC BẮT BUỘC KHI BIÊN TẬP & CĂN CHỈNH LẠI TOÀN CHƯƠNG (CHAPTER-REALIGN-BLOCKS-V1):
1. Chương này đang được gửi TOÀN BỘ (gồm danh sách "rawBlocks" nguyên tác tiếng Trung có mã cố định "TITLE", "P0001".."P${String(rawBodyCount).padStart(4, '0')}" và bản dịch tiếng Việt hiện có "existingVietnameseDraft").
2. Lý do gửi cả chương: Bản dịch tiếng Việt hiện tại có ${draftParagraphs.length} đoạn trong khi nguyên tác có ${rawBodyCount} đoạn (bị lệch nhịp đoạn ở giữa/cuối chương), hoặc cần biên tập đồng bộ toàn chương.
3. Nhiệm vụ của bạn:
   - Đối chiếu toàn bộ "rawBlocks" với "existingVietnameseDraft" từ đầu đến cuối chương.
   - Tận dụng tối đa câu chữ, từ vựng và văn phong đã dịch tốt trong "existingVietnameseDraft", nhưng PHÂN BỔ LẠI (tách đoạn bị gộp, gộp đoạn bị tách thừa, hoặc dịch bù phần nguyên tác bị bỏ sót) sao cho kết quả trả về khớp CHÍNH XÁC 1:1 với từng mã "id" ("TITLE", "P0001", "P0002"...) của "rawBlocks".
   - TUYỆT ĐỐI KHÔNG dịch lặp lại nội dung ở cuối chương, KHÔNG bỏ sót hay thêm bớt bất kỳ mã ID nào.
   - Dọn sạch 100% chữ Hán còn sót, xóa từ tiếng Anh chêm sai ('but', 'however', 'and'...) và chuốt mượt câu văn tiếng Việt. Mỗi "translation" là 1 đoạn duy nhất không chứa ký tự xuống dòng (\\n).`;

        const wirePayload = JSON.stringify({
          schema: 'chapter-realign-edit-v1',
          chapterNumber: chapterNumber || 1,
          expectedBlockCount: rawBlocks.length,
          rawBodyBlockCount: rawBodyCount,
          draftBodyParagraphCount: draftParagraphs.length,
          rawBlocks: rawBlocks.map((b) => ({
            id: b.id,
            source: b.source,
          })),
          existingVietnameseDraft: {
            title: titleTranslated || '',
            paragraphs: draftParagraphs.map((text, idx) => ({
              draftOrder: `DRAFT_${String(idx + 1).padStart(4, '0')}`,
              text,
            })),
          },
        });

        const responseFormatSchema = buildBlocksResponseFormat(
          expectedBlockIds,
          'Danh sách đầy đủ các block đã biên tập và căn chỉnh 1:1 theo đúng thứ tự rawBlocks (bắt đầu bằng TITLE, tiếp theo là P0001, P0002...).'
        );

        const {
          result: validatedRealign,
          keyIndexUsed,
          totalKeys,
          modelUsed,
          didFallback,
          attempts,
        } = await geminiKeyPool.executeWithKeyRotation(
          async (ai, slotInfo) => {
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
                system_instruction: fullRealignSystemPrompt,
                input: wirePayload,
                generation_config: buildInteractionGenerationConfig(
                  effectiveLevel,
                  undefined,
                  slotInfo.activeModel
                ),
                response_format: responseFormatSchema,
              },
              DEFAULT_INTERACTION_REQUEST_OPTIONS
            );

            const contextLabel = `RealignChapter[${reqId}:K${slotInfo.keyIndex}]`;
            const parsed = safeParseInteractionJson<unknown>(
              extractInteractionText(interaction, contextLabel),
              contextLabel
            );
            const rawBlocksReturned = extractBlocksArrayFromParsedJson(parsed);

            if (
              !Array.isArray(rawBlocksReturned) ||
              rawBlocksReturned.length === 0
            ) {
              throw new Error(
                '[INVALID_STRUCTURED_OUTPUT] Model trả về JSON nhưng mảng "blocks" đang rỗng khi căn chỉnh chương.'
              );
            }

            const materialized = materializeBlocksToChapter(
              rawBlocksReturned,
              rawBlocks,
              chapterNumber || 1
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
              rawBodyCount > 0 &&
              (materialized.alignment.translatedBlockCount === 0 ||
                visibleBodyChars === 0)
            ) {
              throw new Error(
                `[INVALID_STRUCTURED_OUTPUT] Kết quả căn chỉnh chương không có đoạn thân nào hợp lệ khớp với rawBlocks.`
              );
            }

            return {
              materialized,
              returnedBlocksCount: rawBlocksReturned.length,
              cleanTitleVi,
              cleanBodyVi,
              effectiveLevel,
            };
          },
          selectedModel,
          cleanFallbackModel,
          {
            reqId,
            endpoint: '/api/editor/assist',
            label: `realign_chapter #${chapterNumber || 1} (${rawBlocks.length} blocks • draft=${draftParagraphs.length} • thinking=${resolvedThinkingLevel})`,
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
        } = validatedRealign;
        resolvedThinkingLevel = effectiveLevel;

        const routeDurationMs = Date.now() - routeStartMs;
        const debugTrace: ServerDebugTrace = {
          reqId,
          endpoint: '/api/editor/assist',
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
            action,
            chapterNumber,
            rawBlocks: rawBlocks.length,
            draftParagraphs: draftParagraphs.length,
            thinkingLevel: resolvedThinkingLevel,
          },
          outputSummary: {
            returnedBlocks: returnedBlocksCount,
            isAligned: materialized.alignment.isAligned,
            missingIdsCount: materialized.missingIds.length,
            duplicateIdsCount: materialized.duplicateIds.length,
            emptyIdsCount: materialized.emptyIds.length,
            unexpectedIdsCount: materialized.unexpectedIds.length,
          },
          attempts,
        };

        logger.info(
          'AI_EDITOR',
          `✔ Hoàn tất Biên tập & Căn chỉnh toàn Chương #${chapterNumber || 1}: ${materialized.alignment.translatedBlockCount}/${materialized.alignment.rawBlockCount} đoạn (aligned=${materialized.alignment.isAligned}) sau ${(routeDurationMs / 1000).toFixed(2)}s`,
          {
            reqId,
            chapterNumber,
            isAligned: materialized.alignment.isAligned,
            modelUsed,
            thinkingLevel: resolvedThinkingLevel,
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
            debugTrace,
          },
        };
      }

      // MODE 1: Targeted Block-ID AI Cleanup (`block_cleanup` — returns `{ updates: [{ id, translation }] }`)
      if (action === 'block_cleanup') {
        if (!Array.isArray(targets) || targets.length === 0) {
          return {
            status: 400,
            body: { error: 'Không có Block ID nào cần dọn lỗi.' },
          };
        }

        const targetIds = targets.map((t) => t.id);
        const expectedTargetIdSet = new Set(targetIds);

        const wirePayload = JSON.stringify({
          schema: 'block-cleanup-v1',
          instruction:
            'Chỉ sửa các block nằm trong danh sách targets bên dưới. Loại bỏ triệt để chữ Hán còn sót, xóa từ tiếng Anh chêm sai (như "but", "however", "and"), dịch bù nếu draft đang trống dựa trên source tiếng Trung, và giữ nguyên văn mạch (prevDraft/nextDraft). Trả về đúng mã id của từng target.',
          targets,
        });

        const responseFormatSchema = buildBlockUpdatesResponseFormat(targetIds);

        const {
          result: cleanedUpdates,
          keyIndexUsed,
          totalKeys,
          modelUsed,
          didFallback,
          attempts,
        } = await geminiKeyPool.executeWithKeyRotation(
          async (ai, slotInfo) => {
            const interaction = await ai.interactions.create(
              {
                model: slotInfo.activeModel,
                store: false,
                system_instruction: systemPrompt,
                input: wirePayload,
                generation_config: buildInteractionGenerationConfig(
                  thinkingLevel,
                  undefined,
                  slotInfo.activeModel
                ),
                response_format: responseFormatSchema,
              },
              DEFAULT_INTERACTION_REQUEST_OPTIONS
            );

            const contextLabel = `BlockCleanup[${reqId}:K${slotInfo.keyIndex}]`;
            const parsed = safeParseInteractionJson<unknown>(
              extractInteractionText(interaction, contextLabel),
              contextLabel
            );
            const rawUpdates = extractBlocksArrayFromParsedJson(parsed);

            if (!Array.isArray(rawUpdates) || rawUpdates.length === 0) {
              throw new Error(
                '[INVALID_STRUCTURED_OUTPUT] Model trả về JSON nhưng mảng "updates" đang rỗng.'
              );
            }

            const validUpdates = rawUpdates
              .map((u) => {
                const rawId = String(
                  u.id ?? u.blockId ?? u.block_id ?? ''
                ).trim();
                const id = normalizeReturnedBlockId(
                  rawId,
                  expectedTargetIdSet
                );
                const rawTr = String(
                  u.translation ?? u.text ?? u.content ?? ''
                );
                return {
                  id,
                  translation: normalizeVietnameseText(rawTr)
                    .replace(/\r?\n+/g, ' ')
                    .trim(),
                };
              })
              .filter(
                (u) =>
                  expectedTargetIdSet.has(u.id) && u.translation.length > 0
              );

            if (validUpdates.length === 0) {
              throw new Error(
                '[INVALID_STRUCTURED_OUTPUT] Không có bản cập nhật Block ID hợp lệ nào trong phản hồi từ AI.'
              );
            }

            return validUpdates;
          },
          selectedModel,
          cleanFallbackModel,
          {
            reqId,
            endpoint: '/api/editor/assist',
            label: `block_cleanup (${targets.length} blocks • thinking=${resolvedThinkingLevel})`,
            signal: req.signal,
            initialTriedKeys,
            allowWireRenewal,
          }
        );

        resolvedThinkingLevel = resolveThinkingLevelForModel(
          thinkingLevel,
          modelUsed
        );

        const routeDurationMs = Date.now() - routeStartMs;
        const debugTrace: ServerDebugTrace = {
          reqId,
          endpoint: '/api/editor/assist',
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
            action,
            targetsCount: targets.length,
            thinkingLevel: resolvedThinkingLevel,
          },
          outputSummary: { updatesCount: cleanedUpdates.length },
          attempts,
        };

        return {
          status: 200,
          body: {
            updates: cleanedUpdates,
            modelUsed,
            thinkingLevelUsed: resolvedThinkingLevel,
            didFallback,
            keyUsed: keyIndexUsed,
            totalKeys,
            debugTrace,
          },
        };
      }

      if (!selectedText.trim()) {
        return {
          status: 400,
          body: { error: 'Vui lòng chọn hoặc nhập đoạn văn cần biên tập.' },
        };
      }

      // MODE 2: 3 Alternative Phrasings (`{"alternatives":["...","...","..."]}`)
      if (action === 'alternatives') {
        const promptText = `Hãy đưa ra đúng 3 phương án diễn đạt tiếng Việt khác nhau (Phương án 1: Giàu chất cổ phong/tiên hiệp; Phương án 2: Tự nhiên, gãy gọn, hiện đại dễ đọc; Phương án 3: Giàu cảm xúc, nhấn mạnh khí thế/nội tâm) cho đoạn văn sau. Chỉ trả về JSON theo đúng Chế độ D: {"alternatives":["Phương án 1","Phương án 2","Phương án 3"]}.

[ĐOẠN VĂN CẦN GỢI Ý]:
${selectedText}

${rawReference ? `[NGUYÊN BẢN TIẾNG TRUNG THAM CHIẾU]:\n${rawReference}\n` : ''}
${surroundingContext ? `[NGỮ CẢNH XUNG QUANH]:\n${surroundingContext}` : ''}`;

        const responseFormatSchema = buildAlternativesResponseFormat(3);

        const {
          result: cleanedAlternatives,
          keyIndexUsed,
          totalKeys,
          modelUsed,
          didFallback,
          attempts,
        } = await geminiKeyPool.executeWithKeyRotation(
          async (ai, slotInfo) => {
            const interaction = await ai.interactions.create(
              {
                model: slotInfo.activeModel,
                store: false,
                system_instruction: systemPrompt,
                input: promptText,
                generation_config: buildInteractionGenerationConfig(
                  thinkingLevel,
                  undefined,
                  slotInfo.activeModel
                ),
                response_format: responseFormatSchema,
              },
              DEFAULT_INTERACTION_REQUEST_OPTIONS
            );

            const contextLabel = `Alternatives[${reqId}:K${slotInfo.keyIndex}]`;
            const parsed = safeParseInteractionJson<{
              alternatives?: string[];
            }>(extractInteractionText(interaction, contextLabel), contextLabel);
            const alts = (parsed.alternatives || [])
              .map((s) => normalizeVietnameseText(String(s || '')).trim())
              .filter(Boolean);
            if (alts.length === 0) {
              throw new Error(
                '[INVALID_STRUCTURED_OUTPUT] Model trả về JSON nhưng mảng "alternatives" đang rỗng.'
              );
            }
            return alts;
          },
          selectedModel,
          cleanFallbackModel,
          {
            reqId,
            endpoint: '/api/editor/assist',
            label: `alternatives (thinking=${resolvedThinkingLevel})`,
            signal: req.signal,
            initialTriedKeys,
            allowWireRenewal,
          }
        );

        resolvedThinkingLevel = resolveThinkingLevelForModel(
          thinkingLevel,
          modelUsed
        );

        const routeDurationMs = Date.now() - routeStartMs;
        return {
          status: 200,
          body: {
            alternatives: cleanedAlternatives,
            modelUsed,
            thinkingLevelUsed: resolvedThinkingLevel,
            didFallback,
            keyUsed: keyIndexUsed,
            totalKeys,
            debugTrace: {
              reqId,
              endpoint: '/api/editor/assist',
              startedAt: new Date(routeStartMs).toISOString(),
              totalDurationMs: routeDurationMs,
              requestedModel: selectedModel,
              fallbackModel: cleanFallbackModel,
              modelUsed,
              thinkingLevelUsed: resolvedThinkingLevel,
              didFallback,
              keyIndexUsed,
              totalPoolKeys: totalKeys,
              attempts,
            } satisfies ServerDebugTrace,
          },
        };
      }

      // MODE 3: Single-Passage Editorial Action (`{"translation":"..."}`)
      let taskInstruction = '';
      if (action === 'polish') {
        taskInstruction =
          'Hãy biên tập, chuốt lại câu chữ tiếng Việt dưới đây cho thật mượt mà, thoát ý, giàu nhạc điệu văn học mà vẫn giữ nguyên 100% ý nghĩa và số đoạn văn.';
      } else if (action === 'fix_pronouns') {
        taskInstruction = `Hãy kiểm tra và đồng bộ lại toàn bộ đại từ xưng hô trong đoạn văn dưới đây theo chuẩn "${
          pronounRule || 'Ta - Ngươi / Huynh - Đệ'
        }" phù hợp ngữ cảnh nhân vật.`;
      } else if (action === 'fix_qa') {
        taskInstruction =
          'Hãy quét và dịch sạch toàn bộ các chữ Hán (ký tự Trung Quốc) còn sót hoặc các từ tiếng Anh bị lọt vô duyên (như "but", "and", "however") trong văn bản dưới đây sang tiếng Việt tự nhiên. Giữ nguyên số dòng/đoạn.';
      } else if (action === 'translate_title') {
        taskInstruction =
          'Hãy dịch tiêu đề chương này sang tiếng Việt thật hay, chuẩn phong cách tiểu thuyết (Định dạng: Chương X: Tên chương).';
      } else {
        taskInstruction =
          customPrompt.trim() ||
          'Hãy biên tập lại đoạn văn dưới đây cho mượt mà hơn.';
      }

      const promptText = `${taskInstruction}
Chỉ trả về JSON hợp lệ theo đúng Chế độ A: {"translation":"Toàn bộ nội dung tiếng Việt sau khi biên tập"}.

[VĂN BẢN CẦN XỬ LÝ]:
${selectedText}

${rawReference ? `[NGUYÊN BẢN TIẾNG TRUNG ĐỐI CHIẾU]:\n${rawReference}\n` : ''}
${surroundingContext ? `[NGỮ CẢNH XUNG QUANH]:\n${surroundingContext}` : ''}`;

      const responseFormatSchema = buildEditedTextResponseFormat();

      const {
        result: resolvedEditedText,
        keyIndexUsed,
        totalKeys,
        modelUsed,
        didFallback,
        attempts,
      } = await geminiKeyPool.executeWithKeyRotation(
        async (ai, slotInfo) => {
          const interaction = await ai.interactions.create(
            {
              model: slotInfo.activeModel,
              store: false,
              system_instruction: systemPrompt,
              input: promptText,
              generation_config: buildInteractionGenerationConfig(
                thinkingLevel,
                undefined,
                slotInfo.activeModel
              ),
              response_format: responseFormatSchema,
            },
            DEFAULT_INTERACTION_REQUEST_OPTIONS
          );

          const contextLabel = `Assist:${action}[${reqId}:K${slotInfo.keyIndex}]`;
          const parsed = safeParseInteractionJson<{
            translation?: string;
            editedText?: string;
            text?: string;
          }>(extractInteractionText(interaction, contextLabel), contextLabel);

          const candidateText =
            typeof parsed.translation === 'string' && parsed.translation.trim()
              ? parsed.translation
              : typeof parsed.editedText === 'string' && parsed.editedText.trim()
                ? parsed.editedText
                : typeof parsed.text === 'string' && parsed.text.trim()
                  ? parsed.text
                  : '';

          if (!candidateText.trim()) {
            throw new Error(
              '[INVALID_STRUCTURED_OUTPUT] Model trả về JSON nhưng trường "translation" đang trống.'
            );
          }

          return normalizeVietnameseText(candidateText);
        },
        selectedModel,
        cleanFallbackModel,
        {
          reqId,
          endpoint: '/api/editor/assist',
          label: `assist:${action} (thinking=${resolvedThinkingLevel})`,
          signal: req.signal,
          initialTriedKeys,
          allowWireRenewal,
        }
      );

      resolvedThinkingLevel = resolveThinkingLevelForModel(
        thinkingLevel,
        modelUsed
      );

      const routeDurationMs = Date.now() - routeStartMs;
      return {
        status: 200,
        body: {
          resultText: resolvedEditedText,
          modelUsed,
          thinkingLevelUsed: resolvedThinkingLevel,
          didFallback,
          keyUsed: keyIndexUsed,
          totalKeys,
          debugTrace: {
            reqId,
            endpoint: '/api/editor/assist',
            startedAt: new Date(routeStartMs).toISOString(),
            totalDurationMs: routeDurationMs,
            requestedModel: selectedModel,
            fallbackModel: cleanFallbackModel,
            modelUsed,
            thinkingLevelUsed: resolvedThinkingLevel,
            didFallback,
            keyIndexUsed,
            totalPoolKeys: totalKeys,
            attempts,
          } satisfies ServerDebugTrace,
        },
      };
    } catch (err) {
      const routeDurationMs = Date.now() - routeStartMs;
      const message =
        err instanceof Error ? err.message : 'Lỗi khi gọi trợ lý biên tập AI.';
      const isPoolExhausted = message.includes('[POOL_EXHAUSTED_429]');
      const errWithTrace = err as Error & {
        attempts?: KeyAttemptTrace[];
        renewWire1?: boolean;
        triedKeyIndices?: number[];
      };

      const debugTrace: ServerDebugTrace = {
        reqId,
        endpoint: '/api/editor/assist',
        startedAt: new Date(routeStartMs).toISOString(),
        totalDurationMs: routeDurationMs,
        requestedModel: selectedModel,
        fallbackModel: cleanFallbackModel,
        thinkingLevelUsed: resolvedThinkingLevel,
        totalPoolKeys: geminiKeyPool.getPoolStatus(selectedModel).totalConfiguredKeys,
        inputSummary: { action: actionForTrace },
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
        'AI_EDITOR',
        `✖ Lỗi tại /api/editor/assist (${actionForTrace}) sau ${(routeDurationMs / 1000).toFixed(2)}s: ${message}`,
        {
          reqId,
          action: actionForTrace,
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


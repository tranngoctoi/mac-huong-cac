import { NextRequest, NextResponse } from 'next/server';
import {
  buildGlossaryExtractResponseFormat,
  buildInteractionGenerationConfig,
  createWire1HeartbeatStream,
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

export async function POST(req: NextRequest) {
  const reqId =
    req.headers.get('x-mhc-request-id') || createRequestId('glossary_scan');
  const initialTriedKeys = parseTriedKeysHeader(
    req.headers.get('x-mhc-tried-keys')
  );
  const routeStartMs = Date.now();
  let selectedModel = 'gemini-flash-latest';
  let cleanFallbackModel: string | undefined;
  let resolvedThinkingLevel = resolveThinkingLevelForModel('high', selectedModel);
  let textToScanLength = 0;
  let existingTermsCount = 0;

  let body: {
    rawContent?: string;
    sampleText?: string;
    model?: string;
    fallbackModel?: string;
    thinkingLevel?: string;
    existingTerms?: string[];
  };

  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: 'Payload yêu cầu quét thuật ngữ không hợp lệ.' },
      { status: 400 }
    );
  }

  const {
    rawContent = '',
    sampleText = '',
    model,
    fallbackModel,
    thinkingLevel,
    existingTerms = [],
  } = body;

  const textToScan = (rawContent || sampleText || '').trim();
  textToScanLength = textToScan.length;
  existingTermsCount = Array.isArray(existingTerms) ? existingTerms.length : 0;
  selectedModel =
    typeof model === 'string' && model.trim()
      ? model.trim()
      : 'gemini-flash-latest';
  resolvedThinkingLevel = resolveThinkingLevelForModel(
    thinkingLevel,
    selectedModel
  );

  if (!textToScan) {
    logger.warn(
      'GLOSSARY_SCAN',
      '✖ Bỏ qua yêu cầu quét Glossary vì văn bản đầu vào trống.',
      { reqId },
      reqId
    );
    return NextResponse.json(
      { error: 'Không có văn bản tiếng Trung để trích xuất thuật ngữ.' },
      { status: 400 }
    );
  }

  return createWire1HeartbeatStream(async () => {
    try {
      cleanFallbackModel =
        typeof fallbackModel === 'string' && fallbackModel.trim()
          ? fallbackModel.trim()
          : undefined;

      const slicedInput = textToScan.slice(0, 45000);

      logger.info(
        'GLOSSARY_SCAN',
        `▶ Bắt đầu quét Glossary trên Server (${slicedInput.length} ký tự Hán, bỏ qua ${existingTermsCount} mục đã có, model=${selectedModel}, thinkingLevel=${resolvedThinkingLevel})`,
        {
          reqId,
          rawTextLength: textToScanLength,
          sentChars: slicedInput.length,
          existingTermsCount,
          selectedModel,
          fallbackModel: cleanFallbackModel,
          thinkingLevel: resolvedThinkingLevel,
          initialTriedKeys,
        },
        reqId
      );

      const existingHint =
        Array.isArray(existingTerms) && existingTerms.length > 0
          ? `\nQUAN TRỌNG — BỎ QUA các thuật ngữ đã có sẵn trong từ điển sau đây (không trích xuất lại): ${existingTerms
              .slice(0, 350)
              .join(', ')}`
          : '';

      const systemPrompt = `Bạn là Chuyên gia Khảo cứu Hán Việt & Thiết lập Từ Điển Tiền Kỳ (Pre-Translation Termbase Builder) cho hệ thống dịch tiểu thuyết Trung - Việt song song đa luồng.
Nhiệm vụ của bạn là đọc văn bản tiếng Trung (có thể gồm 1 hoặc nhiều chương gộp lại) và trích xuất toàn bộ các danh từ riêng, tên nhân vật, địa danh, cảnh giới, công pháp, thế lực, pháp bảo đặc thù của tác phẩm để các luồng dịch song song sử dụng thống nhất 100%.

QUY TẮC TRÍCH XUẤT CHUẨN:
1. Chỉ trích xuất Danh từ riêng / Thuật ngữ đặc thù của bộ truyện (Cấp 3: Tên người, Tên đất, Tông môn, Cảnh giới đặc thù, Công pháp/Chiêu thức, Pháp bảo/Đan dược, Danh hiệu/Chức vị, Mã hệ thống). KHÔNG trích xuất các từ vựng phổ thông hiển nhiên (như sư huynh, linh thạch, đại đạo...).
2. Bản dịch "targetTerm" phải là âm Hán Việt chuẩn xác hoặc cách dịch chuẩn tiểu thuyết Tiên hiệp / Cổ trang / Đô thị (viết hoa chữ cái đầu mỗi âm tiết đối với tên riêng, VD: "Khương Vọng", "Phong Lâm Thành", "Du Mạch Cảnh").
3. Với phân loại "character" (Nhân vật):
   - "aliases": Nếu trong văn bản nhân vật có tên gọi khác, tự, đạo hiệu, biệt danh (VD: "Hàn Lão Ma", "Khương Thanh Dương"), hãy gom vào mảng "aliases" của cùng nhân vật đó để tránh tách thành 2 người.
   - "notes": BẮT BUỘC ghi rõ Giới tính + Vai vế/Thân phận + Cặp đại từ xưng hô chuẩn trong ngữ cảnh (Ví dụ: "Nam chính, đệ tử đạo viện Phong Lâm Thành; xưng Ta - Ngươi với kẻ địch, Đệ - Sư huynh với Tả Quang Liệt").
4. "policy": Chọn chính sách dịch:
   - "force": Bắt buộc dịch cố định (dùng cho Tên nhân vật, Địa danh, Tông môn, Công pháp, Cảnh giới riêng).
   - "contextual": Tùy ngữ cảnh (dùng cho Danh hiệu/Chức vị hoặc Xưng hô thay đổi theo đối tượng).
   - "keep_source": Giữ nguyên gốc (dùng cho Mã hệ thống đặc biệt như [SSS]).`;

      const prompt = `Hãy quét kỹ văn bản tiếng Trung dưới đây và trích xuất danh sách thuật ngữ + biến thể (aliases) + ma trận nhân vật chuẩn xác nhất cho bộ Từ điển tiền kỳ.${existingHint}

[VĂN BẢN TIẾNG TRUNG CẦN QUÉT]:
${slicedInput}`;

      const responseFormatSchema = buildGlossaryExtractResponseFormat(120);

      const {
        result: interaction,
        keyIndexUsed,
        totalKeys,
        modelUsed,
        didFallback,
        attempts,
        totalDurationMs,
      } = await geminiKeyPool.executeWithKeyRotation(
        async (ai, slotInfo) => {
          return await ai.interactions.create({
            model: slotInfo.activeModel,
            store: false,
            system_instruction: systemPrompt,
            input: prompt,
            generation_config: buildInteractionGenerationConfig(
              thinkingLevel,
              undefined,
              slotInfo.activeModel
            ),
            response_format: responseFormatSchema,
          });
        },
        selectedModel,
        cleanFallbackModel,
        {
          reqId,
          endpoint: '/api/glossary/extract',
          label: `GlossaryPreScan (${slicedInput.length} chars • thinking=${resolvedThinkingLevel})`,
          signal: req.signal,
          initialTriedKeys,
        }
      );

      resolvedThinkingLevel = resolveThinkingLevelForModel(
        thinkingLevel,
        modelUsed
      );

      const contextLabel = `GlossaryExtract[${reqId}]`;
      const rawOutputText = extractInteractionText(interaction, contextLabel);
      const parsed = safeParseInteractionJson<{
        terms?: Array<{
          sourceTerm: string;
          targetTerm: string;
          aliases?: string[];
          policy?: 'force' | 'prefer' | 'contextual' | 'keep_source';
          category: string;
          notes: string;
        }>;
      }>(rawOutputText, contextLabel);

      if (!Array.isArray(parsed.terms)) {
        throw new Error(
          '[INVALID_STRUCTURED_OUTPUT] Model trả về JSON nhưng thiếu mảng "terms" hợp lệ.'
        );
      }

      const terms = parsed.terms.filter(
        (t) =>
          t &&
          typeof t.sourceTerm === 'string' &&
          t.sourceTerm.trim().length > 0 &&
          typeof t.targetTerm === 'string' &&
          t.targetTerm.trim().length > 0
      );
      const routeDurationMs = Date.now() - routeStartMs;

      const debugTrace: ServerDebugTrace = {
        reqId,
        endpoint: '/api/glossary/extract',
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
          rawTextLength: textToScanLength,
          sentChars: slicedInput.length,
          existingTermsCount,
          thinkingLevel: resolvedThinkingLevel,
        },
        outputSummary: {
          extractedTermsCount: terms.length,
          rawOutputChars: rawOutputText.length,
        },
        attempts,
      };

      logger.info(
        'GLOSSARY_SCAN',
        `✔ Trích xuất thành công ${terms.length} thuật ngữ qua ${modelUsed} (thinking=${resolvedThinkingLevel}, Key #${keyIndexUsed}/${totalKeys}) trong ${(routeDurationMs / 1000).toFixed(2)}s`,
        {
          reqId,
          extractedCount: terms.length,
          modelUsed,
          thinkingLevelUsed: resolvedThinkingLevel,
          keyIndexUsed,
          totalDurationMs,
        },
        reqId,
        routeDurationMs
      );

      return {
        status: 200,
        body: {
          terms,
          entries: terms,
          modelUsed,
          thinkingLevelUsed: resolvedThinkingLevel,
          didFallback,
          keyUsed: keyIndexUsed,
          totalKeys,
          debugTrace,
        },
      };
    } catch (err) {
      const routeDurationMs = Date.now() - routeStartMs;
      const message =
        err instanceof Error ? err.message : 'Lỗi khi trích xuất Glossary tự động.';
      const isPoolExhausted = message.includes('[POOL_EXHAUSTED_429]');
      const errWithTrace = err as Error & {
        attempts?: KeyAttemptTrace[];
        renewWire1?: boolean;
        triedKeyIndices?: number[];
      };

      const debugTrace: ServerDebugTrace = {
        reqId,
        endpoint: '/api/glossary/extract',
        startedAt: new Date(routeStartMs).toISOString(),
        totalDurationMs: routeDurationMs,
        requestedModel: selectedModel,
        fallbackModel: cleanFallbackModel,
        thinkingLevelUsed: resolvedThinkingLevel,
        totalPoolKeys: geminiKeyPool.getPoolStatus(selectedModel).totalConfiguredKeys,
        inputSummary: {
          rawTextLength: textToScanLength,
          existingTermsCount,
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
        'GLOSSARY_SCAN',
        `✖ Lỗi tại /api/glossary/extract sau ${(routeDurationMs / 1000).toFixed(2)}s: ${message}`,
        {
          reqId,
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



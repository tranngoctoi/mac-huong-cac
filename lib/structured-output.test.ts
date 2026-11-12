import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAlternativesResponseFormat,
  buildBlocksResponseFormat,
  buildBlockUpdatesResponseFormat,
  buildEditedTextResponseFormat,
  buildGlossaryExtractResponseFormat,
  buildInteractionGenerationConfig,
  DEFAULT_INTERACTION_REQUEST_OPTIONS,
  extractBlocksArrayFromParsedJson,
  extractInteractionText,
  resolveThinkingLevelForModel,
  safeParseInteractionJson,
} from './gemini-server';
import {
  buildChapterBlockPairs,
  materializeBlocksToChapter,
  normalizeReturnedBlockId,
  splitRawIntoBlocks,
} from './block-engine';

test('DEFAULT_INTERACTION_REQUEST_OPTIONS disables internal SDK retries so 50-key pool rotates immediately', () => {
  assert.equal(DEFAULT_INTERACTION_REQUEST_OPTIONS.maxRetries, 0);
  assert.equal(DEFAULT_INTERACTION_REQUEST_OPTIONS.timeout, 240_000);
});

test('resolveThinkingLevelForModel upgrades minimal to low on non-lite models to prevent 400 error', () => {
  assert.equal(resolveThinkingLevelForModel('minimal', 'gemini-3.8-flash'), 'low');
  assert.equal(resolveThinkingLevelForModel('minimal', 'gemini-flash-latest'), 'low');
  assert.equal(resolveThinkingLevelForModel('minimal', 'gemini-4-argon'), 'low');
  assert.equal(resolveThinkingLevelForModel('minimal', 'gemini-3.1-flash-lite'), 'minimal');
  assert.equal(resolveThinkingLevelForModel('minimal', 'gemini-flash-lite-latest'), 'minimal');
  assert.equal(resolveThinkingLevelForModel('high', 'gemini-3.8-flash'), 'high');
});

test('buildInteractionGenerationConfig strips deprecated sampling parameters and sets max_output_tokens', () => {
  const cfg = buildInteractionGenerationConfig(
    'minimal',
    { temperature: 0.3, top_p: 0.9, topK: 40, seed: 42 },
    'gemini-flash-latest'
  );
  assert.equal(cfg.thinking_level, 'low');
  assert.equal(cfg.max_output_tokens, 65536);
  assert.equal(cfg.seed, 42);
  assert.equal('temperature' in cfg, false);
  assert.equal('top_p' in cfg, false);
  assert.equal('topK' in cfg, false);
});

test('buildBlocksResponseFormat enforces enum, minItems, and maxItems for <= 64 blocks and omits for > 64 blocks', () => {
  const smallIds = ['TITLE', 'P0001', 'P0002'];
  const smallSchema = buildBlocksResponseFormat(smallIds) as {
    type: string;
    required: string[];
    additionalProperties: boolean;
    properties: {
      blocks: {
        type: string;
        minItems?: number;
        maxItems?: number;
        items: {
          properties: {
            id: { enum?: string[] };
          };
        };
      };
    };
  };

  assert.equal(smallSchema.type, 'object');
  assert.deepEqual(smallSchema.required, ['blocks']);
  assert.equal(smallSchema.additionalProperties, false);
  assert.equal(smallSchema.properties.blocks.minItems, 3);
  assert.equal(smallSchema.properties.blocks.maxItems, 3);
  assert.deepEqual(smallSchema.properties.blocks.items.properties.id.enum, smallIds);

  const largeIds = ['TITLE', ...Array.from({ length: 70 }, (_, i) => `P${String(i + 1).padStart(4, '0')}`)];
  const largeSchema = buildBlocksResponseFormat(largeIds) as typeof smallSchema;
  assert.equal(largeSchema.properties.blocks.minItems, undefined);
  assert.equal(largeSchema.properties.blocks.maxItems, undefined);
  assert.equal(largeSchema.properties.blocks.items.properties.id.enum, undefined);
});

test('buildBlockUpdatesResponseFormat, buildAlternativesResponseFormat, buildEditedTextResponseFormat, and buildGlossaryExtractResponseFormat match official schema rules', () => {
  const updatesSchema = buildBlockUpdatesResponseFormat(['P0001', 'P0005']) as {
    properties: { updates: { minItems?: number; maxItems?: number } };
  };
  assert.equal(updatesSchema.properties.updates.minItems, 2);
  assert.equal(updatesSchema.properties.updates.maxItems, 2);

  const altSchema = buildAlternativesResponseFormat(3) as {
    properties: { alternatives: { minItems?: number; maxItems?: number } };
  };
  assert.equal(altSchema.properties.alternatives.minItems, 3);
  assert.equal(altSchema.properties.alternatives.maxItems, 3);

  const editedSchema = buildEditedTextResponseFormat() as {
    required: string[];
    additionalProperties: boolean;
    properties: Record<string, unknown>;
  };
  assert.deepEqual(editedSchema.required, ['translation']);
  assert.equal('translation' in editedSchema.properties, true);
  assert.equal(editedSchema.additionalProperties, false);

  const glossarySchema = buildGlossaryExtractResponseFormat(120) as {
    properties: { terms: { maxItems?: number } };
  };
  assert.equal(glossarySchema.properties.terms.maxItems, 120);
});

test('Presets v1.14.1 and v1.14.0 in DEFAULT_INSTRUCTION_PROFILES match all Structured Output schemas', async () => {
  const { DEFAULT_INSTRUCTION_PROFILES, DEFAULT_INSTRUCTION_ID, DEFAULT_EDITORIAL_INSTRUCTION_ID } = await import('./seed-data');
  const trans1141 = DEFAULT_INSTRUCTION_PROFILES.find((p) => p.id === DEFAULT_INSTRUCTION_ID);
  const trans1140 = DEFAULT_INSTRUCTION_PROFILES.find((p) => p.id === 'inst-dich-flash-full-1140');
  const edit1141 = DEFAULT_INSTRUCTION_PROFILES.find((p) => p.id === DEFAULT_EDITORIAL_INSTRUCTION_ID);
  const edit1140 = DEFAULT_INSTRUCTION_PROFILES.find((p) => p.id === 'inst-bientap-flash-full-1140');

  assert.ok(trans1141, 'Translation 1.14.1 preset must exist');
  assert.ok(trans1140, 'Translation 1.14.0 preset must exist');
  assert.ok(edit1141, 'Editorial 1.14.1 preset must exist');
  assert.ok(edit1140, 'Editorial 1.14.0 preset must exist');

  // Translation presets must specify {"blocks":[{"id":"TITLE" and single-paragraph per block ID
  for (const p of [trans1141, trans1140]) {
    assert.match(p.systemInstruction, /\{"blocks":\[\{"id":"TITLE"/);
    assert.match(p.systemInstruction, /không chứa ký tự xuống dòng/);
  }

  // Editorial presets must specify all 4 structured output modes: translation, updates, blocks, alternatives
  for (const p of [edit1141, edit1140]) {
    assert.match(p.systemInstruction, /\{"translation":/);
    assert.match(p.systemInstruction, /\{"updates":\[\{"id":/);
    assert.match(p.systemInstruction, /\{"blocks":\[\{"id":"TITLE"/);
    assert.match(p.systemInstruction, /\{"alternatives":\[/);
  }
});

test('extractInteractionText extracts from steps, outputs (when steps is []), and candidates, while ignoring thought steps', () => {
  const validInteraction = {
    status: 'completed',
    steps: [
      {
        type: 'thought',
        content: [{ type: 'text', text: '{"blocks": "DO_NOT_INCLUDE_THOUGHT"}' }],
      },
      {
        type: 'model_output',
        content: [{ type: 'text', text: '{"blocks":[{"id":"TITLE",' }],
      },
      {
        type: 'model_output',
        content: [{ type: 'text', text: '"translation":"Chương 1: Khởi đầu"}]}' }],
      },
    ],
  };

  const text = extractInteractionText(validInteraction, 'TestValid');
  assert.equal(text, '{"blocks":[{"id":"TITLE","translation":"Chương 1: Khởi đầu"}]}');

  // Simulate @google/genai@2.31.0 normalizeInteractionShape where steps is [] and outputs has the model text
  const outputsInteraction = {
    status: 'completed',
    steps: [],
    outputs: [
      { type: 'thought', text: 'Thinking internal text' },
      {
        type: 'text',
        text: '{"blocks":[{"id":"TITLE","translation":"Chương 2800: Đầu Hổ"},{"id":"P0001","translation":"Năm mới phát tài!"}]}',
      },
    ],
  };
  const outputsText = extractInteractionText(outputsInteraction, 'TestOutputs');
  assert.equal(
    outputsText,
    '{"blocks":[{"id":"TITLE","translation":"Chương 2800: Đầu Hổ"},{"id":"P0001","translation":"Năm mới phát tài!"}]}'
  );

  assert.throws(
    () =>
      extractInteractionText(
        {
          status: 'failed',
          errors: [{ code: 'SAFETY', message: 'Blocked by safety filter' }],
        },
        'TestFailed'
      ),
    /\[INTERACTION_ERROR\]/
  );
});

test('safeParseInteractionJson parses valid JSON and detects truncated JSON output', () => {
  const parsed = safeParseInteractionJson<{ blocks: { id: string; translation: string }[] }>(
    '{"blocks":[{"id":"TITLE","translation":"Chương 1"}]}'
  );
  assert.equal(parsed.blocks.length, 1);

  assert.throws(
    () =>
      safeParseInteractionJson(
        '{"blocks":[{"id":"TITLE","translation":"Chương 1"},{"id":"P0001","transla',
        'TestTruncated'
      ),
    /\[TRUNCATED_JSON_OUTPUT\]/
  );
});

test('normalizeReturnedBlockId and extractBlocksArrayFromParsedJson handle non-canonical IDs and wrapper shapes', () => {
  assert.equal(normalizeReturnedBlockId('title'), 'TITLE');
  assert.equal(normalizeReturnedBlockId('[TITLE]'), 'TITLE');
  assert.equal(normalizeReturnedBlockId('p1'), 'P0001');
  assert.equal(normalizeReturnedBlockId('[P0012]'), 'P0012');
  assert.equal(normalizeReturnedBlockId('#P0105'), 'P0105');
  assert.equal(normalizeReturnedBlockId('25'), 'P0025');

  const arrFromUpdates = extractBlocksArrayFromParsedJson({
    updates: [{ id: 'P1', translation: 'Đoạn 1' }],
  });
  assert.equal(arrFromUpdates?.length, 1);

  const arrFromTopLevel = extractBlocksArrayFromParsedJson([
    { id: 'TITLE', translation: 'Tiêu đề' },
  ]);
  assert.equal(arrFromTopLevel?.length, 1);
});

test('materializeBlocksToChapter preserves 1:1 block slot positions and supports normalized IDs and positional fallback', () => {
  const rawBlocks = splitRawIntoBlocks(
    '第1章 归来',
    '第一段内容。\n\n第二段内容。\n\n第三段内容。'
  );
  assert.deepEqual(
    rawBlocks.map((b) => b.id),
    ['TITLE', 'P0001', 'P0002', 'P0003']
  );

  // Simulate model returning P0003 before P0001, missing P0002, and adding an unexpected P9999
  const materialized = materializeBlocksToChapter(
    [
      { id: 'p3', translation: 'Nội dung đoạn ba.' },
      { id: '[TITLE]', translation: 'Chương 1: Trở về' },
      { id: 'P1', translation: 'Nội dung đoạn một.' },
      { id: 'P9999', translation: 'Đoạn lạ không tồn tại.' },
    ],
    rawBlocks,
    1
  );

  assert.equal(materialized.titleTranslated, 'Chương 1: Trở về');
  assert.deepEqual(materialized.missingIds, ['P0002']);
  assert.deepEqual(materialized.unexpectedIds, ['P9999']);
  assert.equal(materialized.alignment.isAligned, false);
  assert.equal(materialized.alignment.rawBlockCount, 3);
  assert.equal(materialized.alignment.translatedBlockCount, 2);

  // Verify that in the Bilingual Block-ID Editor, P0003 is still aligned with P0003 (not shifted into P0002!)
  const paired = buildChapterBlockPairs({
    titleRaw: '第1章 归来',
    rawContent: '第一段内容。\n\n第二段内容。\n\n第三段内容。',
    titleTranslated: materialized.titleTranslated,
    translatedContent: materialized.translatedContent,
  });

  const p1 = paired.pairs.find((p) => p.id === 'P0001');
  const p2 = paired.pairs.find((p) => p.id === 'P0002');
  const p3 = paired.pairs.find((p) => p.id === 'P0003');

  assert.equal(p1?.translation, 'Nội dung đoạn một.');
  assert.equal(p2?.translation, '');
  assert.equal(p2?.isMissingTranslation, true);
  assert.equal(p3?.translation, 'Nội dung đoạn ba.');
});

test('scanChapterQA detects residual Chinese, leaked English tokens, and glossary violations accurately', async () => {
  const { scanChapterQA, DEFAULT_QA_VALIDATION_RULES } = await import('./qa-scanner');
  const report = scanChapterQA(
    {
      titleRaw: '第1章 宗门测试',
      rawContent: '韩立走进大殿，看着眼前的掌门。\n\n掌门看着韩立，他心中十分平静。',
      titleTranslated: 'Chương 1: Khảo thí tông môn',
      translatedContent:
        'Hàn Lập bước vào đại điện, suddenly nhìn thấy掌门 trước mặt.\n\nTrong lòng hắn vô cùng bình tĩnh.',
      status: 'translated',
      chapterNumber: 1,
    },
    [],
    DEFAULT_QA_VALIDATION_RULES,
    [
      {
        id: 'g-1',
        novelId: 'n-1',
        sourceTerm: '韩立',
        targetTerm: 'Hàn Lập',
        category: 'character',
        policy: 'force',
      },
      {
        id: 'g-2',
        novelId: 'n-1',
        sourceTerm: '掌门',
        targetTerm: 'Chưởng môn',
        category: 'organization',
        policy: 'force',
      },
    ]
  );

  assert.equal(report.hasIssues, true);
  assert.ok(report.residualChineseCount >= 2, 'Must detect residual Chinese characters 掌门');
  assert.ok(report.leakedEnglishCount >= 1, 'Must detect leaked English word suddenly');
  assert.ok(report.glossaryViolationCount >= 1, 'Must detect missing glossary translation Chưởng môn');
});

test('createWire1HeartbeatStream streams initial whitespace and JSON payload or renewWire1 envelope', async () => {
  const { createWire1HeartbeatStream } = await import('./gemini-server');
  const response = createWire1HeartbeatStream(async () => ({
    body: {
      blocks: [{ id: 'TITLE', translation: 'Chương 1' }],
    },
    status: 200,
  }));

  const rawText = await response.text();
  assert.ok(rawText.startsWith(' \n'), 'Must flush initial whitespace heartbeat');
  const parsed = JSON.parse(rawText.trim());
  assert.equal(parsed.blocks[0].id, 'TITLE');
  assert.equal(parsed.blocks[0].translation, 'Chương 1');
});




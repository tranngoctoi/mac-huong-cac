import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAlternativesResponseFormat,
  buildBlocksResponseFormat,
  buildBlockUpdatesResponseFormat,
  buildEditedTextResponseFormat,
  buildGlossaryExtractResponseFormat,
  buildInteractionGenerationConfig,
  extractInteractionText,
  resolveThinkingLevelForModel,
  safeParseInteractionJson,
} from './gemini-server';
import {
  buildChapterBlockPairs,
  materializeBlocksToChapter,
  splitRawIntoBlocks,
} from './block-engine';

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

test('extractInteractionText ignores thought steps, combines model_output steps, and validates failed status', () => {
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

test('materializeBlocksToChapter preserves 1:1 block slot positions when a middle block is missing or out of order', () => {
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
      { id: 'P0003', translation: 'Nội dung đoạn ba.' },
      { id: 'TITLE', translation: 'Chương 1: Trở về' },
      { id: 'P0001', translation: 'Nội dung đoạn một.' },
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

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  containsRequestedSchema,
  extractRequestedSchema,
  normalizeSchema,
  schemaFields,
  isMultiFieldSchema,
  validateStructuredAnswer,
  summarizeStructuredAnswer,
  flatAnswerToStructured,
} from './question-schema.mjs';

const multiSchema = {
  type: 'object',
  properties: {
    meaning: {
      type: 'string',
      title: 'ORMM meaning',
      description: 'Pick the intended meaning.',
      oneOf: [
        { const: 'agent', title: 'An agent runtime' },
        { const: 'cli', title: 'A CLI tool' },
      ],
    },
    format: { type: 'string', title: 'Format', enum: ['markdown', 'json'] },
    enable: { type: 'boolean', title: 'Enable caching', default: true },
    retries: { type: 'integer', title: 'Retries' },
  },
  required: ['meaning', 'format'],
};

const singleSchema = {
  type: 'object',
  properties: { answer: { type: 'string', title: 'Choose one', enum: ['Mars', 'Venus'] } },
  required: ['answer'],
};

test('schemaFields parses types, choices, required, defaults', () => {
  const fields = schemaFields(multiSchema);
  assert.equal(fields.length, 4);
  const byName = Object.fromEntries(fields.map((f) => [f.name, f]));
  assert.equal(byName.meaning.choices.length, 2);
  assert.equal(byName.meaning.choices[0].value, 'agent');
  assert.equal(byName.meaning.choices[0].label, 'An agent runtime');
  assert.equal(byName.meaning.required, true);
  assert.equal(byName.enable.type, 'boolean');
  assert.equal(byName.enable.hasDefault, true);
  assert.equal(byName.enable.default, true);
  assert.equal(byName.retries.type, 'integer');
});

test('isMultiFieldSchema distinguishes single vs multi', () => {
  assert.equal(isMultiFieldSchema(multiSchema), true);
  assert.equal(isMultiFieldSchema(singleSchema), false);
});

test('validateStructuredAnswer accepts valid answers and applies defaults', () => {
  const result = validateStructuredAnswer(multiSchema, { meaning: 'agent', format: 'json' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, { meaning: 'agent', format: 'json', enable: true });
});

test('validateStructuredAnswer reports missing required fields', () => {
  const result = validateStructuredAnswer(multiSchema, { meaning: 'agent' });
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].field, 'format');
});

test('validateStructuredAnswer rejects values outside enum/oneOf', () => {
  const result = validateStructuredAnswer(multiSchema, { meaning: 'nope', format: 'yaml' });
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 2);
});

test('validateStructuredAnswer coerces booleans and integers', () => {
  const result = validateStructuredAnswer(multiSchema, { meaning: 'cli', format: 'markdown', enable: 'false', retries: '3' });
  assert.equal(result.ok, true);
  assert.equal(result.value.enable, false);
  assert.equal(result.value.retries, 3);
});

test('summarizeStructuredAnswer renders labelled summary', () => {
  const summary = summarizeStructuredAnswer(multiSchema, { meaning: 'agent', format: 'json', enable: true });
  assert.match(summary, /ORMM meaning: agent/);
  assert.match(summary, /Format: json/);
});

test('flatAnswerToStructured maps a single-field schema', () => {
  assert.deepEqual(flatAnswerToStructured(singleSchema, 'Mars'), { answer: 'Mars' });
  assert.equal(flatAnswerToStructured(multiSchema, 'Mars'), null);
});

test('flatAnswerToStructured rejects values not in the single field enum', () => {
  assert.equal(flatAnswerToStructured(singleSchema, 'Pluto'), null);
});

test('extractRequestedSchema finds schema nested in toolArgs JSON string', () => {
  const request = { toolName: 'ask_user', toolArgs: JSON.stringify({ message: 'm', requestedSchema: singleSchema }) };
  const schema = extractRequestedSchema(request);
  assert.ok(schema);
  assert.deepEqual(schema.required, ['answer']);
});

test('containsRequestedSchema detects malformed nested schemas', () => {
  const request = {
    toolName: 'ask_user',
    toolArgs: JSON.stringify({
      message: 'm',
      requestedSchema: { answer: { type: 'string' } },
    }),
  };
  assert.equal(containsRequestedSchema(request), true);
  assert.equal(extractRequestedSchema(request), null);
});

test('normalizeSchema returns null for non-object schemas', () => {
  assert.equal(normalizeSchema(null), null);
  assert.equal(normalizeSchema({ type: 'object' }), null);
});

test('array fields support multi-select choices', () => {
  const schema = {
    type: 'object',
    properties: {
      platforms: { type: 'array', title: 'Platforms', items: { enum: ['linux', 'mac', 'win'] } },
    },
    required: ['platforms'],
  };
  const [field] = schemaFields(schema);
  assert.equal(field.isMultiSelect, true);
  assert.equal(field.choices.length, 3);
  const ok = validateStructuredAnswer(schema, { platforms: ['linux', 'mac'] });
  assert.equal(ok.ok, true);
  const bad = validateStructuredAnswer(schema, { platforms: ['linux', 'bsd'] });
  assert.equal(bad.ok, false);
});

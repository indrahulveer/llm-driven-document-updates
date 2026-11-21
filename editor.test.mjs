import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createProposer, updateDocument } from './editor.mjs';

const input = JSON.parse(readFileSync(new URL('./sample.json', import.meta.url), 'utf8'));
const cli = fileURLToPath(new URL('./cli.mjs', import.meta.url));
const pricingEdit = { startLine: 4, endLine: 5, replacement: 'Basic: $22/month\nPro: $55/month\n' };
const targetedResult = input.sourceDocument.replace('$20', '$22').replace('$50', '$55');
const plan = (...edits) => JSON.stringify({ outcome: 'edited', edits });

function mockApi(...answers) {
  const requests = [];
  const propose = createProposer({
    apiKey: 'test-placeholder',
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://api.openai.com/v1/responses');
      const request = JSON.parse(options.body);
      const answer = answers[requests.length];
      requests.push(request);
      return Response.json({
        status: 'completed',
        output: [{ type: 'message', content: [{ type: 'output_text', text: answer }] }],
      });
    },
  });
  const waits = [];
  const run = (documentInput = input) => updateDocument(documentInput, propose, {
    wait: async (milliseconds) => { waits.push(milliseconds); },
  });
  return { requests, waits, run };
}

test('targeted pricing edit preserves unrelated text', async () => {
  const api = mockApi(plan(pricingEdit));
  assert.equal(await api.run(), targetedResult);
  assert.equal(api.requests.length, 1);
  const request = api.requests[0];
  assert.equal(request.model, 'gpt-4.1-mini');
  assert.equal(request.text.format.strict, true);
  assert.equal(request.store, false);
  const sent = JSON.parse(request.input[0].content);
  assert.deepEqual(sent.changes, input.changes);
  assert.deepEqual(sent.lines[3], { number: 4, text: 'Basic: $20/month\n' });
  assert.equal(sent.lines.map(({ text }) => text).join(''), input.sourceDocument);
});

test('malformed response retries from the same source with validation feedback', async () => {
  const api = mockApi('{bad', plan(pricingEdit));
  assert.equal(await api.run(), targetedResult);
  assert.equal(api.requests.length, 2);
  assert.deepEqual(api.requests[0].input, api.requests[1].input);
  assert.match(api.requests[1].instructions, /not valid JSON/);
  assert.deepEqual(api.waits, [500]);
});

test('invalid plans exhaust retries without returning a partial document', async () => {
  const overlapping = plan(pricingEdit, { startLine: 5, endLine: 5, replacement: 'conflict\n' });
  const outOfBounds = plan(pricingEdit, { startLine: 99, endLine: 99, replacement: 'outside' });
  const api = mockApi(overlapping, outOfBounds, overlapping);
  await assert.rejects(api.run(), /failed after 3 attempts.*must not overlap/);
  assert.equal(api.requests.length, 3);
  assert.match(api.requests[1].instructions, /must not overlap/);
  assert.match(api.requests[2].instructions, /valid original line range/);
  assert.deepEqual(api.waits, [500, 1000]);
});

test('a broad patch handles 10,000 words and preserves CRLF and final newline state', async () => {
  const sourceDocument = ('hey folks we got some new stuff for you here\r\n').repeat(999)
    + 'hey folks we got some new stuff for you here';
  const replacement = sourceDocument.replaceAll(
    'hey folks we got some new stuff for you here',
    'We have prepared several new materials for your review.',
  );
  const api = mockApi(plan({ startLine: 1, endLine: 1000, replacement }));
  assert.equal(await api.run({ sourceDocument, changes: ['Make the tone more formal.'] }), replacement);
});

test('README example accepts a structurally valid price decrease', async () => {
  const sourceDocument = 'Basic: $20/month\nSupport: email\n';
  const changes = ['Increase the Basic price by 10%.'];
  const modelResponse = '{"outcome":"edited","edits":[{"startLine":1,"endLine":1,"replacement":"Basic: $18/month\\n"}]}';
  const expected = 'Basic: $22/month\nSupport: email\n';
  const actual = await mockApi(modelResponse).run({ sourceDocument, changes });
  assert.equal(actual, 'Basic: $18/month\nSupport: email\n');
  assert.notEqual(actual, expected);
});

test('CLI writes exact stdout for a no-op and keeps stdout empty on failure', () => {
  const env = { ...process.env, OPENAI_API_KEY: '' };
  const sourceDocument = 'Text with CRLF\r\nNo final newline';
  const result = execFileSync(process.execPath, [cli, '-'], {
    env,
    input: JSON.stringify({ sourceDocument, changes: [] }),
    encoding: 'utf8',
  });
  assert.equal(result, sourceDocument);

  const failure = spawnSync(process.execPath, [cli, '-'], {
    env,
    input: JSON.stringify(input),
    encoding: 'utf8',
  });
  assert.equal(failure.status, 1);
  assert.equal(failure.stdout, '');
  assert.match(failure.stderr, /Set OPENAI_API_KEY/);
});

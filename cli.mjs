import { readFileSync } from 'node:fs';
import { createProposer, UpdateError, updateDocument } from './editor.mjs';

async function main(args) {
  if (args.length !== 1) {
    throw new UpdateError('Usage: node cli.mjs <input.json|->');
  }

  let text;
  try {
    text = readFileSync(args[0] === '-' ? 0 : args[0], 'utf8');
  } catch {
    throw new UpdateError('Could not read input.');
  }

  let input;
  try {
    input = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    throw new UpdateError('Input is not valid JSON.');
  }

  const propose = createProposer({
    apiKey: process.env.OPENAI_API_KEY,
    model: process.env.OPENAI_MODEL || undefined,
  });
  const document = await updateDocument(input, propose);
  process.stdout.write(document);
}

main(process.argv.slice(2)).catch((error) => {
  const message = error instanceof UpdateError ? error.message : 'Unexpected update failure.';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});

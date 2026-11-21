# LLM-Driven Document Updates

A dependency-free Node.js CLI that uses the OpenAI Responses API to propose edits and applies a validated patch locally.

## Setup and usage

Install Node.js 22 or later and open a terminal in this project directory. Set `OPENAI_API_KEY` in that terminal's environment. The CLI defaults to `gpt-4.1-mini`. Set `OPENAI_MODEL` if you have another Responses API model that supports Structured Outputs and has enough output capacity for your documents. See the [OpenAI quickstart](https://developers.openai.com/api/docs/quickstart) and [model documentation](https://developers.openai.com/api/docs/models/gpt-4.1-mini).

Run the example and the keyless tests from PowerShell or a Unix shell.

```sh
node cli.mjs sample.json
node --test
```

Pass `-` instead of a filename to read UTF-8 JSON from stdin. The input contains the full document as `sourceDocument` and an array of non-blank natural-language strings in `changes`. An empty array returns the source as-is without an API request.

On success, the CLI writes the complete updated document as UTF-8 text to stdout, adds no newline of its own, and exits with code 0. The sample's requested increase gives the following expected output.

```text
Service guide

Pricing
Basic: $22/month
Pro: $55/month

Support
Email support is included with both plans.
```

A failed update exits with code 1, writes a short diagnostic to stderr, and leaves stdout empty. A batch runner can invoke the CLI once per document and record each exit code. The CLI writes neither the input nor raw provider responses to diagnostic output.

## Architecture

A full-document rewrite would send the source and instructions and have the model emit the entire updated document. This directly supports broad changes and gives the model freedom to reorganize the document. Both input and output usually grow linearly with document size. Generation can be slow on long documents, and structural response checks give weak guarantees about preserving text during targeted changes.

The implemented approach sends the whole document as numbered lines with their original line endings. The model returns inclusive original line ranges and replacement text using [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs). The program checks the JSON shape, outcome and edit count, ranges, overlaps, replacement strings, and whether each proposed replacement changes its range. It then assembles the result from the original text and the replacements. All edits refer to the same original line numbers, so one insertion or deletion cannot shift the coordinates of another edit. Text outside the chosen ranges is copied verbatim. Within a selected line, preservation depends on the model. I chose this approach for deterministic preservation outside selected ranges and lower generation costs for sparse changes.

For targeted requests the model is prompted to choose the smallest line ranges. A long, unbroken line increases the replacement size even for a small edit. For global changes the model can replace several broad spans or the entire line range in one plan, with the full document available for context. It can still miss a passage or change a fact during a rewrite.

Input tokens grow linearly with the source plus line numbering and instructions. Output tokens grow with replacement text and the number of edit records. A targeted edit can keep output nearly constant as the document grows elsewhere, which typically reduces generation latency relative to a full rewrite. A global rewrite can require comparable output and latency, with additional JSON overhead. The default output cap is 32,768 tokens, so a rewrite beyond that budget may fail. Every retry sends the full source again and adds another request's latency and token usage. The offline 10,000-word test exercises assembly using a simulated model response.

Malformed, refused, incomplete, or invalid plans, transient request failures, and a model-reported inability to fulfill the instructions get up to three total attempts. Each retry starts from the original source and receives a short diagnostic, with 0.5 and then 1 second of backoff. Each request has a five-minute timeout. Invalid input, missing credentials, and permanent HTTP errors fail immediately. The CLI only writes after a complete plan passes validation.

## Verified semantic failure

### Source document

```text
Basic: $20/month
Support: email
```

### Requested change

Increase the Basic price by 10%.

### Model response

```json
{"outcome":"edited","edits":[{"startLine":1,"endLine":1,"replacement":"Basic: $18/month\n"}]}
```

### Expected result

```text
Basic: $22/month
Support: email
```

### Actual result

```text
Basic: $18/month
Support: email
```

All document strings in this example have a trailing LF. The test named `README example accepts a structurally valid price decrease` feeds that response through the actual Responses API decoder, patch validator, and application path, using a simulated HTTP response. The patch changes a valid range and leaves the support line intact. The checks cannot decide whether the replacement satisfies the user's arithmetic, covers every instruction, or preserves unrelated meaning within an edited range. The model's outcome field is self-reported.

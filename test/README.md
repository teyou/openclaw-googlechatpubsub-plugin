# Tests — outbound media upload

## How this works, and why

The functions under test — `guessMimeType`, `resolveOutboundMedia`, `uploadAttachment` and `sendMediaMessages` — are module-internal to `index.ts` and are deliberately not exported: nothing outside the plugin should call them. Rather than widen the public surface purely for testing, `test/helpers/harness.mjs` reads the **built** bundle (`dist/index.js`), applies three surgical string rewrites, writes the result to `.test-tmp/bundle-under-test.mjs`, and imports that. The rewrites are: strip the `openclaw/*` SDK imports (the SDK isn't resolvable in a bare test process), replace the hardcoded `https://chat.googleapis.com` host with a `${globalThis.__GCHAT_BASE__}` interpolation so each test file can point the code at its own local `node:http` mock, and stub the `logger` global that plugin registration would normally assign. A trailing `export { ... }` line then exposes the internals. The harness rebuilds `dist/index.js` automatically when `index.ts` is newer, so tests always measure current source, and it asserts after every rewrite that the edit actually landed — including an explicit check that `node:fs` / `node:path` / `node:crypto` imports survived, because an earlier over-greedy multiline import regex ate them and produced a confusing `extname is not defined`.

## Running

```bash
npm test              # all tests
npm run test:coverage # + Node's built-in whole-file coverage report
node test/tools/coverage-report.mjs   # per-function coverage of the code under test
```

`node --test <dir>` is broken on Node v22.23.2 (it resolves the directory as a module and fails with `MODULE_NOT_FOUND`), so the scripts use the glob form `'test/**/*.test.mjs'`. Keep the quotes — the glob must reach Node, not the shell.

Node's own coverage reporter only prints whole-file percentages, and the upload code is ~195 lines of a ~1450-line bundle, so `npm run test:coverage` understates it badly (~17%, dominated by untested Pub/Sub and inbound code). `test/tools/coverage-report.mjs` re-slices the same lcov data by function line range and is the number to look at.

## Conventions

- **Mocks listen on port 0.** `node --test` runs files in parallel processes; a fixed port would make the suite order-dependent. Each mock records the raw request `Buffer`.
- **Never round-trip a body through a string.** `parseMultipart` scans for boundaries on the `Buffer` directly. Decoding to UTF-8 silently corrupts binary payloads, which would hide exactly the class of bug the binary-integrity assertions exist to catch. Assert with `Buffer.compare(...) === 0`.
- **No real network.** Everything hits localhost; nothing reaches `googleapis.com`.
- Files matching `*.test.mjs` are collected; helpers live in `helpers/` and tooling in `tools/` so they aren't picked up as tests.

The suite also verifies that a caption falls back to a plain-text message when
the file upload succeeds but the attachment message itself fails.

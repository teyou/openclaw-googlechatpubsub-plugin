/**
 * Test harness for the outbound media upload code in index.ts.
 *
 * The functions under test (guessMimeType, resolveOutboundMedia,
 * uploadAttachment, sendMediaMessages) are module-internal and never exported
 * from the plugin. Rather than change index.ts just to make it testable, we
 * take the *built* bundle (dist/index.js), rewrite it into a temporary ESM
 * module that re-exports those symbols, and import that. See test/README.md.
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync, statSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PLUGIN_DIR = path.resolve(HERE, "..", "..");
const SRC_TS = path.join(PLUGIN_DIR, "index.ts");
const BUNDLE = path.join(PLUGIN_DIR, "dist", "index.js");

/** Deterministic path so every test file's coverage lands on ONE file. */
const TMP_DIR = path.join(PLUGIN_DIR, ".test-tmp");
export const MODULE_PATH = path.join(TMP_DIR, "bundle-under-test.mjs");

/** Sentinel the bundle's hardcoded API host is rewritten to. Resolved per call. */
const BASE_EXPR = "${globalThis.__GCHAT_BASE__}";

function mtime(p) {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}

/** Keep dist/index.js in sync with index.ts so tests measure current source. */
function ensureFreshBundle() {
  if (mtime(BUNDLE) >= mtime(SRC_TS) && mtime(BUNDLE) > 0) return;
  try {
    execFileSync(
      "npm",
      ["run", "build", "--silent"],
      { cwd: PLUGIN_DIR, stdio: "pipe" }
    );
  } catch (err) {
    throw new Error(
      `dist/index.js is older than index.ts and rebuilding failed (${err.message}). ` +
        `Run the build manually, then re-run the tests.`
    );
  }
}

/**
 * Rewrite the bundle into an importable module.
 *
 * Three surgical edits, and nothing else:
 *  1. Drop `import {...} from "openclaw/..."` SDK imports (unavailable here).
 *     The pattern is deliberately anchored on `from "openclaw/` and uses
 *     [^}]* which cannot cross a closing brace, so `node:fs` / `node:path` /
 *     `node:crypto` imports are provably untouched. A greedier multiline
 *     regex previously ate those and produced `extname is not defined`.
 *  2. Point the hardcoded Google API host at a per-test mock. Every occurrence
 *     of the literal lives inside a template literal, so substituting a
 *     `${globalThis.__GCHAT_BASE__}` interpolation resolves at call time —
 *     each test file can own an ephemeral server without port collisions.
 *  3. Give the uninitialised `logger` a no-op implementation (the real one is
 *     assigned by plugin registration, which we never run).
 */
function buildModuleSource() {
  let code = readFileSync(BUNDLE, "utf8");

  const before = code;
  code = code.replace(/import\s*\{[^}]*\}\s*from\s*"openclaw\/[^"]*";/g, "");
  if (code === before) throw new Error("harness: no openclaw SDK imports stripped — bundle shape changed?");
  if (/from\s*"openclaw/.test(code)) throw new Error("harness: an openclaw import survived stripping");
  for (const builtin of ['"node:fs"', '"node:path"', '"node:crypto"']) {
    if (!code.includes(`from ${builtin}`)) {
      throw new Error(`harness: import of ${builtin} was destroyed by the strip regex`);
    }
  }

  if (!code.includes("https://chat.googleapis.com")) {
    throw new Error("harness: expected hardcoded chat.googleapis.com URLs in bundle");
  }
  code = code.replaceAll("https://chat.googleapis.com", BASE_EXPR);

  const loggerBefore = code;
  code = code.replace(/^var logger;/m, "var logger={info(){},warn(){},error(){},debug(){}};");
  if (code === loggerBefore) throw new Error("harness: could not stub logger");

  // Self-echo suppression internals. `selfUserId` is module-level `let`, so it
  // is exposed through accessors rather than a live binding the tests could not
  // reset between cases.
  code +=
    "\nexport { uploadAttachment, resolveOutboundMedia, sendMediaMessages, guessMimeType, MAX_UPLOAD_BYTES, EXT_TO_MIME };\n" +
    "export { markProcessed, isSelfMessage, rememberSelfIdentity, processedMsgIds, MAX_DEDUP };\n" +
    "export function __setSelfUserId(v){ selfUserId = v; }\n" +
    "export function __getSelfUserId(){ return selfUserId; }\n" +
    "export function __resetDedup(){ processedMsgIds.clear(); }\n";
  return code;
}

/**
 * Materialise + import the module under test. Idempotent and safe under the
 * parallel test-file processes `node --test` spawns: content is compared first
 * and the write is an atomic rename.
 */
export async function loadModuleUnderTest() {
  ensureFreshBundle();
  const source = buildModuleSource();

  let current = null;
  try {
    current = readFileSync(MODULE_PATH, "utf8");
  } catch {}

  if (current !== source) {
    mkdirSync(TMP_DIR, { recursive: true });
    const staging = path.join(TMP_DIR, `.staging-${process.pid}-${randomUUID()}.mjs`);
    writeFileSync(staging, source);
    renameSync(staging, MODULE_PATH);
  }

  return import(MODULE_PATH);
}

// ── Mock Google Chat API ────────────────────────────────────────────────────

/**
 * A node:http server standing in for chat.googleapis.com.
 *
 * Listens on an ephemeral port (0) rather than a fixed one: `node --test` runs
 * test files in parallel processes, and a fixed port would make the suite
 * flaky or order-dependent. Records every request — method, url, headers and
 * the RAW body buffer, which is what lets us prove binary integrity.
 */
export async function startMockChat(handler) {
  const requests = [];

  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const raw = Buffer.concat(chunks);
      const record = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        raw,
        get text() {
          return raw.toString("utf8");
        },
        get json() {
          try {
            return JSON.parse(raw.toString("utf8"));
          } catch {
            return undefined;
          }
        },
      };
      requests.push(record);

      let result;
      try {
        result = await handler(record, requests.length - 1);
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err && err.message) }));
        return;
      }

      const {
        status = 200,
        body = {},
        headers = {},
        delayMs = 0,
        hang = false,
      } = result || {};
      if (hang) return; // never respond: exercises the abort/timeout path
      const send = () => {
        const payload = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
        res.writeHead(status, { "Content-Type": "application/json", ...headers });
        res.end(payload);
      };
      if (delayMs) setTimeout(send, delayMs).unref?.();
      else send();
    });
  });

  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;

  return {
    base,
    requests,
    /** Route the module's hardcoded API host at this server. */
    activate() {
      globalThis.__GCHAT_BASE__ = base;
    },
    reset() {
      requests.length = 0;
    },
    async close() {
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
    },
  };
}

/** A plain file server for resolveOutboundMedia's http(s) branch. */
export async function startMockFileHost(handler) {
  const requests = [];
  const server = createServer(async (req, res) => {
    requests.push({ method: req.method, url: req.url, headers: req.headers });
    let result;
    try {
      result = await handler(req);
    } catch (err) {
      res.writeHead(500, {});
      res.end(String(err && err.message));
      return;
    }
    const { status = 200, body = Buffer.alloc(0), headers = {}, hang = false } = result || {};
    if (hang) return;
    res.writeHead(status, headers);
    res.end(body);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    requests,
    async close() {
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
    },
  };
}

// ── multipart/related parsing ───────────────────────────────────────────────

/**
 * Split a multipart/related body into parts WITHOUT any string round-trip.
 * Boundary scanning happens on the Buffer so binary payloads survive intact —
 * decoding to a JS string would silently mangle non-UTF-8 bytes (e.g. PNG).
 */
export function parseMultipart(rawBody, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType || "");
  if (!m) throw new Error(`no boundary in Content-Type: ${contentType}`);
  const boundary = m[1] || m[2];

  const delim = Buffer.from(`--${boundary}`, "utf8");
  const positions = [];
  let idx = rawBody.indexOf(delim, 0);
  while (idx !== -1) {
    positions.push(idx);
    idx = rawBody.indexOf(delim, idx + delim.length);
  }
  if (positions.length < 2) throw new Error("malformed multipart: fewer than 2 delimiters");

  const parts = [];
  for (let i = 0; i < positions.length - 1; i++) {
    const start = positions[i] + delim.length;
    // Terminating delimiter is `--boundary--`
    if (rawBody.slice(start, start + 2).toString("utf8") === "--") break;
    const chunk = rawBody.slice(start, positions[i + 1]);
    // chunk = \r\n<headers>\r\n\r\n<body>\r\n
    const sep = chunk.indexOf("\r\n\r\n");
    if (sep === -1) throw new Error("malformed multipart part: no header/body separator");
    const headerText = chunk.slice(0, sep).toString("utf8").replace(/^\r\n/, "");
    const headers = {};
    for (const line of headerText.split("\r\n")) {
      const c = line.indexOf(":");
      if (c > 0) headers[line.slice(0, c).trim().toLowerCase()] = line.slice(c + 1).trim();
    }
    let body = chunk.slice(sep + 4);
    if (body.slice(-2).toString("utf8") === "\r\n") body = body.slice(0, -2);
    parts.push({ headers, body });
  }
  return { boundary, parts };
}

// ── misc test utilities ─────────────────────────────────────────────────────

export function makeTempDir(label = "gcps") {
  const dir = path.join(tmpdir(), `${label}-${process.pid}-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return {
    dir,
    file(name, contents) {
      const p = path.join(dir, name);
      writeFileSync(p, contents);
      return p;
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A real 1x1 PNG: non-UTF-8 bytes that a naive string round-trip corrupts. */
export const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

/** Every byte value 0..255, twice — the nastiest thing you can put in a body. */
export const ALL_BYTES = Buffer.concat([
  Buffer.from(Array.from({ length: 256 }, (_, i) => i)),
  Buffer.from(Array.from({ length: 256 }, (_, i) => 255 - i)),
]);

export function okUploadToken(token = "upload-token-abc123") {
  return { status: 200, body: { attachmentDataRef: { attachmentUploadToken: token } } };
}

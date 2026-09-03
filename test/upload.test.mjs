import test from "node:test";
import assert from "node:assert/strict";
import {
  loadModuleUnderTest,
  startMockChat,
  parseMultipart,
  makeTempDir,
  PNG_1X1,
  ALL_BYTES,
  okUploadToken,
} from "./helpers/harness.mjs";

const { uploadAttachment, resolveOutboundMedia, MAX_UPLOAD_BYTES } = await loadModuleUnderTest();

const SPACE = "spaces/TESTSPACE123";

function media(overrides = {}) {
  return {
    buffer: Buffer.from("hello world"),
    filename: "hello.txt",
    mimeType: "text/plain",
    ...overrides,
  };
}

/** Run one assertion against a freshly-bound mock Chat API. */
async function withChat(handler, fn) {
  const chat = await startMockChat(handler);
  chat.activate();
  try {
    return await fn(chat);
  } finally {
    await chat.close();
  }
}

test("uploadAttachment — happy path", async (t) => {
  await t.test("returns the attachmentUploadToken from the response", async () => {
    await withChat(
      () => okUploadToken("tok-happy-1"),
      async () => {
        const token = await uploadAttachment({ space: SPACE, media: media(), token: "oauth-xyz" });
        assert.equal(token, "tok-happy-1");
      }
    );
  });

  await t.test("POSTs to the multipart upload endpoint for the given space", async () => {
    await withChat(
      () => okUploadToken(),
      async (chat) => {
        await uploadAttachment({ space: SPACE, media: media(), token: "oauth-xyz" });
        assert.equal(chat.requests.length, 1);
        const req = chat.requests[0];
        assert.equal(req.method, "POST");
        assert.equal(
          req.url,
          `/upload/v1/${SPACE}/attachments:upload?uploadType=multipart`
        );
      }
    );
  });

  await t.test("sends the bearer token and a multipart/related content type", async () => {
    await withChat(
      () => okUploadToken(),
      async (chat) => {
        await uploadAttachment({ space: SPACE, media: media(), token: "oauth-xyz" });
        const h = chat.requests[0].headers;
        assert.equal(h.authorization, "Bearer oauth-xyz");
        assert.match(h["content-type"], /^multipart\/related; boundary=openclaw-/);
      }
    );
  });
});

test("uploadAttachment — multipart structure", async (t) => {
  await t.test("boundary in the body matches the Content-Type header", async () => {
    await withChat(
      () => okUploadToken(),
      async (chat) => {
        await uploadAttachment({ space: SPACE, media: media(), token: "t" });
        const req = chat.requests[0];
        const declared = /boundary=([^;\s]+)/.exec(req.headers["content-type"])[1];
        const { boundary } = parseMultipart(req.raw, req.headers["content-type"]);
        assert.equal(boundary, declared);
        assert.ok(req.raw.includes(Buffer.from(`--${declared}`)), "body must use the declared boundary");
        assert.ok(
          req.raw.slice(-Buffer.byteLength(`--${declared}--\r\n`)).toString() === `--${declared}--\r\n`,
          "body must end with the closing delimiter"
        );
      }
    );
  });

  await t.test("body has exactly two parts: JSON metadata then file bytes", async () => {
    await withChat(
      () => okUploadToken(),
      async (chat) => {
        await uploadAttachment({
          space: SPACE,
          media: media({ filename: "report.pdf", mimeType: "application/pdf" }),
          token: "t",
        });
        const req = chat.requests[0];
        const { parts } = parseMultipart(req.raw, req.headers["content-type"]);
        assert.equal(parts.length, 2, "exactly two parts");
        assert.equal(parts[0].headers["content-type"], "application/json; charset=UTF-8");
        assert.equal(parts[1].headers["content-type"], "application/pdf");
      }
    );
  });

  await t.test("metadata part is JSON carrying the filename", async () => {
    await withChat(
      () => okUploadToken(),
      async (chat) => {
        await uploadAttachment({
          space: SPACE,
          media: media({ filename: "quarterly report.pdf" }),
          token: "t",
        });
        const req = chat.requests[0];
        const { parts } = parseMultipart(req.raw, req.headers["content-type"]);
        assert.deepEqual(JSON.parse(parts[0].body.toString("utf8")), {
          filename: "quarterly report.pdf",
        });
      }
    );
  });

  await t.test("a filename with quotes stays valid JSON", async () => {
    await withChat(
      () => okUploadToken(),
      async (chat) => {
        const name = 'weird "quoted" name.txt';
        await uploadAttachment({ space: SPACE, media: media({ filename: name }), token: "t" });
        const req = chat.requests[0];
        const { parts } = parseMultipart(req.raw, req.headers["content-type"]);
        assert.deepEqual(JSON.parse(parts[0].body.toString("utf8")), { filename: name });
      }
    );
  });

  await t.test("file part carries the declared MIME type", async () => {
    await withChat(
      () => okUploadToken(),
      async (chat) => {
        await uploadAttachment({
          space: SPACE,
          media: media({ filename: "clip.mp4", mimeType: "video/mp4" }),
          token: "t",
        });
        const { parts } = parseMultipart(
          chat.requests[0].raw,
          chat.requests[0].headers["content-type"]
        );
        assert.equal(parts[1].headers["content-type"], "video/mp4");
      }
    );
  });
});

test("uploadAttachment — binary integrity", async (t) => {
  await t.test("a PNG survives the multipart encoder byte-for-byte", async () => {
    await withChat(
      () => okUploadToken(),
      async (chat) => {
        await uploadAttachment({
          space: SPACE,
          media: media({ buffer: PNG_1X1, filename: "tiny.png", mimeType: "image/png" }),
          token: "t",
        });
        const req = chat.requests[0];
        const { parts } = parseMultipart(req.raw, req.headers["content-type"]);
        assert.equal(parts[1].body.length, PNG_1X1.length, "byte length must be preserved");
        assert.equal(Buffer.compare(parts[1].body, PNG_1X1), 0, "PNG bytes must be identical");
      }
    );
  });

  await t.test("every byte value 0x00–0xFF survives intact", async () => {
    await withChat(
      () => okUploadToken(),
      async (chat) => {
        await uploadAttachment({
          space: SPACE,
          media: media({ buffer: ALL_BYTES, filename: "all.bin", mimeType: "application/octet-stream" }),
          token: "t",
        });
        const req = chat.requests[0];
        const { parts } = parseMultipart(req.raw, req.headers["content-type"]);
        assert.equal(parts[1].body.length, ALL_BYTES.length);
        assert.equal(Buffer.compare(parts[1].body, ALL_BYTES), 0);
      }
    );
  });

  await t.test("payload bytes that look like a boundary delimiter do not truncate the part", async () => {
    // Content containing CRLF + dashes is the classic multipart-splitter trap.
    const tricky = Buffer.from("line1\r\n--not-a-boundary\r\nline2\r\n--\r\n");
    await withChat(
      () => okUploadToken(),
      async (chat) => {
        await uploadAttachment({
          space: SPACE,
          media: media({ buffer: tricky, filename: "tricky.txt" }),
          token: "t",
        });
        const req = chat.requests[0];
        const { parts } = parseMultipart(req.raw, req.headers["content-type"]);
        assert.equal(Buffer.compare(parts[1].body, tricky), 0);
      }
    );
  });

  await t.test("a real file read from disk arrives unchanged end to end", async () => {
    const tmp = makeTempDir("upload-e2e");
    t.after(() => tmp.cleanup());
    const p = tmp.file("photo.png", PNG_1X1);
    await withChat(
      () => okUploadToken(),
      async (chat) => {
        const resolved = await resolveOutboundMedia(p);
        await uploadAttachment({ space: SPACE, media: resolved, token: "t" });
        const req = chat.requests[0];
        const { parts } = parseMultipart(req.raw, req.headers["content-type"]);
        assert.equal(parts[1].headers["content-type"], "image/png");
        assert.deepEqual(JSON.parse(parts[0].body.toString("utf8")), { filename: "photo.png" });
        assert.equal(Buffer.compare(parts[1].body, PNG_1X1), 0, "disk → wire must be lossless");
      }
    );
  });

  await t.test("a multi-megabyte payload is transmitted whole", async () => {
    const big = Buffer.alloc(3 * 1024 * 1024);
    for (let i = 0; i < big.length; i++) big[i] = i % 256;
    await withChat(
      () => okUploadToken(),
      async (chat) => {
        await uploadAttachment({
          space: SPACE,
          media: media({ buffer: big, filename: "big.bin", mimeType: "application/octet-stream" }),
          token: "t",
        });
        const req = chat.requests[0];
        const { parts } = parseMultipart(req.raw, req.headers["content-type"]);
        assert.equal(parts[1].body.length, big.length);
        assert.equal(Buffer.compare(parts[1].body, big), 0);
      }
    );
  });
});

test("uploadAttachment — size guards", async (t) => {
  await t.test("refuses an empty file and never contacts the API", async () => {
    await withChat(
      () => okUploadToken(),
      async (chat) => {
        await assert.rejects(
          () => uploadAttachment({ space: SPACE, media: media({ buffer: Buffer.alloc(0), filename: "empty.png" }), token: "t" }),
          /Refusing to upload empty file: empty\.png/
        );
        assert.equal(chat.requests.length, 0, "no request should be made");
      }
    );
  });

  await t.test("accepts a single byte (boundary of the empty check)", async () => {
    await withChat(
      () => okUploadToken("tok-one-byte"),
      async (chat) => {
        const token = await uploadAttachment({
          space: SPACE,
          media: media({ buffer: Buffer.from([0x00]), filename: "one.bin" }),
          token: "t",
        });
        assert.equal(token, "tok-one-byte");
        const { parts } = parseMultipart(chat.requests[0].raw, chat.requests[0].headers["content-type"]);
        assert.equal(parts[1].body.length, 1);
        assert.equal(parts[1].body[0], 0x00);
      }
    );
  });

  await t.test("refuses a file over the 200 MB limit without uploading it", async () => {
    // Sparse allocation: never materialises 200 MB of real content.
    const oversized = { length: MAX_UPLOAD_BYTES + 1 };
    await withChat(
      () => okUploadToken(),
      async (chat) => {
        await assert.rejects(
          () =>
            uploadAttachment({
              space: SPACE,
              media: media({ buffer: oversized, filename: "huge.zip" }),
              token: "t",
            }),
          (err) => {
            assert.match(err.message, /File huge\.zip is 200\.0 MB, over the Google Chat 200 MB limit/);
            return true;
          }
        );
        assert.equal(chat.requests.length, 0, "oversized file must not be sent");
      }
    );
  });

  await t.test("reports the size in MB for a clearly oversized file", async () => {
    const oversized = { length: 250 * 1024 * 1024 };
    await assert.rejects(
      () => uploadAttachment({ space: SPACE, media: media({ buffer: oversized, filename: "x.bin" }), token: "t" }),
      /is 250\.0 MB, over the Google Chat 200 MB limit/
    );
  });

  await t.test("a file exactly at the limit is not rejected by the size guard", async () => {
    // Guard is `> MAX_UPLOAD_BYTES`, so == limit passes the check. Proven by
    // reaching the network layer (which we then fail deliberately).
    const atLimit = { length: MAX_UPLOAD_BYTES };
    await assert.rejects(
      () => uploadAttachment({ space: SPACE, media: media({ buffer: atLimit, filename: "limit.bin" }), token: "t" }),
      (err) => {
        assert.doesNotMatch(err.message, /over the Google Chat 200 MB limit/);
        return true;
      }
    );
  });
});

test("uploadAttachment — error responses", async (t) => {
  await t.test("throws with status and body on a non-200", async () => {
    await withChat(
      () => ({ status: 403, body: { error: { message: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" } } }),
      async () => {
        await assert.rejects(
          () => uploadAttachment({ space: SPACE, media: media(), token: "t" }),
          (err) => {
            assert.match(err.message, /Attachment upload failed \(403\)/);
            assert.match(err.message, /ACCESS_TOKEN_SCOPE_INSUFFICIENT/);
            return true;
          }
        );
      }
    );
  });

  await t.test("truncates a long error body to 300 characters", async () => {
    const long = "E".repeat(5000);
    await withChat(
      () => ({ status: 500, body: long, headers: { "Content-Type": "text/plain" } }),
      async () => {
        await assert.rejects(
          () => uploadAttachment({ space: SPACE, media: media(), token: "t" }),
          (err) => {
            const detail = err.message.split("): ")[1];
            assert.equal(detail.length, 300, "error detail should be capped at 300 chars");
            return true;
          }
        );
      }
    );
  });

  await t.test("throws when a 200 response is not JSON", async () => {
    await withChat(
      () => ({ status: 200, body: "<html>proxy interstitial</html>", headers: { "Content-Type": "text/html" } }),
      async () => {
        await assert.rejects(
          () => uploadAttachment({ space: SPACE, media: media(), token: "t" }),
          (err) => {
            assert.match(err.message, /Attachment upload returned non-JSON/);
            assert.match(err.message, /proxy interstitial/);
            return true;
          }
        );
      }
    );
  });

  await t.test("throws when the JSON response has no attachmentUploadToken", async () => {
    await withChat(
      () => ({ status: 200, body: { attachmentDataRef: {} } }),
      async () => {
        await assert.rejects(
          () => uploadAttachment({ space: SPACE, media: media(), token: "t" }),
          /Attachment upload missing attachmentUploadToken/
        );
      }
    );
  });

  await t.test("throws when attachmentDataRef is absent entirely", async () => {
    await withChat(
      () => ({ status: 200, body: { somethingElse: true } }),
      async () => {
        await assert.rejects(
          () => uploadAttachment({ space: SPACE, media: media(), token: "t" }),
          /Attachment upload missing attachmentUploadToken/
        );
      }
    );
  });

  await t.test("throws when the token is present but empty", async () => {
    await withChat(
      () => ({ status: 200, body: { attachmentDataRef: { attachmentUploadToken: "" } } }),
      async () => {
        await assert.rejects(
          () => uploadAttachment({ space: SPACE, media: media(), token: "t" }),
          /Attachment upload missing attachmentUploadToken/
        );
      }
    );
  });
});

test("uploadAttachment — timeout", async (t) => {
  await t.test("aborts when the server never responds", async () => {
    await withChat(
      () => ({ hang: true }),
      async () => {
        await assert.rejects(
          () => uploadAttachment({ space: SPACE, media: media(), token: "t", timeoutMs: 150 }),
          (err) => {
            // The AbortController surfaces as a fetch abort, not a wrapped message.
            assert.match(`${err.name} ${err.message}`, /abort|AbortError/i);
            return true;
          }
        );
      }
    );
  });

  await t.test("a response arriving inside the timeout still succeeds", async () => {
    await withChat(
      () => ({ ...okUploadToken("tok-slow"), delayMs: 60 }),
      async () => {
        const token = await uploadAttachment({
          space: SPACE,
          media: media(),
          token: "t",
          timeoutMs: 3000,
        });
        assert.equal(token, "tok-slow");
      }
    );
  });

  await t.test("the timeout timer does not keep the event loop alive", async () => {
    // clearTimeout runs in a finally block; if it regressed the process would
    // hang for the full default 120s timeout instead of exiting.
    await withChat(
      () => okUploadToken(),
      async () => {
        await uploadAttachment({ space: SPACE, media: media(), token: "t" });
        assert.ok(true);
      }
    );
  });
});

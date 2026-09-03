import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  loadModuleUnderTest,
  startMockFileHost,
  makeTempDir,
  PNG_1X1,
  ALL_BYTES,
} from "./helpers/harness.mjs";

const { resolveOutboundMedia } = await loadModuleUnderTest();

/** Spin up a one-shot file host for a single assertion, always torn down. */
async function withHost(handler, fn) {
  const host = await startMockFileHost(handler);
  try {
    return await fn(host);
  } finally {
    await host.close();
  }
}

test("resolveOutboundMedia — rejects unusable references", async (t) => {
  await t.test("empty string", async () => {
    await assert.rejects(() => resolveOutboundMedia(""), /Empty media reference/);
  });
  await t.test("whitespace only", async () => {
    await assert.rejects(() => resolveOutboundMedia("   \t\n  "), /Empty media reference/);
  });
  await t.test("null and undefined coerce to empty, not to the string 'null'", async () => {
    await assert.rejects(() => resolveOutboundMedia(null), /Empty media reference/);
    await assert.rejects(() => resolveOutboundMedia(undefined), /Empty media reference/);
  });
});

test("resolveOutboundMedia — local filesystem paths", async (t) => {
  const tmp = makeTempDir("resolve-local");
  t.after(() => tmp.cleanup());

  await t.test("reads an absolute path and infers the MIME type", async () => {
    const p = tmp.file("tiny.png", PNG_1X1);
    const media = await resolveOutboundMedia(p);
    assert.equal(media.filename, "tiny.png");
    assert.equal(media.mimeType, "image/png");
    assert.equal(Buffer.compare(media.buffer, PNG_1X1), 0, "bytes must survive the read");
  });

  await t.test("trims surrounding whitespace off the reference", async () => {
    const p = tmp.file("padded.txt", "hello");
    const media = await resolveOutboundMedia(`  ${p}\n`);
    assert.equal(media.filename, "padded.txt");
    assert.equal(media.mimeType, "text/plain");
  });

  await t.test("resolves a relative path against process.cwd()", async () => {
    const p = tmp.file("relative.json", '{"ok":true}');
    const cwd = process.cwd();
    process.chdir(tmp.dir);
    try {
      const media = await resolveOutboundMedia("./relative.json");
      assert.equal(media.filename, "relative.json");
      assert.equal(media.mimeType, "application/json");
      assert.equal(media.buffer.toString(), '{"ok":true}');
    } finally {
      process.chdir(cwd);
    }
    assert.ok(p);
  });

  await t.test("unknown extension falls back to application/octet-stream", async () => {
    const p = tmp.file("blob.qqq", ALL_BYTES);
    const media = await resolveOutboundMedia(p);
    assert.equal(media.mimeType, "application/octet-stream");
    assert.equal(Buffer.compare(media.buffer, ALL_BYTES), 0);
  });

  await t.test("propagates a read error for a missing file", async () => {
    await assert.rejects(
      () => resolveOutboundMedia(path.join(tmp.dir, "does-not-exist.png")),
      /ENOENT/
    );
  });
});

test("resolveOutboundMedia — file:// URLs", async (t) => {
  const tmp = makeTempDir("resolve-fileurl");
  t.after(() => tmp.cleanup());

  await t.test("reads a file:// URL", async () => {
    const p = tmp.file("via-url.pdf", Buffer.from("%PDF-1.4 fake"));
    const media = await resolveOutboundMedia(pathToFileURL(p).href);
    assert.equal(media.filename, "via-url.pdf");
    assert.equal(media.mimeType, "application/pdf");
    assert.equal(media.buffer.toString(), "%PDF-1.4 fake");
  });

  await t.test("percent-decodes a file:// URL containing spaces", async () => {
    const p = tmp.file("my report v2.csv", "a,b\n1,2\n");
    const href = pathToFileURL(p).href;
    assert.ok(href.includes("%20"), "precondition: URL should be percent-encoded");
    const media = await resolveOutboundMedia(href);
    assert.equal(media.filename, "my report v2.csv");
    assert.equal(media.mimeType, "text/csv");
  });
});

test("resolveOutboundMedia — opts.readFile override", async (t) => {
  await t.test("uses the injected reader instead of touching the disk", async () => {
    const seen = [];
    const media = await resolveOutboundMedia("/nonexistent/dir/injected.png", {
      readFile: async (p) => {
        seen.push(p);
        return PNG_1X1;
      },
    });
    assert.deepEqual(seen, ["/nonexistent/dir/injected.png"]);
    assert.equal(media.filename, "injected.png");
    assert.equal(media.mimeType, "image/png");
    assert.equal(Buffer.compare(media.buffer, PNG_1X1), 0);
  });

  await t.test("receives the resolved absolute path for a relative ref", async () => {
    let got;
    await resolveOutboundMedia("rel/inner.txt", {
      readFile: async (p) => {
        got = p;
        return Buffer.from("x");
      },
    });
    assert.equal(got, path.resolve("rel/inner.txt"));
    assert.ok(path.isAbsolute(got));
  });

  await t.test("falls back to 'attachment' when the path has no basename", async () => {
    // resolve("/") is "/", whose split("/").pop() is "" — the `|| "attachment"`
    // fallback. Only reachable through an injected reader, because really
    // reading "/" fails with EISDIR before the filename is ever computed.
    const media = await resolveOutboundMedia("/", {
      readFile: async () => Buffer.from("root bytes"),
    });
    assert.equal(media.filename, "attachment");
    assert.equal(media.mimeType, "application/octet-stream");
  });

  await t.test("propagates a rejection from the injected reader", async () => {
    await assert.rejects(
      () =>
        resolveOutboundMedia("/x/y.png", {
          readFile: async () => {
            throw new Error("injected reader exploded");
          },
        }),
      /injected reader exploded/
    );
  });

  await t.test("is ignored for http refs, which always go over the wire", async () => {
    await withHost(
      () => ({ status: 200, body: PNG_1X1, headers: { "Content-Type": "image/png" } }),
      async (host) => {
        let called = false;
        const media = await resolveOutboundMedia(`${host.base}/pic.png`, {
          readFile: async () => {
            called = true;
            return Buffer.from("wrong");
          },
        });
        assert.equal(called, false, "readFile must not be consulted for http refs");
        assert.equal(Buffer.compare(media.buffer, PNG_1X1), 0);
      }
    );
  });
});

test("resolveOutboundMedia — http(s) references", async (t) => {
  await t.test("honours the Content-Disposition filename", async () => {
    await withHost(
      () => ({
        status: 200,
        body: PNG_1X1,
        headers: {
          "Content-Type": "image/png",
          "Content-Disposition": 'attachment; filename="quarterly chart.png"',
        },
      }),
      async (host) => {
        const media = await resolveOutboundMedia(`${host.base}/download?id=99`);
        assert.equal(media.filename, "quarterly chart.png");
        assert.equal(media.mimeType, "image/png");
        assert.equal(Buffer.compare(media.buffer, PNG_1X1), 0);
      }
    );
  });

  await t.test("percent-decodes an RFC 5987 filename*", async () => {
    await withHost(
      () => ({
        status: 200,
        body: Buffer.from("cafe"),
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": "attachment; filename*=UTF-8''caf%C3%A9%20menu.pdf",
        },
      }),
      async (host) => {
        const media = await resolveOutboundMedia(`${host.base}/f`);
        assert.equal(media.filename, "café menu.pdf");
        assert.equal(media.mimeType, "application/pdf");
      }
    );
  });

  await t.test("falls back to the URL path basename when there is no disposition", async () => {
    await withHost(
      () => ({ status: 200, body: PNG_1X1, headers: { "Content-Type": "image/png" } }),
      async (host) => {
        const media = await resolveOutboundMedia(`${host.base}/assets/logo.png?v=3#frag`);
        assert.equal(media.filename, "logo.png", "query and fragment must not leak into the name");
        assert.equal(media.mimeType, "image/png");
      }
    );
  });

  await t.test("percent-decodes the URL path basename", async () => {
    await withHost(
      () => ({ status: 200, body: Buffer.from("x"), headers: { "Content-Type": "text/plain" } }),
      async (host) => {
        const media = await resolveOutboundMedia(`${host.base}/files/my%20notes.txt`);
        assert.equal(media.filename, "my notes.txt");
      }
    );
  });

  await t.test("uses 'attachment' when the URL path has no basename", async () => {
    await withHost(
      () => ({ status: 200, body: Buffer.from("root"), headers: { "Content-Type": "text/plain" } }),
      async (host) => {
        const media = await resolveOutboundMedia(`${host.base}/`);
        // "attachment" has no extension, so .txt is appended from the content type.
        assert.equal(media.filename, "attachment.txt");
        assert.equal(media.mimeType, "text/plain");
      }
    );
  });

  await t.test("appends an extension derived from the content type when missing", async () => {
    await withHost(
      () => ({ status: 200, body: PNG_1X1, headers: { "Content-Type": "image/png" } }),
      async (host) => {
        const media = await resolveOutboundMedia(`${host.base}/render/chart`);
        assert.equal(media.filename, "chart.png");
        assert.equal(media.mimeType, "image/png");
      }
    );
  });

  await t.test("strips content-type parameters before matching", async () => {
    await withHost(
      () => ({
        status: 200,
        body: Buffer.from("hi"),
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      }),
      async (host) => {
        const media = await resolveOutboundMedia(`${host.base}/note`);
        assert.equal(media.mimeType, "text/plain", "charset must be stripped");
        assert.equal(media.filename, "note.txt");
      }
    );
  });

  await t.test("leaves the name alone when the content type is unmappable", async () => {
    await withHost(
      () => ({
        status: 200,
        body: Buffer.from("data"),
        headers: { "Content-Type": "application/x-unmapped" },
      }),
      async (host) => {
        const media = await resolveOutboundMedia(`${host.base}/thing`);
        assert.equal(media.filename, "thing", "no extension can be derived");
        assert.equal(media.mimeType, "application/x-unmapped");
      }
    );
  });

  await t.test("keeps an existing extension even if the content type disagrees", async () => {
    await withHost(
      () => ({
        status: 200,
        body: PNG_1X1,
        headers: { "Content-Type": "image/png", "Content-Disposition": 'attachment; filename="already.bin"' },
      }),
      async (host) => {
        const media = await resolveOutboundMedia(`${host.base}/x`);
        assert.equal(media.filename, "already.bin");
        assert.equal(media.mimeType, "image/png", "header wins over the extension");
      }
    );
  });

  await t.test("guesses the MIME from the filename when the server sends no content type", async () => {
    await withHost(
      () => ({ status: 200, body: Buffer.from("%PDF"), headers: { "Content-Type": "" } }),
      async (host) => {
        const media = await resolveOutboundMedia(`${host.base}/report.pdf`);
        assert.equal(media.filename, "report.pdf");
        assert.equal(media.mimeType, "application/pdf");
      }
    );
  });

  await t.test("preserves binary payloads byte-for-byte across the transfer", async () => {
    await withHost(
      () => ({ status: 200, body: ALL_BYTES, headers: { "Content-Type": "application/octet-stream" } }),
      async (host) => {
        const media = await resolveOutboundMedia(`${host.base}/all.bin`);
        assert.equal(media.buffer.length, ALL_BYTES.length);
        assert.equal(Buffer.compare(media.buffer, ALL_BYTES), 0);
      }
    );
  });

  await t.test("throws on a non-200 response and names the status and URL", async () => {
    await withHost(
      () => ({ status: 404, body: "nope" }),
      async (host) => {
        const url = `${host.base}/missing.png`;
        await assert.rejects(
          () => resolveOutboundMedia(url),
          (err) => {
            assert.match(err.message, /Fetch media failed \(404\)/);
            assert.ok(err.message.includes(url), "error should name the URL");
            return true;
          }
        );
      }
    );
  });

  await t.test("throws on a 500 response", async () => {
    await withHost(
      () => ({ status: 500, body: "boom" }),
      async (host) => {
        await assert.rejects(
          () => resolveOutboundMedia(`${host.base}/err`),
          /Fetch media failed \(500\)/
        );
      }
    );
  });

  await t.test("accepts an empty body without throwing (rejection happens at upload)", async () => {
    await withHost(
      () => ({ status: 200, body: Buffer.alloc(0), headers: { "Content-Type": "image/png" } }),
      async (host) => {
        const media = await resolveOutboundMedia(`${host.base}/empty.png`);
        assert.equal(media.buffer.length, 0);
      }
    );
  });

  await t.test("matches the http scheme case-insensitively", async () => {
    await withHost(
      () => ({ status: 200, body: Buffer.from("ok"), headers: { "Content-Type": "text/plain" } }),
      async (host) => {
        const upper = host.base.replace("http://", "HTTP://");
        const media = await resolveOutboundMedia(`${upper}/case.txt`);
        assert.equal(media.filename, "case.txt");
      }
    );
  });

  await t.test("surfaces a transport failure when the host is unreachable", async () => {
    const host = await startMockFileHost(() => ({ status: 200 }));
    const base = host.base;
    await host.close();
    await assert.rejects(() => resolveOutboundMedia(`${base}/gone.png`));
  });
});

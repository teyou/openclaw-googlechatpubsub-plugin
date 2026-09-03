import test from "node:test";
import assert from "node:assert/strict";
import {
  loadModuleUnderTest,
  startMockChat,
  parseMultipart,
  makeTempDir,
  PNG_1X1,
} from "./helpers/harness.mjs";

const { sendMediaMessages } = await loadModuleUnderTest();

const SPACE = "spaces/TESTSPACE123";

const isUpload = (req) => req.url.includes("attachments:upload");
const isMessage = (req) => req.url.includes("/messages");

/**
 * Mock Chat API that succeeds by default.
 * `failUploadsFor` — substrings of the metadata filename whose upload should 500.
 * `failMessages`   — when true, message creation returns 500.
 */
function chatHandler(opts = {}) {
  const { failUploadsFor = [], failMessages = false, messageStatus = 200 } = opts;
  let uploadSeq = 0;
  let msgSeq = 0;
  return (req) => {
    if (isUpload(req)) {
      const { parts } = parseMultipart(req.raw, req.headers["content-type"]);
      const filename = JSON.parse(parts[0].body.toString("utf8")).filename;
      if (failUploadsFor.some((f) => filename.includes(f))) {
        return { status: 500, body: { error: `upload rejected for ${filename}` } };
      }
      uploadSeq++;
      return { status: 200, body: { attachmentDataRef: { attachmentUploadToken: `tok-${uploadSeq}` } } };
    }
    if (isMessage(req)) {
      if (failMessages) return { status: 500, body: { error: "message create rejected" } };
      msgSeq++;
      return { status: messageStatus, body: { name: `${SPACE}/messages/msg-${msgSeq}` } };
    }
    return { status: 404, body: {} };
  };
}

async function withChat(handler, fn) {
  const chat = await startMockChat(handler);
  chat.activate();
  try {
    return await fn(chat);
  } finally {
    await chat.close();
  }
}

/** In-memory readFile so no test needs real files unless it wants them. */
function memReader(map) {
  return async (p) => {
    const name = p.split("/").pop();
    if (map[name] === undefined) throw new Error(`ENOENT: no such file, open '${p}'`);
    return Buffer.isBuffer(map[name]) ? map[name] : Buffer.from(map[name]);
  };
}

test("sendMediaMessages — single reference", async (t) => {
  await t.test("uploads then posts a message and reports it sent", async () => {
    await withChat(chatHandler(), async (chat) => {
      const result = await sendMediaMessages({
        space: SPACE,
        mediaRefs: ["/tmp/a.png"],
        token: "oauth",
        readFile: memReader({ "a.png": PNG_1X1 }),
      });
      assert.deepEqual(result.failed, []);
      assert.equal(result.sent, 1);
      assert.deepEqual(result.messageIds, [`${SPACE}/messages/msg-1`]);
      assert.equal(chat.requests.length, 2);
      assert.ok(isUpload(chat.requests[0]), "upload happens first");
      assert.ok(isMessage(chat.requests[1]), "message creation happens second");
    });
  });

  await t.test("attaches the upload token in the documented shape", async () => {
    await withChat(chatHandler(), async (chat) => {
      await sendMediaMessages({
        space: SPACE,
        mediaRefs: ["/tmp/a.png"],
        token: "oauth",
        readFile: memReader({ "a.png": PNG_1X1 }),
      });
      const body = chat.requests[1].json;
      assert.deepEqual(body.attachment, [
        { attachmentDataRef: { attachmentUploadToken: "tok-1" } },
      ]);
    });
  });

  await t.test("posts the message to the space with the bearer token", async () => {
    await withChat(chatHandler(), async (chat) => {
      await sendMediaMessages({
        space: SPACE,
        mediaRefs: ["/tmp/a.png"],
        token: "oauth-abc",
        readFile: memReader({ "a.png": PNG_1X1 }),
      });
      const msg = chat.requests[1];
      assert.equal(msg.method, "POST");
      assert.equal(msg.url, `/v1/${SPACE}/messages`);
      assert.equal(msg.headers.authorization, "Bearer oauth-abc");
    });
  });

  await t.test("sends no text field when there is no caption", async () => {
    await withChat(chatHandler(), async (chat) => {
      await sendMediaMessages({
        space: SPACE,
        mediaRefs: ["/tmp/a.png"],
        token: "oauth",
        readFile: memReader({ "a.png": PNG_1X1 }),
      });
      assert.equal("text" in chat.requests[1].json, false);
    });
  });

  await t.test("an empty mediaRefs array does nothing at all", async () => {
    await withChat(chatHandler(), async (chat) => {
      const result = await sendMediaMessages({ space: SPACE, mediaRefs: [], token: "oauth" });
      assert.deepEqual(result, { sent: 0, failed: [], messageIds: [] });
      assert.equal(chat.requests.length, 0);
    });
  });
});

test("sendMediaMessages — caption placement", async (t) => {
  await t.test("caption rides on the first message only", async () => {
    await withChat(chatHandler(), async (chat) => {
      const result = await sendMediaMessages({
        space: SPACE,
        mediaRefs: ["/tmp/a.png", "/tmp/b.png", "/tmp/c.png"],
        token: "oauth",
        text: "Here are the three charts",
        readFile: memReader({ "a.png": PNG_1X1, "b.png": PNG_1X1, "c.png": PNG_1X1 }),
      });
      assert.equal(result.sent, 3);
      const messages = chat.requests.filter(isMessage).map((r) => r.json);
      assert.equal(messages.length, 3);
      assert.equal(messages[0].text, "Here are the three charts");
      assert.equal("text" in messages[1], false, "second message must have no caption");
      assert.equal("text" in messages[2], false, "third message must have no caption");
    });
  });

  await t.test("caption is trimmed", async () => {
    await withChat(chatHandler(), async (chat) => {
      await sendMediaMessages({
        space: SPACE,
        mediaRefs: ["/tmp/a.png"],
        token: "oauth",
        text: "   spaced out   ",
        readFile: memReader({ "a.png": PNG_1X1 }),
      });
      assert.equal(chat.requests.filter(isMessage)[0].json.text, "spaced out");
    });
  });

  await t.test("a whitespace-only caption is treated as no caption", async () => {
    await withChat(chatHandler(), async (chat) => {
      const result = await sendMediaMessages({
        space: SPACE,
        mediaRefs: ["/tmp/a.png"],
        token: "oauth",
        text: "   \n\t ",
        readFile: memReader({ "a.png": PNG_1X1 }),
      });
      assert.equal(result.sent, 1);
      assert.equal("text" in chat.requests.filter(isMessage)[0].json, false);
    });
  });

  await t.test("caption moves to the first SURVIVING upload when earlier ones fail", async () => {
    await withChat(chatHandler({ failUploadsFor: ["broken"] }), async (chat) => {
      const result = await sendMediaMessages({
        space: SPACE,
        mediaRefs: ["/tmp/broken.png", "/tmp/good.png"],
        token: "oauth",
        text: "important caption",
        readFile: memReader({ "broken.png": PNG_1X1, "good.png": PNG_1X1 }),
      });
      assert.equal(result.sent, 1);
      assert.equal(result.failed.length, 1);
      const messages = chat.requests.filter(isMessage).map((r) => r.json);
      assert.equal(messages.length, 1);
      assert.equal(messages[0].text, "important caption", "caption must not be lost with the failed ref");
    });
  });
});

test("sendMediaMessages — threading", async (t) => {
  await t.test("propagates threadName and the default reply option", async () => {
    await withChat(chatHandler(), async (chat) => {
      await sendMediaMessages({
        space: SPACE,
        mediaRefs: ["/tmp/a.png"],
        token: "oauth",
        threadName: `${SPACE}/threads/THREAD1`,
        readFile: memReader({ "a.png": PNG_1X1 }),
      });
      const msg = chat.requests.filter(isMessage)[0];
      assert.equal(
        msg.url,
        `/v1/${SPACE}/messages?messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD`
      );
      assert.deepEqual(msg.json.thread, { name: `${SPACE}/threads/THREAD1` });
    });
  });

  await t.test("honours an explicit replyMessageOption", async () => {
    await withChat(chatHandler(), async (chat) => {
      await sendMediaMessages({
        space: SPACE,
        mediaRefs: ["/tmp/a.png"],
        token: "oauth",
        threadName: `${SPACE}/threads/T2`,
        replyMessageOption: "REPLY_MESSAGE_OR_FAIL",
        readFile: memReader({ "a.png": PNG_1X1 }),
      });
      const msg = chat.requests.filter(isMessage)[0];
      assert.equal(msg.url, `/v1/${SPACE}/messages?messageReplyOption=REPLY_MESSAGE_OR_FAIL`);
    });
  });

  await t.test("omits thread and reply option when no thread is given", async () => {
    await withChat(chatHandler(), async (chat) => {
      await sendMediaMessages({
        space: SPACE,
        mediaRefs: ["/tmp/a.png"],
        token: "oauth",
        readFile: memReader({ "a.png": PNG_1X1 }),
      });
      const msg = chat.requests.filter(isMessage)[0];
      assert.equal(msg.url, `/v1/${SPACE}/messages`);
      assert.doesNotMatch(msg.url, /messageReplyOption/);
      assert.equal("thread" in msg.json, false);
    });
  });

  await t.test("applies the thread to every message in a multi-ref batch", async () => {
    await withChat(chatHandler(), async (chat) => {
      await sendMediaMessages({
        space: SPACE,
        mediaRefs: ["/tmp/a.png", "/tmp/b.png"],
        token: "oauth",
        threadName: `${SPACE}/threads/T3`,
        readFile: memReader({ "a.png": PNG_1X1, "b.png": PNG_1X1 }),
      });
      const messages = chat.requests.filter(isMessage);
      assert.equal(messages.length, 2);
      for (const m of messages) {
        assert.deepEqual(m.json.thread, { name: `${SPACE}/threads/T3` });
        assert.match(m.url, /messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD/);
      }
    });
  });
});

test("sendMediaMessages — multiple references", async (t) => {
  await t.test("sends one message per ref, in order, and collects the ids", async () => {
    await withChat(chatHandler(), async (chat) => {
      const result = await sendMediaMessages({
        space: SPACE,
        mediaRefs: ["/tmp/a.png", "/tmp/b.pdf", "/tmp/c.txt"],
        token: "oauth",
        readFile: memReader({ "a.png": PNG_1X1, "b.pdf": "%PDF", "c.txt": "notes" }),
      });
      assert.equal(result.sent, 3);
      assert.deepEqual(result.messageIds, [
        `${SPACE}/messages/msg-1`,
        `${SPACE}/messages/msg-2`,
        `${SPACE}/messages/msg-3`,
      ]);
      const uploads = chat.requests.filter(isUpload).map((r) => {
        const { parts } = parseMultipart(r.raw, r.headers["content-type"]);
        return JSON.parse(parts[0].body.toString("utf8")).filename;
      });
      assert.deepEqual(uploads, ["a.png", "b.pdf", "c.txt"], "uploads happen in ref order");
    });
  });

  await t.test("each ref gets its own MIME type on the wire", async () => {
    await withChat(chatHandler(), async (chat) => {
      await sendMediaMessages({
        space: SPACE,
        mediaRefs: ["/tmp/a.png", "/tmp/b.pdf"],
        token: "oauth",
        readFile: memReader({ "a.png": PNG_1X1, "b.pdf": "%PDF" }),
      });
      const mimes = chat.requests.filter(isUpload).map((r) => {
        const { parts } = parseMultipart(r.raw, r.headers["content-type"]);
        return parts[1].headers["content-type"];
      });
      assert.deepEqual(mimes, ["image/png", "application/pdf"]);
    });
  });

  await t.test("each message carries its own distinct upload token", async () => {
    await withChat(chatHandler(), async (chat) => {
      await sendMediaMessages({
        space: SPACE,
        mediaRefs: ["/tmp/a.png", "/tmp/b.png"],
        token: "oauth",
        readFile: memReader({ "a.png": PNG_1X1, "b.png": PNG_1X1 }),
      });
      const tokens = chat.requests
        .filter(isMessage)
        .map((r) => r.json.attachment[0].attachmentDataRef.attachmentUploadToken);
      assert.deepEqual(tokens, ["tok-1", "tok-2"]);
    });
  });

  await t.test("a repeated ref is uploaded once per occurrence (de-dup is the caller's job)", async () => {
    // index.ts de-dups with `[...new Set(mediaRefs)]` at both call sites; the
    // function itself is deliberately faithful to the array it is handed.
    await withChat(chatHandler(), async (chat) => {
      const result = await sendMediaMessages({
        space: SPACE,
        mediaRefs: ["/tmp/a.png", "/tmp/a.png"],
        token: "oauth",
        readFile: memReader({ "a.png": PNG_1X1 }),
      });
      assert.equal(result.sent, 2);
      assert.equal(chat.requests.filter(isUpload).length, 2);
    });
  });

  await t.test("de-duplicated input yields exactly one upload", async () => {
    await withChat(chatHandler(), async (chat) => {
      const refs = [...new Set(["/tmp/a.png", "/tmp/a.png", "/tmp/b.png"])];
      const result = await sendMediaMessages({
        space: SPACE,
        mediaRefs: refs,
        token: "oauth",
        readFile: memReader({ "a.png": PNG_1X1, "b.png": PNG_1X1 }),
      });
      assert.equal(result.sent, 2);
      assert.equal(chat.requests.filter(isUpload).length, 2);
    });
  });
});

test("sendMediaMessages — failure isolation", async (t) => {
  await t.test("a failing ref does not abort the batch", async () => {
    await withChat(chatHandler({ failUploadsFor: ["bad"] }), async () => {
      const result = await sendMediaMessages({
        space: SPACE,
        mediaRefs: ["/tmp/ok1.png", "/tmp/bad.png", "/tmp/ok2.png"],
        token: "oauth",
        readFile: memReader({ "ok1.png": PNG_1X1, "bad.png": PNG_1X1, "ok2.png": PNG_1X1 }),
      });
      assert.equal(result.sent, 2, "the two good refs still go out");
      assert.equal(result.failed.length, 1);
      assert.equal(result.messageIds.length, 2);
    });
  });

  await t.test("failure entries name the ref and the reason", async () => {
    await withChat(chatHandler({ failUploadsFor: ["bad"] }), async () => {
      const result = await sendMediaMessages({
        space: SPACE,
        mediaRefs: ["/tmp/bad.png"],
        token: "oauth",
        readFile: memReader({ "bad.png": PNG_1X1 }),
      });
      assert.equal(result.failed.length, 1);
      assert.match(result.failed[0], /^\/tmp\/bad\.png: /);
      assert.match(result.failed[0], /Attachment upload failed \(500\)/);
    });
  });

  await t.test("an unresolvable ref is isolated without an API call", async () => {
    await withChat(chatHandler(), async (chat) => {
      const result = await sendMediaMessages({
        space: SPACE,
        mediaRefs: ["/tmp/missing.png", "/tmp/present.png"],
        token: "oauth",
        readFile: memReader({ "present.png": PNG_1X1 }),
      });
      assert.equal(result.sent, 1);
      assert.equal(result.failed.length, 1);
      assert.match(result.failed[0], /missing\.png: ENOENT/);
      assert.equal(chat.requests.filter(isUpload).length, 1, "only the resolvable ref is uploaded");
    });
  });

  await t.test("an empty-string ref is isolated as a failure", async () => {
    await withChat(chatHandler(), async () => {
      const result = await sendMediaMessages({
        space: SPACE,
        mediaRefs: ["", "/tmp/a.png"],
        token: "oauth",
        readFile: memReader({ "a.png": PNG_1X1 }),
      });
      assert.equal(result.sent, 1);
      assert.match(result.failed[0], /Empty media reference/);
    });
  });

  await t.test("an empty file is isolated as a failure", async () => {
    await withChat(chatHandler(), async () => {
      const result = await sendMediaMessages({
        space: SPACE,
        mediaRefs: ["/tmp/empty.png", "/tmp/a.png"],
        token: "oauth",
        readFile: memReader({ "empty.png": Buffer.alloc(0), "a.png": PNG_1X1 }),
      });
      assert.equal(result.sent, 1);
      assert.match(result.failed[0], /Refusing to upload empty file/);
    });
  });

  await t.test("a failing message create counts as a failed ref even though upload succeeded", async () => {
    await withChat(chatHandler({ failMessages: true }), async (chat) => {
      const result = await sendMediaMessages({
        space: SPACE,
        mediaRefs: ["/tmp/a.png"],
        token: "oauth",
        readFile: memReader({ "a.png": PNG_1X1 }),
      });
      assert.equal(result.sent, 0);
      assert.equal(result.failed.length, 1);
      assert.match(result.failed[0], /Message create failed \(500\)/);
      assert.equal(chat.requests.filter(isUpload).length, 1, "the upload did happen");
    });
  });

  await t.test("a 2xx message response with no name still counts as sent", async () => {
    await withChat(
      (req) => {
        if (isUpload(req)) {
          return { status: 200, body: { attachmentDataRef: { attachmentUploadToken: "tok" } } };
        }
        return { status: 200, body: {} };
      },
      async () => {
        const result = await sendMediaMessages({
          space: SPACE,
          mediaRefs: ["/tmp/a.png"],
          token: "oauth",
          readFile: memReader({ "a.png": PNG_1X1 }),
        });
        assert.equal(result.sent, 1);
        assert.deepEqual(result.messageIds, [], "no id to collect");
      }
    );
  });
});

test("sendMediaMessages — caption survives total failure", async (t) => {
  await t.test("delivers the caption as plain text when every upload fails", async () => {
    await withChat(chatHandler({ failUploadsFor: [".png"] }), async (chat) => {
      const result = await sendMediaMessages({
        space: SPACE,
        mediaRefs: ["/tmp/a.png", "/tmp/b.png"],
        token: "oauth",
        text: "the agent's words must not vanish",
        readFile: memReader({ "a.png": PNG_1X1, "b.png": PNG_1X1 }),
      });
      assert.equal(result.sent, 0);
      assert.equal(result.failed.length, 2);
      const messages = chat.requests.filter(isMessage);
      assert.equal(messages.length, 1, "exactly one fallback text message");
      assert.deepEqual(messages[0].json, { text: "the agent's words must not vanish" });
      assert.equal("attachment" in messages[0].json, false);
    });
  });

  await t.test("the fallback text message respects the thread", async () => {
    await withChat(chatHandler({ failUploadsFor: [".png"] }), async (chat) => {
      await sendMediaMessages({
        space: SPACE,
        mediaRefs: ["/tmp/a.png"],
        token: "oauth",
        text: "caption",
        threadName: `${SPACE}/threads/T9`,
        replyMessageOption: "REPLY_MESSAGE_OR_FAIL",
        readFile: memReader({ "a.png": PNG_1X1 }),
      });
      const msg = chat.requests.filter(isMessage)[0];
      assert.equal(msg.url, `/v1/${SPACE}/messages?messageReplyOption=REPLY_MESSAGE_OR_FAIL`);
      assert.deepEqual(msg.json, { text: "caption", thread: { name: `${SPACE}/threads/T9` } });
    });
  });

  await t.test("sends nothing extra when everything fails and there is no caption", async () => {
    await withChat(chatHandler({ failUploadsFor: [".png"] }), async (chat) => {
      const result = await sendMediaMessages({
        space: SPACE,
        mediaRefs: ["/tmp/a.png"],
        token: "oauth",
        readFile: memReader({ "a.png": PNG_1X1 }),
      });
      assert.equal(result.sent, 0);
      assert.equal(chat.requests.filter(isMessage).length, 0);
    });
  });

  await t.test("no fallback text is sent when the caption already rode on a message", async () => {
    await withChat(chatHandler(), async (chat) => {
      const result = await sendMediaMessages({
        space: SPACE,
        mediaRefs: ["/tmp/a.png"],
        token: "oauth",
        text: "caption",
        readFile: memReader({ "a.png": PNG_1X1 }),
      });
      assert.equal(result.sent, 1);
      assert.equal(chat.requests.filter(isMessage).length, 1, "no duplicate caption message");
    });
  });

  await t.test(
    "sends the caption as plain text when upload succeeds but message creation fails",
    async () => {
      let messageCount = 0;
      await withChat((req) => {
        if (isUpload(req)) {
          return { status: 200, body: { attachmentDataRef: { attachmentUploadToken: "tok" } } };
        }
        if (isMessage(req)) {
          messageCount++;
          if (messageCount === 1) {
            return { status: 500, body: { error: "attachment message rejected" } };
          }
          return { status: 200, body: { name: `${SPACE}/messages/fallback` } };
        }
        return { status: 404, body: {} };
      }, async (chat) => {
        const result = await sendMediaMessages({
          space: SPACE,
          mediaRefs: ["/tmp/a.png"],
          token: "oauth",
          text: "CRITICAL CAPTION",
          readFile: memReader({ "a.png": PNG_1X1 }),
        });
        assert.equal(result.sent, 0);
        assert.equal(result.failed.length, 1);
        assert.match(result.failed[0], /Message create failed \(500\)/);

        const delivered = chat.requests.filter(isMessage);
        assert.equal(delivered.length, 2, "failed attachment post plus plain-text fallback");
        const fallbackSent = delivered.some((r) => r.json?.text === "CRITICAL CAPTION" && !r.json?.attachment);
        assert.equal(fallbackSent, true, "plain-text fallback preserves the caption");
      });
    }
  );

  await t.test("a failing fallback text message is swallowed, not thrown", async () => {
    await withChat(
      (req) => (isUpload(req) ? { status: 500, body: { error: "no" } } : { status: 503, body: { error: "down" } }),
      async () => {
        const result = await sendMediaMessages({
          space: SPACE,
          mediaRefs: ["/tmp/a.png"],
          token: "oauth",
          text: "caption",
          readFile: memReader({ "a.png": PNG_1X1 }),
        });
        assert.equal(result.sent, 0);
        assert.equal(result.failed.length, 1);
      }
    );
  });

  await t.test("the fallback survives the message endpoint being unreachable", async () => {
    const chat = await startMockChat(chatHandler({ failUploadsFor: [".png"] }));
    chat.activate();
    // Point at a closed port so the fallback's fetch rejects at the transport layer.
    await chat.close();
    const result = await sendMediaMessages({
      space: SPACE,
      mediaRefs: ["/tmp/a.png"],
      token: "oauth",
      text: "caption",
      readFile: memReader({ "a.png": PNG_1X1 }),
    });
    assert.equal(result.sent, 0);
    assert.equal(result.failed.length, 1);
  });
});

test("sendMediaMessages — end to end with real files", async (t) => {
  const tmp = makeTempDir("send-e2e");
  t.after(() => tmp.cleanup());

  await t.test("reads from disk and uploads the exact bytes, no readFile override", async () => {
    const png = tmp.file("real.png", PNG_1X1);
    const txt = tmp.file("real.txt", "plain content");
    await withChat(chatHandler(), async (chat) => {
      const result = await sendMediaMessages({
        space: SPACE,
        mediaRefs: [png, txt],
        token: "oauth",
        text: "two real files",
      });
      assert.equal(result.sent, 2);
      assert.deepEqual(result.failed, []);

      const uploads = chat.requests.filter(isUpload).map((r) => parseMultipart(r.raw, r.headers["content-type"]).parts);
      assert.equal(JSON.parse(uploads[0][0].body.toString()).filename, "real.png");
      assert.equal(uploads[0][1].headers["content-type"], "image/png");
      assert.equal(Buffer.compare(uploads[0][1].body, PNG_1X1), 0, "PNG must reach the wire intact");
      assert.equal(uploads[1][1].body.toString(), "plain content");

      const messages = chat.requests.filter(isMessage).map((r) => r.json);
      assert.equal(messages[0].text, "two real files");
      assert.equal("text" in messages[1], false);
    });
  });
});

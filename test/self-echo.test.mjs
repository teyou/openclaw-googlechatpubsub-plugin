/**
 * Regression tests for the self-echo feedback loop.
 *
 * Background: `attachments:upload` only accepts USER OAuth auth, so every
 * attachment this plugin posts is recorded by Google with
 * `sender.type === "HUMAN"` and the OAuth user's id — indistinguishable from a
 * real person by type alone. Before the fix, each upload was re-ingested from
 * Pub/Sub as fresh inbound and triggered another agent run.
 *
 * Observed in production on 2026-09-01:
 *   upload path (user OAuth) -> sender.type=HUMAN, users/100000000000000000001
 *   text path   (bot SA)     -> sender.type=BOT,   users/200000000000000000002
 * 7 spurious agent runs in ~5 minutes.
 *
 * Two independent layers must hold:
 *   1. sender-id suppression  (needs selfUserId resolved)
 *   2. outbound id dedup      (works immediately, covers the first send)
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  loadModuleUnderTest,
  startMockChat,
  okUploadToken,
  PNG_1X1,
} from "./helpers/harness.mjs";

const mod = await loadModuleUnderTest();
const {
  markProcessed,
  isSelfMessage,
  rememberSelfIdentity,
  processedMsgIds,
  sendMediaMessages,
  MAX_DEDUP,
  __setSelfUserId,
  __getSelfUserId,
  __resetDedup,
} = mod;

/** Real ids from the verified production incident. */
const SELF = "users/100000000000000000001"; // synthetic OAuth identity
const BOT = "users/200000000000000000002"; // synthetic bot service account
const HUMAN = "users/999888777666555444333"; // a genuine third party

function reset() {
  __resetDedup();
  __setSelfUserId(null);
}

test("layer 1: sender-id suppression", async (t) => {
  t.beforeEach(reset);

  await t.test("drops a message from our own OAuth identity", () => {
    __setSelfUserId(SELF);
    assert.equal(isSelfMessage({ type: "HUMAN", name: SELF }), true);
  });

  await t.test("still processes a genuine human in the same space", () => {
    __setSelfUserId(SELF);
    assert.equal(isSelfMessage({ type: "HUMAN", name: HUMAN }), false);
  });

  await t.test("does not suppress the bot SA id (already filtered by type)", () => {
    __setSelfUserId(SELF);
    assert.equal(isSelfMessage({ type: "BOT", name: BOT }), false);
  });

  await t.test("is a no-op while selfUserId is unresolved", () => {
    // Must not accidentally match undefined === undefined and eat real traffic.
    assert.equal(__getSelfUserId(), null);
    assert.equal(isSelfMessage({ type: "HUMAN", name: SELF }), false);
    assert.equal(isSelfMessage({ type: "HUMAN", name: HUMAN }), false);
    assert.equal(isSelfMessage({}), false);
    assert.equal(isSelfMessage(undefined), false);
  });
});

test("identity latching", async (t) => {
  t.beforeEach(reset);

  await t.test("latches sender.name from a message we created", () => {
    rememberSelfIdentity({ name: "spaces/S/messages/m1", sender: { name: SELF } });
    assert.equal(__getSelfUserId(), SELF);
  });

  await t.test("first resolution wins and is not overwritten", () => {
    rememberSelfIdentity({ sender: { name: SELF } });
    rememberSelfIdentity({ sender: { name: HUMAN } });
    assert.equal(__getSelfUserId(), SELF);
  });

  await t.test("ignores malformed or missing senders", () => {
    for (const bad of [undefined, {}, { sender: {} }, { sender: { name: "" } }, { sender: { name: "notauser/1" } }]) {
      rememberSelfIdentity(bad);
      assert.equal(__getSelfUserId(), null, `should not latch from ${JSON.stringify(bad)}`);
    }
  });
});

test("layer 2: outbound dedup", async (t) => {
  t.beforeEach(reset);

  await t.test("a recorded outbound id is recognised on arrival", () => {
    markProcessed("spaces/S/messages/abc.abc");
    assert.equal(processedMsgIds.has("spaces/S/messages/abc.abc"), true);
  });

  await t.test("ignores empty/missing ids without polluting the set", () => {
    markProcessed(undefined);
    markProcessed(null);
    markProcessed("");
    assert.equal(processedMsgIds.size, 0);
  });

  await t.test("respects the MAX_DEDUP cap", () => {
    for (let i = 0; i <= MAX_DEDUP + 5; i++) markProcessed(`spaces/S/messages/m${i}`);
    assert.ok(
      processedMsgIds.size <= MAX_DEDUP + 1,
      `dedup set grew unbounded: ${processedMsgIds.size}`
    );
  });
});

test("integration: an upload registers its own id before the echo can arrive", async (t) => {
  t.beforeEach(reset);

  await t.test("sendMediaMessages marks the created message and latches identity", async () => {
    const created = "spaces/TESTSPACE123/messages/upload-message";
    const chat = await startMockChat((req) => {
      if (req.url.includes("attachments:upload")) return okUploadToken();
      // Google reports OUR OAuth identity as the sender — HUMAN, not BOT.
      return { status: 200, body: { name: created, sender: { type: "HUMAN", name: SELF } } };
    });
    chat.activate();
    t.after(() => chat.close());

    const result = await sendMediaMessages({
      space: "spaces/TESTSPACE123",
      mediaRefs: ["/tmp/x.png"],
      token: "tok",
      text: "caption",
      readFile: async () => PNG_1X1,
    });

    assert.equal(result.sent, 1, "upload should succeed");

    // Layer 2 armed immediately: the echo is already known.
    assert.equal(
      processedMsgIds.has(created),
      true,
      "created message id must be deduped before Pub/Sub can echo it"
    );

    // Layer 1 now armed for every subsequent echo.
    assert.equal(__getSelfUserId(), SELF);
    assert.equal(isSelfMessage({ type: "HUMAN", name: SELF }), true);
    assert.equal(isSelfMessage({ type: "HUMAN", name: HUMAN }), false);
  });

  await t.test("caption fallback also registers its id when all uploads fail", async () => {
    const fallback = "spaces/TESTSPACE123/messages/fallback";
    const chat = await startMockChat((req) => {
      if (req.url.includes("attachments:upload")) return { status: 500, body: { error: "boom" } };
      return { status: 200, body: { name: fallback, sender: { type: "HUMAN", name: SELF } } };
    });
    chat.activate();
    t.after(() => chat.close());

    const result = await sendMediaMessages({
      space: "spaces/TESTSPACE123",
      mediaRefs: ["/tmp/x.png"],
      token: "tok",
      text: "words must not be lost",
      readFile: async () => PNG_1X1,
    });

    assert.equal(result.sent, 0, "upload was meant to fail");
    assert.equal(
      processedMsgIds.has(fallback),
      true,
      "plain-text caption fallback must also be deduped"
    );
  });
});

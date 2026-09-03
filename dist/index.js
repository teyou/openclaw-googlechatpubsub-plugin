// index.ts
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, join, extname } from "node:path";
import { createSign, randomUUID } from "node:crypto";
import {
  resolveInboundRouteEnvelopeBuilderWithRuntime
} from "openclaw/plugin-sdk/inbound-envelope";
import {
  createReplyPrefixOptions
} from "openclaw/plugin-sdk/channel-outbound";
var config;
var serviceAccountFile;
var routingTable;
var targetSpaces;
var oauthCache = { token: null, expiresAt: 0 };
var botCache = { token: null, expiresAt: 0 };
var processedMsgIds = /* @__PURE__ */ new Set();
var selfUserId = null;
var lastRenewalCheck = 0;
var subscriptionState = {};
var logger;
var pluginApi;
var pollTimer = null;
var MAX_DEDUP = 500;
function markProcessed(msgName) {
  if (!msgName) return;
  if (processedMsgIds.size > MAX_DEDUP) processedMsgIds.clear();
  processedMsgIds.add(msgName);
}
function isSelfMessage(sender) {
  return Boolean(selfUserId) && sender?.name === selfUserId;
}
function rememberSelfIdentity(created) {
  if (selfUserId) return;
  const name = created?.sender?.name;
  if (typeof name === "string" && name.startsWith("users/")) {
    selfUserId = name;
    logger?.info(`[self] Resolved own Chat identity: ${selfUserId}`);
  }
}
var RENEWAL_INTERVAL = 3e5;
var SUBSCRIPTION_TTL = 14400;
var STATE_FILE_NAME = "gchat-pubsub-subscription-state.json";
var sessionBusy = /* @__PURE__ */ new Set();
var sessionQueue = /* @__PURE__ */ new Map();
var crossDispatchChains = /* @__PURE__ */ new Map();
var CROSS_DISPATCH_TTL_MS = 5 * 60 * 1e3;
function deriveSessionKey(agentId, space, threadName, threadSessionIsolation) {
  const threadId = threadName ? threadName.split("/").pop() : "";
  const peerId = threadSessionIsolation && threadId ? `${space}:thread:${threadId}` : space;
  return `agent:${agentId}:googlechatpubsub:group:${peerId}`.toLowerCase();
}
async function dispatchOrQueue(msg) {
  const sessionKey = deriveSessionKey(
    msg.agent.agentId,
    msg.space,
    msg.threadName,
    msg.threadSessionIsolation
  );
  if (sessionBusy.has(sessionKey)) {
    const queue = sessionQueue.get(sessionKey) || [];
    queue.push(msg);
    sessionQueue.set(sessionKey, queue);
    logger.info(`\u{1F4E5} [${msg.agent.agentId}] Queued message for busy session ${sessionKey} (queue depth: ${queue.length})`);
    return;
  }
  sessionBusy.add(sessionKey);
  try {
    await processMessageInPipeline({
      agentId: msg.agent.agentId,
      space: msg.space,
      spaceDisplayName: msg.spaceDisplayName,
      senderId: msg.senderId,
      senderName: msg.senderName,
      text: msg.text,
      messageName: msg.messageName,
      threadName: msg.threadName,
      eventTime: msg.eventTime,
      replyInThread: msg.replyInThread,
      threadSessionIsolation: msg.threadSessionIsolation,
      attachmentPaths: msg.attachmentPaths,
      crossDispatchChainKey: msg.crossDispatchChainKey
    });
    logger.info(`\u2705 [${msg.agent.agentId}] Pipeline complete for ${msg.space}`);
  } catch (err) {
    logger.error(`[${msg.agent.agentId}] Pipeline error: ${err.message}`);
  } finally {
    sessionBusy.delete(sessionKey);
  }
  await drainQueue(sessionKey);
}
async function drainQueue(sessionKey) {
  const queue = sessionQueue.get(sessionKey);
  if (!queue || queue.length === 0) {
    sessionQueue.delete(sessionKey);
    return;
  }
  const next = queue.shift();
  if (queue.length === 0) {
    sessionQueue.delete(sessionKey);
  }
  logger.info(`\u{1F4E4} [${next.agent.agentId}] Draining queued message for ${sessionKey} (remaining: ${queue?.length ?? 0})`);
  sessionBusy.add(sessionKey);
  try {
    await processMessageInPipeline({
      agentId: next.agent.agentId,
      space: next.space,
      spaceDisplayName: next.spaceDisplayName,
      senderId: next.senderId,
      senderName: next.senderName,
      text: next.text,
      messageName: next.messageName,
      threadName: next.threadName,
      eventTime: next.eventTime,
      replyInThread: next.replyInThread,
      threadSessionIsolation: next.threadSessionIsolation,
      attachmentPaths: next.attachmentPaths,
      crossDispatchChainKey: next.crossDispatchChainKey
    });
    logger.info(`\u2705 [${next.agent.agentId}] Queued pipeline complete for ${next.space}`);
  } catch (err) {
    logger.error(`[${next.agent.agentId}] Queued pipeline error: ${err.message}`);
  } finally {
    sessionBusy.delete(sessionKey);
  }
  await drainQueue(sessionKey);
}
async function crossAgentDispatch(params) {
  const {
    replyText,
    sourceAgentId,
    space,
    spaceDisplayName,
    senderName,
    messageName,
    threadName,
    replyInThread,
    threadSessionIsolation,
    chainKey
  } = params;
  const entry = routingTable.get(space);
  if (!entry || !entry.pattern) return;
  let chain = crossDispatchChains.get(chainKey);
  if (!chain) {
    chain = /* @__PURE__ */ new Set();
    crossDispatchChains.set(chainKey, chain);
    setTimeout(() => crossDispatchChains.delete(chainKey), CROSS_DISPATCH_TTL_MS);
  }
  const matches = replyText.matchAll(new RegExp(entry.pattern.source, "gi"));
  const toDispatch = [];
  for (const m of matches) {
    const kw = m[1].toLowerCase();
    const agent = entry.keywordAgents.get(kw);
    if (!agent) continue;
    if (agent.agentId === sourceAgentId) continue;
    if (chain.has(agent.agentId)) continue;
    if (agent.alwaysListen) continue;
    toDispatch.push(agent);
    chain.add(agent.agentId);
    logger.info(`\u{1F500} Cross-dispatch: ${sourceAgentId} mentioned '${kw}' \u2192 dispatching to ${agent.agentId}`);
  }
  if (!toDispatch.length) return;
  chain.add(sourceAgentId);
  const contextText = `[via ${senderName}] ${replyText}`;
  const dispatchPromises = [];
  for (const agent of toDispatch) {
    logger.info(`\u{1F500} [${agent.agentId}] Cross-dispatch from ${sourceAgentId} in ${space}`);
    dispatchPromises.push(
      dispatchOrQueue({
        agent,
        space,
        spaceDisplayName,
        senderId: `bot:${sourceAgentId}`,
        senderName,
        text: contextText,
        messageName: messageName + ":xdispatch:" + agent.agentId,
        threadName,
        eventTime: (/* @__PURE__ */ new Date()).toISOString(),
        replyInThread,
        threadSessionIsolation,
        attachmentPaths: [],
        crossDispatchChainKey: chainKey
      })
    );
  }
  await Promise.all(dispatchPromises);
}
async function httpJson(url, opts = {}) {
  const { method = "GET", headers = {}, body, timeoutMs = 15e3 } = opts;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      body: body ? JSON.stringify(body) : void 0,
      signal: controller.signal
    });
    clearTimeout(timer);
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    return { status: res.status, data };
  } catch (e) {
    clearTimeout(timer);
    if (e.name === "AbortError") {
      throw new Error(`HTTP request timed out after ${timeoutMs}ms: ${method} ${url}`);
    }
    throw e;
  }
}
async function httpForm(url, params) {
  const body = new URLSearchParams(params).toString();
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  return res.json();
}
async function getOAuthToken() {
  const now = Date.now() / 1e3;
  if (oauthCache.token && now < oauthCache.expiresAt - 60) {
    return oauthCache.token;
  }
  const tokensFile = config.oauth.tokensFile;
  let tokens;
  try {
    tokens = JSON.parse(readFileSync(tokensFile, "utf-8"));
  } catch {
    throw new Error(`Cannot read OAuth tokens from ${tokensFile}`);
  }
  const result = await httpForm("https://oauth2.googleapis.com/token", {
    client_id: config.oauth.clientId,
    client_secret: config.oauth.clientSecret,
    refresh_token: tokens.refresh_token,
    grant_type: "refresh_token"
  });
  if (!result.access_token) {
    throw new Error(`OAuth refresh failed: ${JSON.stringify(result)}`);
  }
  oauthCache.token = result.access_token;
  oauthCache.expiresAt = now + (result.expires_in || 3600);
  tokens.access_token = result.access_token;
  if (result.refresh_token) tokens.refresh_token = result.refresh_token;
  writeFileSync(tokensFile, JSON.stringify(tokens, null, 2));
  logger.info(`OAuth token refreshed (expires in ${result.expires_in}s)`);
  return result.access_token;
}
async function getBotToken() {
  const now = Date.now() / 1e3;
  if (botCache.token && now < botCache.expiresAt - 60) {
    return botCache.token;
  }
  const sa = JSON.parse(readFileSync(serviceAccountFile, "utf-8"));
  const iat = Math.floor(now);
  const exp = iat + 3600;
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      iss: sa.client_email,
      scope: "https://www.googleapis.com/auth/chat.bot https://www.googleapis.com/auth/chat.messages.reactions",
      aud: "https://oauth2.googleapis.com/token",
      iat,
      exp
    })
  ).toString("base64url");
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  const signature = signer.sign(sa.private_key, "base64url");
  const jwt = `${header}.${payload}.${signature}`;
  const result = await httpForm("https://oauth2.googleapis.com/token", {
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: jwt
  });
  botCache.token = result.access_token;
  botCache.expiresAt = now + 3e3;
  logger.info("Bot SA token minted (valid ~50 min)");
  return result.access_token;
}
function buildRoutingTable(bindings) {
  const table = /* @__PURE__ */ new Map();
  for (const binding of bindings) {
    const keywordAgents = /* @__PURE__ */ new Map();
    const alwaysListen = [];
    const keywords = [];
    for (const agent of binding.agents) {
      const kw = (agent.mentionKeyword || "").toLowerCase();
      if (kw) {
        keywordAgents.set(kw, agent);
        keywords.push(kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
      }
      if (agent.alwaysListen) {
        alwaysListen.push(agent);
      }
    }
    let pattern = null;
    if (keywords.length) {
      pattern = new RegExp(
        `(?:^|[\\s@<])(${keywords.join("|")})(?:[\\s>,.:!?'")}]|$)`,
        "i"
      );
    }
    const replyInThread = binding.replyInThread ?? false;
    const threadSessionIsolation = binding.threadSessionIsolation ?? replyInThread;
    table.set(binding.space, { keywordAgents, alwaysListen, pattern, replyInThread, threadSessionIsolation });
  }
  return table;
}
function routeMessage(text, space) {
  const entry = routingTable.get(space);
  if (!entry) return [];
  const matched = [];
  const seen = /* @__PURE__ */ new Set();
  for (const agent of entry.alwaysListen) {
    if (!seen.has(agent.agentId)) {
      matched.push(agent);
      seen.add(agent.agentId);
    }
  }
  if (entry.pattern) {
    const matches = text.matchAll(new RegExp(entry.pattern.source, "gi"));
    for (const m of matches) {
      const kw = m[1].toLowerCase();
      const agent = entry.keywordAgents.get(kw);
      if (agent && !seen.has(agent.agentId)) {
        matched.push(agent);
        seen.add(agent.agentId);
        logger.info(`\u{1F3AF} Keyword '${kw}' \u2192 agent '${agent.agentId}'`);
      }
    }
  }
  if (matched.length) {
    logger.info(`\u{1F4E8} Routed to ${matched.length} agent(s): ${matched.map((a) => a.agentId).join(", ")}`);
  }
  return matched;
}
async function pullMessages(token) {
  const sub = `projects/${config.projectId}/subscriptions/${config.subscriptionId}`;
  const { data } = await httpJson(
    `https://pubsub.googleapis.com/v1/${sub}:pull`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: { maxMessages: 10, returnImmediately: true }
    }
  );
  return data.receivedMessages || [];
}
async function ackMessages(token, ackIds) {
  if (!ackIds.length) return;
  const sub = `projects/${config.projectId}/subscriptions/${config.subscriptionId}`;
  await httpJson(`https://pubsub.googleapis.com/v1/${sub}:acknowledge`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: { ackIds }
  });
}
function resolveStateDir() {
  return pluginApi?.runtime?.state?.resolveStateDir?.() || resolve(process.cwd(), "..");
}
function loadSubState() {
  const stateDir = resolveStateDir();
  const fp = resolve(stateDir, STATE_FILE_NAME);
  if (existsSync(fp)) {
    try {
      return JSON.parse(readFileSync(fp, "utf-8"));
    } catch {
    }
  }
  return { subscriptions: {} };
}
function saveSubState(state) {
  const stateDir = resolveStateDir();
  const fp = resolve(stateDir, STATE_FILE_NAME);
  writeFileSync(fp, JSON.stringify(state, null, 2));
}
async function ensureSubscription(space, token) {
  const topic = `projects/${config.projectId}/topics/${config.topicId}`;
  const now = Date.now() / 1e3;
  const bufferSec = (config.renewalBufferMinutes ?? 30) * 60;
  const existing = subscriptionState.subscriptions?.[space];
  if (existing && existing.expiresAt > now + bufferSec) {
    if (existing.name) {
      try {
        const { status: checkStatus, data: checkData } = await httpJson(
          `https://workspaceevents.googleapis.com/v1/${existing.name}`,
          { method: "GET", headers: { Authorization: `Bearer ${token}` } }
        );
        if (checkStatus < 400 && checkData?.state === "ACTIVE") {
          if (checkData.expireTime) {
            const realExpiry = new Date(checkData.expireTime).getTime() / 1e3;
            if (realExpiry !== existing.expiresAt) {
              existing.expiresAt = realExpiry;
              saveSubState(subscriptionState);
              logger.info(`Updated ${space} expiry from API: ${checkData.expireTime}`);
            }
          }
          return;
        }
        logger.warn(
          `Subscription for ${space} state=${checkData?.state ?? checkStatus} \u2014 recreating`
        );
      } catch (e) {
        logger.warn(`Subscription verify failed for ${space}: ${e.message} \u2014 recreating`);
      }
    }
  }
  logger.info(
    `Creating/renewing Workspace Events subscription for ${space}`
  );
  const body = {
    targetResource: `//chat.googleapis.com/${space}`,
    eventTypes: ["google.workspace.chat.message.v1.created"],
    notificationEndpoint: { pubsubTopic: topic },
    payloadOptions: { includeResource: true }
  };
  const { status, data } = await httpJson(
    "https://workspaceevents.googleapis.com/v1/subscriptions",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body
    }
  );
  if (status === 409) {
    logger.info(`Subscription already exists for ${space} \u2014 fetching real expiry`);
    try {
      const filter = encodeURIComponent(`target_resource="//chat.googleapis.com/${space}"`);
      const { status: listSt, data: listData } = await httpJson(
        `https://workspaceevents.googleapis.com/v1/subscriptions?filter=${filter}`,
        { method: "GET", headers: { Authorization: `Bearer ${token}` } }
      );
      const sub = listData?.subscriptions?.[0];
      if (sub) {
        const realExpiry = sub.expireTime ? new Date(sub.expireTime).getTime() / 1e3 : now + SUBSCRIPTION_TTL;
        subscriptionState.subscriptions ??= {};
        subscriptionState.subscriptions[space] = {
          space,
          name: sub.name,
          expiresAt: realExpiry
        };
        saveSubState(subscriptionState);
        logger.info(`Found existing subscription ${sub.name} (expires ${sub.expireTime || "~4h"})`);
        return;
      }
    } catch (e) {
      logger.warn(`Failed to list subscriptions for ${space}: ${e.message}`);
    }
    subscriptionState.subscriptions ??= {};
    subscriptionState.subscriptions[space] = {
      space,
      expiresAt: now + SUBSCRIPTION_TTL
    };
    saveSubState(subscriptionState);
    return;
  }
  if (status >= 400) {
    logger.error(
      `Failed to create subscription for ${space}: ${status} ${JSON.stringify(data).slice(0, 300)}`
    );
    return;
  }
  subscriptionState.subscriptions ??= {};
  subscriptionState.subscriptions[space] = {
    space,
    name: data.name,
    expiresAt: now + SUBSCRIPTION_TTL
  };
  saveSubState(subscriptionState);
  logger.info(
    `Workspace Events subscription created for ${space} (expires in ~4h)`
  );
}
async function checkAndRenewAll() {
  const token = await getOAuthToken();
  for (const space of targetSpaces) {
    try {
      await ensureSubscription(space, token);
    } catch (e) {
      logger.error(`Subscription check failed for ${space}: ${e.message}`);
    }
  }
}
async function downloadAttachments(attachments, oauthToken) {
  if (!attachments || attachments.length === 0) return [];
  const stateDir = resolveStateDir();
  const mediaDir = join(stateDir, "media", "inbound");
  try {
    mkdirSync(mediaDir, { recursive: true });
  } catch {
  }
  const results = [];
  for (const att of attachments) {
    const resourceName = att.attachmentDataRef?.resourceName;
    const attachmentPath = resourceName || att.name;
    if (!attachmentPath) {
      logger.warn(`[attachment] No resourceName or att.name \u2014 skipping: ${JSON.stringify(att).slice(0, 200)}`);
      continue;
    }
    const mimeType = att.contentType || "application/octet-stream";
    const originalName = att.contentName || attachmentPath.split("/").pop() || "attachment";
    let ext = extname(originalName);
    if (!ext) {
      const mimeToExt = {
        "image/jpeg": ".jpg",
        "image/png": ".png",
        "image/gif": ".gif",
        "image/webp": ".webp",
        "application/pdf": ".pdf",
        "text/plain": ".txt",
        "text/csv": ".csv",
        "application/zip": ".zip",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx"
      };
      ext = mimeToExt[mimeType] || ".bin";
    }
    const filename = `${randomUUID()}${ext}`;
    const localPath = join(mediaDir, filename);
    try {
      const downloadUrl = `https://chat.googleapis.com/v1/media/${attachmentPath}?alt=media`;
      logger.info(`[attachment] Downloading ${attachmentPath} \u2192 ${filename}`);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3e4);
      let resp;
      try {
        resp = await fetch(downloadUrl, {
          method: "GET",
          headers: { Authorization: `Bearer ${oauthToken}` },
          signal: controller.signal
        });
      } finally {
        clearTimeout(timer);
      }
      if (!resp.ok) {
        const errText = await resp.text().catch(() => "");
        logger.warn(`[attachment] Download failed (${resp.status}): ${errText.slice(0, 200)}`);
        continue;
      }
      const buffer = Buffer.from(await resp.arrayBuffer());
      const { writeFileSync: wfs } = await import("node:fs");
      wfs(localPath, buffer);
      logger.info(`[attachment] Saved ${buffer.length} bytes \u2192 ${localPath}`);
      results.push({ localPath, mimeType, filename });
    } catch (err) {
      logger.error(`[attachment] Download error for ${attachmentPath}: ${err.message}`);
    }
  }
  return results;
}
var MAX_UPLOAD_BYTES = 200 * 1024 * 1024;
var EXT_TO_MIME = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
  ".zip": "application/zip",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation"
};
function guessMimeType(filename) {
  return EXT_TO_MIME[extname(filename).toLowerCase()] || "application/octet-stream";
}
async function resolveOutboundMedia(ref, opts = {}) {
  const trimmed = String(ref || "").trim();
  if (!trimmed) throw new Error("Empty media reference");
  if (/^https?:\/\//i.test(trimmed)) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6e4);
    let resp;
    try {
      resp = await fetch(trimmed, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!resp.ok) {
      throw new Error(`Fetch media failed (${resp.status}) for ${trimmed}`);
    }
    const buffer2 = Buffer.from(await resp.arrayBuffer());
    let filename2 = "";
    const disposition = resp.headers.get("content-disposition") || "";
    const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
    if (match) filename2 = decodeURIComponent(match[1]);
    if (!filename2) {
      try {
        filename2 = decodeURIComponent(new URL(trimmed).pathname.split("/").pop() || "");
      } catch {
      }
    }
    if (!filename2) filename2 = "attachment";
    const headerMime = (resp.headers.get("content-type") || "").split(";")[0].trim();
    const mimeType = headerMime || guessMimeType(filename2);
    if (!extname(filename2)) {
      const ext = Object.entries(EXT_TO_MIME).find(([, m]) => m === mimeType)?.[0];
      if (ext) filename2 += ext;
    }
    return { buffer: buffer2, filename: filename2, mimeType };
  }
  const localPath = trimmed.startsWith("file://") ? decodeURIComponent(new URL(trimmed).pathname) : resolve(trimmed);
  const buffer = opts.readFile ? await opts.readFile(localPath) : readFileSync(localPath);
  const filename = localPath.split("/").pop() || "attachment";
  return { buffer, filename, mimeType: guessMimeType(filename) };
}
async function uploadAttachment(params) {
  const { space, media, token, timeoutMs = 12e4 } = params;
  if (media.buffer.length === 0) {
    throw new Error(`Refusing to upload empty file: ${media.filename}`);
  }
  if (media.buffer.length > MAX_UPLOAD_BYTES) {
    throw new Error(
      `File ${media.filename} is ${(media.buffer.length / 1024 / 1024).toFixed(1)} MB, over the Google Chat 200 MB limit`
    );
  }
  const boundary = `openclaw-${randomUUID()}`;
  const head = Buffer.from(
    `--${boundary}\r
Content-Type: application/json; charset=UTF-8\r
\r
${JSON.stringify({ filename: media.filename })}\r
--${boundary}\r
Content-Type: ${media.mimeType}\r
\r
`,
    "utf8"
  );
  const tail = Buffer.from(`\r
--${boundary}--\r
`, "utf8");
  const body = Buffer.concat([head, media.buffer, tail]);
  const url = `https://chat.googleapis.com/upload/v1/${space}/attachments:upload?uploadType=multipart`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let resp;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": `multipart/related; boundary=${boundary}`
      },
      body,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`Attachment upload failed (${resp.status}): ${text.slice(0, 300)}`);
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Attachment upload returned non-JSON: ${text.slice(0, 200)}`);
  }
  const uploadToken = data?.attachmentDataRef?.attachmentUploadToken;
  if (!uploadToken) {
    throw new Error(`Attachment upload missing attachmentUploadToken: ${text.slice(0, 200)}`);
  }
  logger.info(
    `[upload] ${media.filename} (${media.mimeType}, ${media.buffer.length} bytes) \u2192 token acquired`
  );
  return uploadToken;
}
async function sendMediaMessages(params) {
  const {
    space,
    mediaRefs,
    token,
    text,
    threadName,
    replyMessageOption = "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD",
    readFile
  } = params;
  const failed = [];
  const messageIds = [];
  let sent = 0;
  let captionPending = text?.trim() || "";
  for (const ref of mediaRefs) {
    try {
      const media = await resolveOutboundMedia(ref, { readFile });
      const uploadToken = await uploadAttachment({ space, media, token });
      const msgBody = {
        attachment: [{ attachmentDataRef: { attachmentUploadToken: uploadToken } }]
      };
      if (captionPending) {
        msgBody.text = captionPending;
      }
      let url = `https://chat.googleapis.com/v1/${space}/messages`;
      if (threadName) {
        msgBody.thread = { name: threadName };
        url += `?messageReplyOption=${replyMessageOption}`;
      }
      const { status, data } = await httpJson(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: msgBody,
        timeoutMs: 6e4
      });
      if (status >= 400) {
        throw new Error(`Message create failed (${status}): ${JSON.stringify(data).slice(0, 300)}`);
      }
      captionPending = "";
      sent++;
      if (data?.name) messageIds.push(data.name);
      markProcessed(data?.name);
      rememberSelfIdentity(data);
      logger.info(`[upload] Sent attachment ${media.filename} \u2192 ${space}`);
    } catch (err) {
      logger.error(`[upload] Failed for ${ref}: ${err.message}`);
      failed.push(`${ref}: ${err.message}`);
    }
  }
  if (captionPending && sent === 0) {
    const msgBody = { text: captionPending };
    let url = `https://chat.googleapis.com/v1/${space}/messages`;
    if (threadName) {
      msgBody.thread = { name: threadName };
      url += `?messageReplyOption=${replyMessageOption}`;
    }
    await httpJson(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: msgBody
    }).then(({ data }) => {
      markProcessed(data?.name);
      rememberSelfIdentity(data);
    }).catch(() => {
    });
  }
  return { sent, failed, messageIds };
}
async function processMessageInPipeline(params) {
  const {
    agentId,
    space,
    spaceDisplayName,
    senderId,
    senderName,
    text,
    messageName,
    threadName,
    eventTime,
    replyInThread,
    threadSessionIsolation,
    attachmentPaths = [],
    crossDispatchChainKey
  } = params;
  const chainKey = crossDispatchChainKey || `${threadName || space}:${messageName}:${Date.now()}`;
  const deliveredChunks = [];
  const api = pluginApi;
  const cfg = api.config;
  const runtime = api.runtime;
  const effectiveThreadId = threadName || "";
  const peerId = threadSessionIsolation && effectiveThreadId ? `${space}:thread:${effectiveThreadId.split("/").pop()}` : space;
  const { route, buildEnvelope } = resolveInboundRouteEnvelopeBuilderWithRuntime({
    cfg,
    channel: "googlechatpubsub",
    accountId: agentId,
    peer: {
      kind: "group",
      id: peerId
    },
    runtime: runtime.channel,
    sessionStore: cfg.session?.store
  });
  logger.info(`\u{1F511} Session key: ${route.sessionKey} (agent=${agentId}, threadIsolation=${threadSessionIsolation}, thread=${effectiveThreadId || "none"})`);
  const fromLabel = spaceDisplayName || `space:${space}`;
  const { storePath, body } = buildEnvelope({
    channel: "Google Chat",
    from: fromLabel,
    timestamp: eventTime ? Date.parse(eventTime) : void 0,
    body: text
  });
  const ctxPayload = runtime.channel.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: text,
    RawBody: text,
    CommandBody: text,
    From: `googlechatpubsub:${senderId}`,
    To: `googlechatpubsub:${space}`,
    SessionKey: route.sessionKey,
    AccountId: agentId,
    ChatType: "channel",
    ConversationLabel: fromLabel,
    SenderName: senderName || void 0,
    SenderId: senderId,
    WasMentioned: false,
    CommandAuthorized: true,
    Provider: "googlechatpubsub",
    Surface: "googlechat",
    MessageSid: messageName,
    MessageSidFull: messageName,
    ReplyToId: threadName || void 0,
    ReplyToIdFull: threadName || void 0,
    GroupSpace: spaceDisplayName || void 0,
    OriginatingChannel: "googlechatpubsub",
    OriginatingTo: `googlechatpubsub:${space}`,
    ...attachmentPaths.length > 0 && {
      MediaPaths: attachmentPaths,
      // local file paths → sets path: value in normalizeAttachments
      MediaUrls: attachmentPaths
      // also set for compat/dedup logic
    }
  });
  void runtime.channel.session.recordSessionMetaFromInbound({
    storePath,
    sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
    ctx: ctxPayload
  }).catch((err) => {
    logger.error(
      `googlechatpubsub: failed updating session meta: ${String(err)}`
    );
  });
  let replyThreadName = threadName;
  let replyMessageOption = "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD";
  if (replyInThread) {
    if (!threadName) {
      replyThreadName = messageName ? `${space}/threads/${messageName.split("/").pop()}` : "";
      replyMessageOption = "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD";
      logger.info(`\u{1F9F5} replyInThread: creating new thread on message ${messageName}`);
    } else {
      replyMessageOption = "REPLY_MESSAGE_OR_FAIL";
      logger.info(`\u{1F9F5} replyInThread: continuing in existing thread ${threadName}`);
    }
  }
  const silentReply = config.silentReply !== false;
  let typingMessageName;
  if (!silentReply) {
    try {
      const botToken = await getBotToken();
      const typingBody = { text: "_typing..._" };
      if (replyInThread && replyThreadName) {
        typingBody.thread = { name: replyThreadName };
      } else if (threadName) {
        typingBody.thread = { name: threadName };
      }
      const typingUrl = replyInThread && replyThreadName ? `https://chat.googleapis.com/v1/${space}/messages?messageReplyOption=${replyMessageOption}` : `https://chat.googleapis.com/v1/${space}/messages`;
      logger.info(`\u23F3 Sending typing indicator to ${space} (thread: ${replyThreadName || threadName || "none"}, replyInThread: ${replyInThread})`);
      const result = await httpJson(typingUrl, {
        method: "POST",
        headers: { Authorization: `Bearer ${botToken}` },
        body: typingBody
      });
      logger.info(`\u23F3 Typing indicator result: status=${result.status} name=${result.data?.name || "none"}`);
      if (result.status < 400 && result.data?.name) {
        typingMessageName = result.data.name;
        if (result.data?.thread?.name && !replyThreadName) {
          replyThreadName = result.data.thread.name;
        }
      } else {
        logger.warn(`Typing indicator failed: ${result.status} ${JSON.stringify(result.data).slice(0, 200)}`);
      }
    } catch (err) {
      logger.warn(`Typing indicator exception: ${err.message}`);
    }
  } else {
    logger.info(`\u{1F507} silentReply=true \u2014 skipping typing indicator`);
  }
  const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
    cfg,
    agentId: route.agentId,
    channel: "googlechatpubsub",
    accountId: agentId
  });
  await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg,
    dispatcherOptions: {
      ...prefixOptions,
      deliver: async (payload, info) => {
        logger.info(`\u{1F4E4} deliver called! kind=${info?.kind || "?"} text=${(payload.text || "").slice(0, 100)} mediaUrls=${payload.mediaUrls?.length || 0}`);
        const botToken = await getBotToken();
        const replyText = payload.text?.trim();
        const mediaRefs = [
          ...payload.mediaUrls || [],
          ...payload.mediaUrl ? [payload.mediaUrl] : []
        ].filter((m) => Boolean(m && String(m).trim()));
        const uniqueMediaRefs = [...new Set(mediaRefs)];
        if (uniqueMediaRefs.length > 0) {
          const effectiveThread = replyInThread ? replyThreadName : threadName;
          if (typingMessageName) {
            await httpJson(`https://chat.googleapis.com/v1/${typingMessageName}`, {
              method: "DELETE",
              headers: { Authorization: `Bearer ${botToken}` }
            }).catch(() => {
            });
            typingMessageName = void 0;
          }
          if (replyText) deliveredChunks.push(replyText);
          const result = await sendMediaMessages({
            space,
            mediaRefs: uniqueMediaRefs,
            token: await getOAuthToken(),
            text: replyText,
            threadName: effectiveThread,
            replyMessageOption
          });
          logger.info(
            `\u{1F4CE} Media delivery: ${result.sent}/${uniqueMediaRefs.length} sent` + (result.failed.length ? ` | failures: ${result.failed.join("; ").slice(0, 300)}` : "")
          );
          return;
        }
        if (!replyText) return;
        deliveredChunks.push(replyText);
        const chunkLimit = 4e3;
        const chunks = [];
        if (replyText.length <= chunkLimit) {
          chunks.push(replyText);
        } else {
          let remaining = replyText;
          while (remaining.length > 0) {
            if (remaining.length <= chunkLimit) {
              chunks.push(remaining);
              break;
            }
            let cut = remaining.lastIndexOf("\n", chunkLimit);
            if (cut <= 0) cut = chunkLimit;
            chunks.push(remaining.slice(0, cut));
            remaining = remaining.slice(cut).trimStart();
          }
        }
        for (let i = 0; i < chunks.length; i++) {
          const chunk = chunks[i];
          try {
            if (i === 0 && typingMessageName) {
              logger.info(`\u{1F4DD} PATCHing typing message: ${typingMessageName}`);
              const patchResult = await httpJson(
                `https://chat.googleapis.com/v1/${typingMessageName}?updateMask=text`,
                {
                  method: "PATCH",
                  headers: { Authorization: `Bearer ${botToken}` },
                  body: { text: chunk }
                }
              );
              if (patchResult.status >= 400) {
                logger.warn(`PATCH failed (${patchResult.status}), falling back to POST: ${JSON.stringify(patchResult.data).slice(0, 200)}`);
                const msgBody = { text: chunk };
                let url = `https://chat.googleapis.com/v1/${space}/messages`;
                const effectiveThread = replyInThread ? replyThreadName : threadName;
                if (effectiveThread) {
                  msgBody.thread = { name: effectiveThread };
                  url += `?messageReplyOption=${replyMessageOption}`;
                }
                const postResult = await httpJson(url, {
                  method: "POST",
                  headers: { Authorization: `Bearer ${botToken}` },
                  body: msgBody
                });
                logger.info(`POST fallback result: ${postResult.status}`);
              } else {
                logger.info(`\u2705 PATCH succeeded`);
              }
              typingMessageName = void 0;
            } else {
              const msgBody = { text: chunk };
              let url = `https://chat.googleapis.com/v1/${space}/messages`;
              const effectiveThread = replyInThread ? replyThreadName : threadName;
              if (effectiveThread) {
                msgBody.thread = { name: effectiveThread };
                url += `?messageReplyOption=${replyMessageOption}`;
              }
              const postResult = await httpJson(url, {
                method: "POST",
                headers: { Authorization: `Bearer ${botToken}` },
                body: msgBody
              });
              logger.info(`\u{1F4E8} POST result: ${postResult.status}`);
            }
          } catch (err) {
            logger.error(`Chat API reply failed: ${err.message}`);
          }
        }
      },
      onSkip: (payload, info) => {
        logger.warn(`\u23ED\uFE0F Reply skipped: kind=${info?.kind} reason=${info?.reason} text=${(payload?.text || "").slice(0, 100)}`);
      },
      onHeartbeatStrip: () => {
        logger.info(`\u{1F493} Heartbeat strip triggered`);
      },
      onError: (err, info) => {
        logger.error(
          `googlechatpubsub reply ${info?.kind || "?"} failed: ${String(err)}`
        );
        if (typingMessageName) {
          getBotToken().then(
            (t) => httpJson(
              `https://chat.googleapis.com/v1/${typingMessageName}`,
              {
                method: "DELETE",
                headers: { Authorization: `Bearer ${t}` }
              }
            )
          ).catch(() => {
          });
        }
      }
    },
    replyOptions: {
      onModelSelected
    }
  });
  if (typingMessageName) {
    logger.info(`\u{1F9F9} Cleaning up orphaned typing message: ${typingMessageName}`);
    try {
      const cleanupToken = await getBotToken();
      await httpJson(`https://chat.googleapis.com/v1/${typingMessageName}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${cleanupToken}` }
      });
      logger.info(`\u2705 Orphaned typing message deleted`);
    } catch (err) {
      logger.error(`Failed to delete orphaned typing message: ${err.message}`);
    }
  }
  if (config.crossAgentDispatch && deliveredChunks.length > 0) {
    const fullReply = deliveredChunks.join("\n");
    try {
      await crossAgentDispatch({
        replyText: fullReply,
        sourceAgentId: agentId,
        space,
        spaceDisplayName,
        senderName: `${agentId} agent`,
        messageName,
        threadName: threadName || "",
        replyInThread,
        threadSessionIsolation,
        chainKey
      });
    } catch (err) {
      logger.error(`Cross-agent dispatch error: ${err.message}`);
    }
  }
}
async function sendReaction(oauthToken, messageName, emoji = "\u23F3") {
  const url = `https://chat.googleapis.com/v1/${messageName}/reactions`;
  const { status, data } = await httpJson(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${oauthToken}` },
    body: { emoji: { unicode: emoji } }
  });
  if (status >= 400) {
    logger.warn(
      `Reaction failed (${status}): ${JSON.stringify(data).slice(0, 300)}`
    );
    return void 0;
  } else {
    logger.info(`\u23F3 Reacted to ${messageName} (reaction: ${data?.name})`);
    return data?.name;
  }
}
async function pollOnce() {
  try {
    if (Date.now() - lastRenewalCheck > RENEWAL_INTERVAL) {
      await checkAndRenewAll();
      lastRenewalCheck = Date.now();
    }
    const oauthToken = await getOAuthToken();
    const messages = await pullMessages(oauthToken);
    if (!messages.length) return;
    logger.info(`Pulled ${messages.length} message(s)`);
    await ackMessages(
      oauthToken,
      messages.map((m) => m.ackId)
    );
    for (const msg of messages) {
      const raw = msg.message?.data;
      if (!raw) continue;
      let data;
      try {
        data = JSON.parse(Buffer.from(raw, "base64").toString());
      } catch {
        continue;
      }
      const chatMsg = data.message;
      if (!chatMsg) continue;
      const msgName = chatMsg.name || "";
      if (msgName && processedMsgIds.has(msgName)) continue;
      const sender = chatMsg.sender || {};
      if (sender.type !== "HUMAN") continue;
      if (isSelfMessage(sender)) {
        markProcessed(msgName);
        continue;
      }
      const space = chatMsg.space?.name || "";
      if (!targetSpaces.has(space)) continue;
      const text = (chatMsg.text || "").trim();
      const rawAttachments = chatMsg.attachment || chatMsg.attachments || [];
      if (!text && rawAttachments.length === 0) continue;
      const displayName = sender.displayName || sender.name || "?";
      logger.info(`\u{1F4E9} [${space}] ${displayName}: ${text.slice(0, 120)}${rawAttachments.length ? ` [${rawAttachments.length} attachment(s)]` : ""}`);
      const matched = text ? routeMessage(text, space) : (() => {
        const entry = routingTable.get(space);
        return entry ? [...entry.alwaysListen] : [];
      })();
      if (!matched.length) {
        markProcessed(msgName);
        continue;
      }
      const routingEntry = routingTable.get(space);
      const spaceReplyInThread = routingEntry?.replyInThread ?? false;
      const spaceThreadIsolation = routingEntry?.threadSessionIsolation ?? spaceReplyInThread;
      let pendingReactionName;
      if (msgName) {
        pendingReactionName = await sendReaction(oauthToken, msgName).catch(() => void 0);
      }
      let downloadedPaths = [];
      if (rawAttachments.length > 0) {
        try {
          const downloaded = await downloadAttachments(rawAttachments, oauthToken);
          downloadedPaths = downloaded.map((d) => d.localPath);
          if (downloadedPaths.length > 0) {
            logger.info(`\u{1F4CE} Downloaded ${downloadedPaths.length}/${rawAttachments.length} attachment(s)`);
          }
        } catch (err) {
          logger.error(`Attachment download error: ${err.message}`);
        }
      }
      const dispatchPromises = [];
      for (const agent of matched) {
        logger.info(
          `\u{1F916} [${agent.agentId}] Dispatching for ${space} (replyInThread=${spaceReplyInThread}, threadIsolation=${spaceThreadIsolation})`
        );
        dispatchPromises.push(
          dispatchOrQueue({
            agent,
            space,
            spaceDisplayName: chatMsg.space?.displayName || `space:${space}`,
            senderId: sender.name || "",
            senderName: displayName,
            text,
            messageName: msgName,
            threadName: chatMsg.thread?.name || "",
            eventTime: data.eventTime || chatMsg.createTime,
            replyInThread: spaceReplyInThread,
            threadSessionIsolation: spaceThreadIsolation,
            attachmentPaths: downloadedPaths
          })
        );
      }
      await Promise.all(dispatchPromises);
      if (pendingReactionName) {
        try {
          const reactionToken = await getOAuthToken();
          await httpJson(`https://chat.googleapis.com/v1/${pendingReactionName}`, {
            method: "DELETE",
            headers: { Authorization: `Bearer ${reactionToken}` }
          });
          logger.info(`\u{1F9F9} Removed \u23F3 reaction: ${pendingReactionName}`);
        } catch (err) {
          logger.warn(`Failed to remove \u23F3 reaction: ${err.message}`);
        }
        pendingReactionName = void 0;
      }
      markProcessed(msgName);
    }
  } catch (e) {
    logger.error(`Poll error: ${e.message}`);
    if (e.message?.includes("401") || e.message?.includes("UNAUTHENTICATED")) {
      oauthCache.expiresAt = 0;
    }
  }
}
function register(api) {
  logger = api.logger ?? console;
  pluginApi = api;
  api.registerChannel({
    id: "googlechatpubsub",
    meta: {
      id: "googlechatpubsub",
      label: "Google Chat (Pub/Sub)",
      selectionLabel: "Google Chat Pub/Sub (no-mention listening)",
      docsPath: "/channels/googlechatpubsub",
      blurb: "Listen to Google Chat spaces via Workspace Events + Pub/Sub. No @mention required.",
      aliases: ["gchatpubsub", "gchat-pubsub"]
    },
    capabilities: { chatTypes: ["group"], reactions: true, media: true },
    describeMessageTool: () => ({
      actions: ["send", "react", "reactions", "upload-file"],
      capabilities: null,
      schema: null
    }),
    messaging: {
      targetResolver: {
        hint: "spaces/<SPACE_ID>",
        looksLikeId: (raw) => /^spaces\/[a-zA-Z0-9_-]+$/.test(raw.trim()),
        resolveTarget: async ({ normalized }) => {
          const to = normalized?.trim();
          if (!to || !/^spaces\/[a-zA-Z0-9_-]+$/.test(to)) return null;
          return { to, kind: "group", source: "normalized" };
        }
      }
    },
    config: {
      listAccountIds: () => ["default"],
      resolveAccount: (cfg) => {
        const pluginCfg = cfg.channels?.googlechatpubsub || cfg.plugins?.entries?.googlechatpubsub?.config || {};
        return { accountId: "default", ...pluginCfg };
      }
    },
    handleAction: async (ctx) => {
      const { action, params } = ctx;
      if (action === "react") {
        const messageName = params.messageId || params.message_id || params.target;
        const emoji = params.emoji || "\u{1F440}";
        if (!messageName) {
          return { ok: false, error: "messageId (Chat message name) is required for react" };
        }
        try {
          const token = await getOAuthToken();
          const url = `https://chat.googleapis.com/v1/${messageName}/reactions`;
          const { status, data } = await httpJson(url, {
            method: "POST",
            headers: { Authorization: `Bearer ${token}` },
            body: {
              emoji: { unicode: emoji }
            }
          });
          if (status >= 400) {
            return { ok: false, error: `Chat API react failed (${status}): ${JSON.stringify(data)}` };
          }
          return { ok: true, added: emoji };
        } catch (e) {
          return { ok: false, error: `React failed: ${e.message}` };
        }
      }
      if (action === "reactions") {
        const messageName = params.messageId || params.message_id || params.target;
        if (!messageName) {
          return { ok: false, error: "messageId (Chat message name) is required for reactions" };
        }
        try {
          const token = await getOAuthToken();
          const url = `https://chat.googleapis.com/v1/${messageName}/reactions`;
          const { status, data } = await httpJson(url, {
            method: "GET",
            headers: { Authorization: `Bearer ${token}` }
          });
          return { ok: true, reactions: data.reactions || [] };
        } catch (e) {
          return { ok: false, error: `List reactions failed: ${e.message}` };
        }
      }
      if (action === "send") {
        const text = params.message || params.text;
        const target = params.target;
        if (!text || !target) {
          return { ok: false, error: "message and target are required for send" };
        }
        try {
          const token = await getBotToken();
          const space = target;
          const replyToThread = params.threadId || params.replyTo;
          const binding = config?.bindings?.find((b) => b.space === space);
          const bindingReplyInThread = binding?.replyInThread ?? false;
          const msgBody = { text };
          let url = `https://chat.googleapis.com/v1/${space}/messages`;
          if (replyToThread) {
            msgBody.thread = { name: replyToThread };
            url += `?messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD`;
          } else if (bindingReplyInThread) {
            logger.warn(`[handleAction.send] replyInThread=true for ${space} but no threadId provided \u2014 landing in main chat`);
          }
          const { status, data } = await httpJson(url, {
            method: "POST",
            headers: { Authorization: `Bearer ${token}` },
            body: msgBody
          });
          return { ok: status < 400, messageId: data?.name };
        } catch (e) {
          return { ok: false, error: `Send failed: ${e.message}` };
        }
      }
      if (action === "upload-file") {
        const target = params.target;
        if (!target) {
          return { ok: false, error: "target (spaces/<SPACE_ID>) is required for upload-file" };
        }
        const mediaRefs = [
          ...Array.isArray(params.media) ? params.media : params.media ? [params.media] : [],
          ...params.path ? [params.path] : [],
          ...Array.isArray(params.paths) ? params.paths : [],
          ...Array.isArray(params.attachments) ? params.attachments.map((a) => a?.media).filter(Boolean) : []
        ].filter((m) => Boolean(m && String(m).trim()));
        if (mediaRefs.length === 0) {
          return { ok: false, error: "media (path or URL) is required for upload-file" };
        }
        try {
          const token = await getOAuthToken();
          const binding = config?.bindings?.find((b) => b.space === target);
          const replyToThread = params.threadId || params.replyTo;
          const threadName = replyToThread ? String(replyToThread) : void 0;
          if (binding?.replyInThread && !replyToThread) {
            logger.warn(
              `[handleAction.upload-file] replyInThread=true for ${target} but no threadId provided \u2014 landing in main chat`
            );
          }
          const result = await sendMediaMessages({
            space: target,
            mediaRefs: [...new Set(mediaRefs)],
            token,
            text: params.message || params.text || params.caption,
            threadName
          });
          if (result.sent === 0) {
            return {
              ok: false,
              error: `All uploads failed: ${result.failed.join("; ").slice(0, 500)}`
            };
          }
          return {
            ok: true,
            sent: result.sent,
            messageIds: result.messageIds,
            ...result.failed.length ? { partialFailures: result.failed } : {}
          };
        } catch (e) {
          return { ok: false, error: `Upload failed: ${e.message}` };
        }
      }
      return { ok: false, error: `Unsupported action: ${action}` };
    },
    outbound: {
      deliveryMode: "direct",
      sendText: async ({ text, target, threadId, replyTo }) => {
        try {
          const token = await getBotToken();
          const space = target || config?.bindings?.[0]?.space;
          if (!space) return { ok: false };
          const replyToThread = threadId || replyTo;
          const binding = config?.bindings?.find((b) => b.space === space);
          const bindingReplyInThread = binding?.replyInThread ?? false;
          const msgBody = { text };
          let url = `https://chat.googleapis.com/v1/${space}/messages`;
          if (replyToThread) {
            msgBody.thread = { name: replyToThread };
            url += `?messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD`;
          } else if (bindingReplyInThread) {
            logger.warn(`[outbound.sendText] replyInThread=true for ${space} but no threadId \u2014 landing in main chat`);
          }
          const { status, data } = await httpJson(url, {
            method: "POST",
            headers: { Authorization: `Bearer ${token}` },
            body: msgBody
          });
          if (status < 400) markProcessed(data?.name);
          return { ok: status < 400, messageId: data?.name, target: space };
        } catch (e) {
          logger.error(`outbound sendText error: ${e.message}`);
          return { ok: false };
        }
      },
      sendMedia: async ({ text, target, threadId, replyTo, mediaUrl, mediaReadFile }) => {
        try {
          const token = await getOAuthToken();
          const space = target || config?.bindings?.[0]?.space;
          if (!space) return { ok: false };
          if (!mediaUrl) return { ok: false };
          const replyToThread = threadId || replyTo;
          const binding = config?.bindings?.find((b) => b.space === space);
          if (binding?.replyInThread && !replyToThread) {
            logger.warn(
              `[outbound.sendMedia] replyInThread=true for ${space} but no threadId \u2014 landing in main chat`
            );
          }
          const result = await sendMediaMessages({
            space,
            mediaRefs: [String(mediaUrl)],
            token,
            text,
            threadName: replyToThread ? String(replyToThread) : void 0,
            readFile: mediaReadFile
          });
          return {
            ok: result.sent > 0,
            messageId: result.messageIds[0],
            target: space
          };
        } catch (e) {
          logger.error(`outbound sendMedia error: ${e.message}`);
          return { ok: false };
        }
      }
    }
  });
  api.registerService({
    id: "googlechatpubsub-listener",
    start: async () => {
      try {
        logger.info("[googlechatpubsub] start() called");
        const cfg = api.config;
        const pluginConfig = cfg.channels?.googlechatpubsub || cfg.plugins?.entries?.googlechatpubsub?.config;
        logger.info(`[googlechatpubsub] pluginConfig exists: ${!!pluginConfig}, enabled: ${pluginConfig?.enabled}`);
        if (!pluginConfig?.enabled) {
          logger.info("[googlechatpubsub] Disabled \u2014 skipping start");
          return;
        }
        config = pluginConfig;
        serviceAccountFile = config.serviceAccountFile || cfg.channels?.googlechat?.serviceAccountFile || "";
        if (!serviceAccountFile) {
          logger.error("[googlechatpubsub] No serviceAccountFile configured");
          return;
        }
        routingTable = buildRoutingTable(config.bindings);
        targetSpaces = new Set(config.bindings.map((b) => b.space));
        subscriptionState = loadSubState();
        lastRenewalCheck = 0;
        const pollMs = (config.pollIntervalSeconds ?? 3) * 1e3;
        logger.info("\u2550".repeat(60));
        logger.info("[googlechatpubsub] Starting listener (v3 \u2014 in-process pipeline)");
        logger.info(`  Project     : ${config.projectId}`);
        logger.info(`  Topic       : ${config.topicId}`);
        logger.info(`  Subscription: ${config.subscriptionId}`);
        logger.info(`  Poll        : ${pollMs}ms`);
        for (const space of targetSpaces) {
          const entry = routingTable.get(space);
          const kws = [...entry.keywordAgents.keys()];
          const als = entry.alwaysListen.map((a) => a.agentId);
          logger.info(`  \u251C\u2500 ${space}`);
          logger.info(`  \u2502  keywords: ${JSON.stringify(kws)}`);
          logger.info(`  \u2502  alwaysListen: ${JSON.stringify(als)}`);
          logger.info(`  \u2502  replyInThread: ${entry.replyInThread}`);
          logger.info(`  \u2502  threadSessionIsolation: ${entry.threadSessionIsolation}`);
        }
        logger.info("\u2550".repeat(60));
        try {
          await getOAuthToken();
          await getBotToken();
          await checkAndRenewAll();
          lastRenewalCheck = Date.now();
        } catch (e) {
          logger.error(`[googlechatpubsub] Init failed: ${e.message}`);
        }
        pollTimer = setInterval(() => pollOnce(), pollMs);
        logger.info("[googlechatpubsub] Poll loop started");
      } catch (startErr) {
        logger.error(`[googlechatpubsub] start() CRASHED: ${startErr.stack || startErr.message}`);
      }
    },
    stop: () => {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      logger.info("[googlechatpubsub] Stopped");
    }
  });
}
export {
  register as default
};

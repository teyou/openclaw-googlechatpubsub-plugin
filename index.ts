/**
 * googlechatpubsub — OpenClaw channel plugin
 *
 * Listens to Google Chat spaces via Workspace Events API + Cloud Pub/Sub.
 * Routes messages to agents by keyword or alwaysListen rules.
 * Processes messages IN-PROCESS via the OpenClaw pipeline (proper sessions).
 * Replies via Google Chat API using service account credentials.
 *
 * No @mention required. Messages arrive via Pub/Sub, not the Chat webhook.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, join, extname } from "node:path";
import { createSign, randomUUID } from "node:crypto";
import {
  resolveInboundRouteEnvelopeBuilderWithRuntime,
} from "openclaw/plugin-sdk/googlechat";
import {
  createReplyPrefixOptions,
} from "openclaw/plugin-sdk/channel-runtime";

// ── Types ────────────────────────────────────────────────────────────────────

interface AgentBinding {
  agentId: string;
  mentionKeyword?: string;
  alwaysListen?: boolean;
}

interface SpaceBinding {
  space: string;
  replyInThread?: boolean;
  threadSessionIsolation?: boolean;
  agents: AgentBinding[];
}

interface PubSubConfig {
  enabled?: boolean;
  projectId: string;
  topicId: string;
  subscriptionId: string;
  pollIntervalSeconds?: number;
  renewalBufferMinutes?: number;
  serviceAccountFile?: string;
  oauth: {
    clientId: string;
    clientSecret: string;
    redirectUri?: string;
    tokensFile: string;
  };
  bindings: SpaceBinding[];
}

interface RoutingEntry {
  keywordAgents: Map<string, AgentBinding>;
  alwaysListen: AgentBinding[];
  pattern: RegExp | null;
  replyInThread: boolean;
  threadSessionIsolation: boolean;
}

interface TokenCache {
  token: string | null;
  expiresAt: number;
}

// ── State (module-scoped) ────────────────────────────────────────────────────

let config: PubSubConfig;
let serviceAccountFile: string;
let routingTable: Map<string, RoutingEntry>;
let targetSpaces: Set<string>;
let oauthCache: TokenCache = { token: null, expiresAt: 0 };
let botCache: TokenCache = { token: null, expiresAt: 0 };
let processedMsgIds = new Set<string>();
let lastRenewalCheck = 0;
let subscriptionState: Record<string, any> = {};
let logger: any;
let pluginApi: any; // Store the full api object for runtime access
let pollTimer: ReturnType<typeof setInterval> | null = null;

const MAX_DEDUP = 500;
const RENEWAL_INTERVAL = 300_000; // 5 min
const SUBSCRIPTION_TTL = 14_400; // 4h in seconds
const STATE_FILE_NAME = "gchat-pubsub-subscription-state.json";

// ── HTTP helper (stdlib only) ────────────────────────────────────────────────

async function httpJson(
  url: string,
  opts: { method?: string; headers?: Record<string, string>; body?: any; timeoutMs?: number } = {}
): Promise<{ status: number; data: any }> {
  const { method = "GET", headers = {}, body, timeoutMs = 15000 } = opts;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    clearTimeout(timer);
    const text = await res.text();
    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    return { status: res.status, data };
  } catch (e: any) {
    clearTimeout(timer);
    if (e.name === "AbortError") {
      throw new Error(`HTTP request timed out after ${timeoutMs}ms: ${method} ${url}`);
    }
    throw e;
  }
}

async function httpForm(
  url: string,
  params: Record<string, string>
): Promise<any> {
  const body = new URLSearchParams(params).toString();
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  return res.json();
}

// ── Auth ─────────────────────────────────────────────────────────────────────

async function getOAuthToken(): Promise<string> {
  const now = Date.now() / 1000;
  if (oauthCache.token && now < oauthCache.expiresAt - 60) {
    return oauthCache.token;
  }

  const tokensFile = config.oauth.tokensFile;
  let tokens: any;
  try {
    tokens = JSON.parse(readFileSync(tokensFile, "utf-8"));
  } catch {
    throw new Error(`Cannot read OAuth tokens from ${tokensFile}`);
  }

  const result = await httpForm("https://oauth2.googleapis.com/token", {
    client_id: config.oauth.clientId,
    client_secret: config.oauth.clientSecret,
    refresh_token: tokens.refresh_token,
    grant_type: "refresh_token",
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

async function getBotToken(): Promise<string> {
  const now = Date.now() / 1000;
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
      scope:
        "https://www.googleapis.com/auth/chat.bot https://www.googleapis.com/auth/chat.messages.reactions",
      aud: "https://oauth2.googleapis.com/token",
      iat,
      exp,
    })
  ).toString("base64url");

  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  const signature = signer.sign(sa.private_key, "base64url");
  const jwt = `${header}.${payload}.${signature}`;

  const result = await httpForm("https://oauth2.googleapis.com/token", {
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: jwt,
  });

  botCache.token = result.access_token;
  botCache.expiresAt = now + 3000;
  logger.info("Bot SA token minted (valid ~50 min)");
  return result.access_token;
}

// ── Routing ──────────────────────────────────────────────────────────────────

function buildRoutingTable(
  bindings: SpaceBinding[]
): Map<string, RoutingEntry> {
  const table = new Map<string, RoutingEntry>();

  for (const binding of bindings) {
    const keywordAgents = new Map<string, AgentBinding>();
    const alwaysListen: AgentBinding[] = [];
    const keywords: string[] = [];

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

    let pattern: RegExp | null = null;
    if (keywords.length) {
      pattern = new RegExp(
        `(?:^|[\\s@<])(${keywords.join("|")})(?:[\\s>,.:!?'")}]|$)`,
        "i"
      );
    }

    const replyInThread = binding.replyInThread ?? false;
    // threadSessionIsolation defaults to true when replyInThread is enabled
    const threadSessionIsolation = binding.threadSessionIsolation ?? replyInThread;

    table.set(binding.space, { keywordAgents, alwaysListen, pattern, replyInThread, threadSessionIsolation });
  }

  return table;
}

function routeMessage(text: string, space: string): AgentBinding[] {
  const entry = routingTable.get(space);
  if (!entry) return [];

  const matched: AgentBinding[] = [];
  const seen = new Set<string>();

  // 1) Always include alwaysListen agents
  for (const agent of entry.alwaysListen) {
    if (!seen.has(agent.agentId)) {
      matched.push(agent);
      seen.add(agent.agentId);
    }
  }

  // 2) Add keyword-matched agents on top (deduped)
  if (entry.pattern) {
    const matches = text.matchAll(new RegExp(entry.pattern.source, "gi"));
    for (const m of matches) {
      const kw = m[1].toLowerCase();
      const agent = entry.keywordAgents.get(kw);
      if (agent && !seen.has(agent.agentId)) {
        matched.push(agent);
        seen.add(agent.agentId);
        logger.info(`🎯 Keyword '${kw}' → agent '${agent.agentId}'`);
      }
    }
  }

  if (matched.length) {
    logger.info(`📨 Routed to ${matched.length} agent(s): ${matched.map(a => a.agentId).join(', ')}`);
  }

  return matched;
}

// ── Pub/Sub ──────────────────────────────────────────────────────────────────

async function pullMessages(token: string): Promise<any[]> {
  const sub = `projects/${config.projectId}/subscriptions/${config.subscriptionId}`;
  const { data } = await httpJson(
    `https://pubsub.googleapis.com/v1/${sub}:pull`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: { maxMessages: 10, returnImmediately: true },
    }
  );
  return data.receivedMessages || [];
}

async function ackMessages(token: string, ackIds: string[]): Promise<void> {
  if (!ackIds.length) return;
  const sub = `projects/${config.projectId}/subscriptions/${config.subscriptionId}`;
  await httpJson(`https://pubsub.googleapis.com/v1/${sub}:acknowledge`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: { ackIds },
  });
}

// ── Workspace Events subscriptions ──────────────────────────────────────────

function loadSubState(): Record<string, any> {
  const stateDir = process.env.OPENCLAW_DIR || `${process.env.HOME}/.openclaw`;
  const fp = resolve(stateDir, STATE_FILE_NAME);
  if (existsSync(fp)) {
    try {
      return JSON.parse(readFileSync(fp, "utf-8"));
    } catch {}
  }
  return { subscriptions: {} };
}

function saveSubState(state: Record<string, any>): void {
  const stateDir = process.env.OPENCLAW_DIR || `${process.env.HOME}/.openclaw`;
  const fp = resolve(stateDir, STATE_FILE_NAME);
  writeFileSync(fp, JSON.stringify(state, null, 2));
}

async function ensureSubscription(
  space: string,
  token: string
): Promise<void> {
  const topic = `projects/${config.projectId}/topics/${config.topicId}`;
  const now = Date.now() / 1000;
  const bufferSec = (config.renewalBufferMinutes ?? 30) * 60;

  const existing = subscriptionState.subscriptions?.[space];
  if (existing && existing.expiresAt > now + bufferSec) {
    // State file says subscription is fresh — but verify it's actually alive
    if (existing.name) {
      try {
        const { status: checkStatus, data: checkData } = await httpJson(
          `https://workspaceevents.googleapis.com/v1/${existing.name}`,
          { method: "GET", headers: { Authorization: `Bearer ${token}` } }
        );
        if (checkStatus < 400 && checkData?.state === "ACTIVE") {
          // Actually alive — use real expiry from API if available
          if (checkData.expireTime) {
            const realExpiry = new Date(checkData.expireTime).getTime() / 1000;
            if (realExpiry !== existing.expiresAt) {
              existing.expiresAt = realExpiry;
              saveSubState(subscriptionState);
              logger.info(`Updated ${space} expiry from API: ${checkData.expireTime}`);
            }
          }
          return;
        }
        logger.warn(
          `Subscription for ${space} state=${checkData?.state ?? checkStatus} — recreating`
        );
      } catch (e: any) {
        logger.warn(`Subscription verify failed for ${space}: ${e.message} — recreating`);
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
    payloadOptions: { includeResource: true },
  };

  const { status, data } = await httpJson(
    "https://workspaceevents.googleapis.com/v1/subscriptions",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body,
    }
  );

  if (status === 409) {
    logger.info(`Subscription already exists for ${space} — fetching real expiry`);
    // List subscriptions to find the real name and expiry
    try {
      const filter = encodeURIComponent(`target_resource="//chat.googleapis.com/${space}"`);
      const { status: listSt, data: listData } = await httpJson(
        `https://workspaceevents.googleapis.com/v1/subscriptions?filter=${filter}`,
        { method: "GET", headers: { Authorization: `Bearer ${token}` } }
      );
      const sub = listData?.subscriptions?.[0];
      if (sub) {
        const realExpiry = sub.expireTime
          ? new Date(sub.expireTime).getTime() / 1000
          : now + SUBSCRIPTION_TTL;
        subscriptionState.subscriptions ??= {};
        subscriptionState.subscriptions[space] = {
          space,
          name: sub.name,
          expiresAt: realExpiry,
        };
        saveSubState(subscriptionState);
        logger.info(`Found existing subscription ${sub.name} (expires ${sub.expireTime || "~4h"})`);
        return;
      }
    } catch (e: any) {
      logger.warn(`Failed to list subscriptions for ${space}: ${e.message}`);
    }
    // Fallback: use estimated TTL
    subscriptionState.subscriptions ??= {};
    subscriptionState.subscriptions[space] = {
      space,
      expiresAt: now + SUBSCRIPTION_TTL,
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
    expiresAt: now + SUBSCRIPTION_TTL,
  };
  saveSubState(subscriptionState);
  logger.info(
    `Workspace Events subscription created for ${space} (expires in ~4h)`
  );
}

async function checkAndRenewAll(): Promise<void> {
  const token = await getOAuthToken();
  for (const space of targetSpaces) {
    try {
      await ensureSubscription(space, token);
    } catch (e: any) {
      logger.error(`Subscription check failed for ${space}: ${e.message}`);
    }
  }
}

// ── Attachment downloader ────────────────────────────────────────────────────

interface DownloadedAttachment {
  localPath: string;
  mimeType: string;
  filename: string;
}

/**
 * Download Google Chat attachments via the Chat API media.download endpoint.
 * Files are saved to ~/.openclaw/media/inbound/ so OpenClaw picks them up as MediaUrls.
 */
async function downloadAttachments(
  attachments: any[],
  oauthToken: string
): Promise<DownloadedAttachment[]> {
  if (!attachments || attachments.length === 0) return [];

  const stateDir = process.env.OPENCLAW_DIR || `${process.env.HOME}/.openclaw`;
  const mediaDir = join(stateDir, "media", "inbound");
  try {
    mkdirSync(mediaDir, { recursive: true });
  } catch {}

  const results: DownloadedAttachment[] = [];

  for (const att of attachments) {
    // media.download uses attachmentDataRef.resourceName (base64 resource token)
    // att.name is for metadata GET only — returns 404 on media endpoint
    const resourceName = att.attachmentDataRef?.resourceName as string | undefined;
    const attachmentPath = resourceName || (att.name as string | undefined);
    if (!attachmentPath) {
      logger.warn(`[attachment] No resourceName or att.name — skipping: ${JSON.stringify(att).slice(0, 200)}`);
      continue;
    }

    const mimeType: string = att.contentType || "application/octet-stream";
    // att.contentName is the original filename (e.g. "photo.jpg")
    const originalName: string = att.contentName || attachmentPath.split("/").pop() || "attachment";

    // Derive extension from original filename or mimeType
    let ext = extname(originalName);
    if (!ext) {
      const mimeToExt: Record<string, string> = {
        "image/jpeg": ".jpg",
        "image/png": ".png",
        "image/gif": ".gif",
        "image/webp": ".webp",
        "application/pdf": ".pdf",
        "text/plain": ".txt",
        "text/csv": ".csv",
        "application/zip": ".zip",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
      };
      ext = mimeToExt[mimeType] || ".bin";
    }

    const filename = `${randomUUID()}${ext}`;
    const localPath = join(mediaDir, filename);

    try {
      // Chat API media download: GET /v1/media/{resourceName}?alt=media
      // resourceName from attachmentDataRef is the correct token for media download
      const downloadUrl = `https://chat.googleapis.com/v1/media/${attachmentPath}?alt=media`;
      logger.info(`[attachment] Downloading ${attachmentPath} → ${filename}`);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30_000);
      let resp: Response;
      try {
        resp = await fetch(downloadUrl, {
          method: "GET",
          headers: { Authorization: `Bearer ${oauthToken}` },
          signal: controller.signal,
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
      logger.info(`[attachment] Saved ${buffer.length} bytes → ${localPath}`);
      results.push({ localPath, mimeType, filename });
    } catch (err: any) {
      logger.error(`[attachment] Download error for ${attachmentPath}: ${err.message}`);
    }
  }

  return results;
}

// ── In-process message pipeline ─────────────────────────────────────────────

async function processMessageInPipeline(params: {
  agentId: string;
  space: string;
  spaceDisplayName: string;
  senderId: string;
  senderName: string;
  text: string;
  messageName: string;
  threadName: string;
  eventTime?: string;
  replyInThread: boolean;
  threadSessionIsolation: boolean;
  attachmentPaths?: string[];
}): Promise<void> {
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
  } = params;

  const api = pluginApi;
  const cfg = api.config;
  const runtime = api.runtime;

  // 1) Resolve route + build envelope — creates proper session key
  //    Uses agentId as accountId so bindings resolve to the correct agent
  //    Thread-isolated: agent:{agentId}:googlechatpubsub:{agentId}:group:spaces/...:thread:...
  //    Space-scoped:    agent:{agentId}:googlechatpubsub:{agentId}:group:spaces/...

  // Determine the effective thread ID for this message
  const effectiveThreadId = threadName || "";

  // Determine peer ID — if thread isolation is on and we have a thread, include it in peer ID
  const peerId = threadSessionIsolation && effectiveThreadId
    ? `${space}:thread:${effectiveThreadId.split("/").pop()}`
    : space;

  // Use agentId as accountId — bindings in openclaw.json map
  // { channel: "googlechatpubsub", accountId: "main" } → agentId: "main"
  // { channel: "googlechatpubsub", accountId: "rd" } → agentId: "rd"
  // { channel: "googlechatpubsub", accountId: "ca_hc" } → agentId: "ca_hc"
  const { route, buildEnvelope } = resolveInboundRouteEnvelopeBuilderWithRuntime({
    cfg,
    channel: "googlechatpubsub",
    accountId: agentId,
    peer: {
      kind: "group" as const,
      id: peerId,
    },
    runtime: runtime.channel,
    sessionStore: cfg.session?.store,
  });

  logger.info(`🔑 Session key: ${route.sessionKey} (agent=${agentId}, threadIsolation=${threadSessionIsolation}, thread=${effectiveThreadId || 'none'})`);

  const fromLabel = spaceDisplayName || `space:${space}`;
  const { storePath, body } = buildEnvelope({
    channel: "Google Chat",
    from: fromLabel,
    timestamp: eventTime ? Date.parse(eventTime) : undefined,
    body: text,
  });

  // 2) Build inbound context payload (same structure as stock googlechat)
  // Use MediaPaths (not MediaUrls) for local files — normalizeAttachments sets path: void 0
  // when only MediaUrls is provided, treating them as remote URLs to fetch instead of local paths.
  const ctxPayload = runtime.channel.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: text,
    RawBody: text,
    CommandBody: text,
    From: `googlechatpubsub:${senderId}`,
    To: `googlechatpubsub:${space}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: "channel",
    ConversationLabel: fromLabel,
    SenderName: senderName || undefined,
    SenderId: senderId,
    WasMentioned: false,
    CommandAuthorized: true,
    Provider: "googlechatpubsub",
    Surface: "googlechat",
    MessageSid: messageName,
    MessageSidFull: messageName,
    ReplyToId: threadName || undefined,
    ReplyToIdFull: threadName || undefined,
    GroupSpace: spaceDisplayName || undefined,
    OriginatingChannel: "googlechatpubsub",
    OriginatingTo: `googlechatpubsub:${space}`,
    ...(attachmentPaths.length > 0 && {
      MediaPaths: attachmentPaths,          // local file paths → sets path: value in normalizeAttachments
      MediaUrls: attachmentPaths,           // also set for compat/dedup logic
    }),
  });

  // 3) Record session meta — makes session visible in /session
  void runtime.channel.session
    .recordSessionMetaFromInbound({
      storePath,
      sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
      ctx: ctxPayload,
    })
    .catch((err: any) => {
      logger.error(
        `googlechatpubsub: failed updating session meta: ${String(err)}`
      );
    });

  // 4) Determine reply thread target
  //    replyInThread=true + no existing thread → create new thread on the original message
  //    replyInThread=true + existing thread → reply in that thread
  //    replyInThread=false → reply in main window (use thread only if message was already in one)
  let replyThreadName = threadName; // default: follow the incoming message's thread
  let replyMessageOption = "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD";

  if (replyInThread) {
    if (!threadName) {
      // Message in main window, replyInThread=true → start new thread on original message
      // Google Chat: set thread.name = spaces/xxx/threads/xxx where thread ID = message ID portion
      // Actually: to start a thread on a message, use the message's thread name from the API
      // The Chat API will auto-create a thread when we reply with messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD
      // and thread = { name: <original message's thread.name> }
      // In Google Chat, every message has a thread — even in "flat" conversations
      // We use the original message name to target the thread
      replyThreadName = messageName ? `${space}/threads/${messageName.split("/").pop()}` : "";
      replyMessageOption = "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD";
      logger.info(`🧵 replyInThread: creating new thread on message ${messageName}`);
    } else {
      // Already in a thread, stay there
      replyMessageOption = "REPLY_MESSAGE_OR_FAIL";
      logger.info(`🧵 replyInThread: continuing in existing thread ${threadName}`);
    }
  }

  // 5) Typing indicator
  let typingMessageName: string | undefined;
  try {
    const botToken = await getBotToken();
    const typingBody: any = { text: "_typing..._" };
    if (replyInThread && replyThreadName) {
      typingBody.thread = { name: replyThreadName };
    } else if (threadName) {
      typingBody.thread = { name: threadName };
    }
    const typingUrl = replyInThread && replyThreadName
      ? `https://chat.googleapis.com/v1/${space}/messages?messageReplyOption=${replyMessageOption}`
      : `https://chat.googleapis.com/v1/${space}/messages`;

    logger.info(`⏳ Sending typing indicator to ${space} (thread: ${replyThreadName || threadName || 'none'}, replyInThread: ${replyInThread})`);
    const result = await httpJson(typingUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${botToken}` },
      body: typingBody,
    });
    logger.info(`⏳ Typing indicator result: status=${result.status} name=${result.data?.name || 'none'}`);
    if (result.status < 400 && result.data?.name) {
      typingMessageName = result.data.name;
      // Capture the actual thread name from the response (important for new threads)
      if (result.data?.thread?.name && !replyThreadName) {
        replyThreadName = result.data.thread.name;
      }
    } else {
      logger.warn(`Typing indicator failed: ${result.status} ${JSON.stringify(result.data).slice(0, 200)}`);
    }
  } catch (err: any) {
    logger.warn(`Typing indicator exception: ${err.message}`);
  }

  // 6) Dispatch reply through the OpenClaw agent pipeline
  const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
    cfg,
    agentId: route.agentId,
    channel: "googlechatpubsub",
    accountId: route.accountId,
  });

  await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg,
    dispatcherOptions: {
      ...prefixOptions,
      deliver: async (payload: {
        text?: string;
        mediaUrls?: string[];
        mediaUrl?: string;
        replyToId?: string;
      }, info?: any) => {
        logger.info(`📤 deliver called! kind=${info?.kind || '?'} text=${(payload.text || '').slice(0, 100)} mediaUrls=${payload.mediaUrls?.length || 0}`);
        const botToken = await getBotToken();
        const replyText = payload.text?.trim();
        if (!replyText) return;

        const chunkLimit = 4000;
        const chunks: string[] = [];
        if (replyText.length <= chunkLimit) {
          chunks.push(replyText);
        } else {
          // Simple chunking by newlines
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
              // Edit typing indicator with first chunk
              logger.info(`📝 PATCHing typing message: ${typingMessageName}`);
              const patchResult = await httpJson(
                `https://chat.googleapis.com/v1/${typingMessageName}?updateMask=text`,
                {
                  method: "PATCH",
                  headers: { Authorization: `Bearer ${botToken}` },
                  body: { text: chunk },
                }
              );
              if (patchResult.status >= 400) {
                logger.warn(`PATCH failed (${patchResult.status}), falling back to POST: ${JSON.stringify(patchResult.data).slice(0, 200)}`);
                // Fallback: send as new message
                const msgBody: any = { text: chunk };
                let url = `https://chat.googleapis.com/v1/${space}/messages`;
                const effectiveThread = replyInThread ? replyThreadName : threadName;
                if (effectiveThread) {
                  msgBody.thread = { name: effectiveThread };
                  url += `?messageReplyOption=${replyMessageOption}`;
                }
                const postResult = await httpJson(url, {
                  method: "POST",
                  headers: { Authorization: `Bearer ${botToken}` },
                  body: msgBody,
                });
                logger.info(`POST fallback result: ${postResult.status}`);
              } else {
                logger.info(`✅ PATCH succeeded`);
              }
              typingMessageName = undefined;
            } else {
              const msgBody: any = { text: chunk };
              let url = `https://chat.googleapis.com/v1/${space}/messages`;
              const effectiveThread = replyInThread ? replyThreadName : threadName;
              if (effectiveThread) {
                msgBody.thread = { name: effectiveThread };
                url += `?messageReplyOption=${replyMessageOption}`;
              }
              const postResult = await httpJson(url, {
                method: "POST",
                headers: { Authorization: `Bearer ${botToken}` },
                body: msgBody,
              });
              logger.info(`📨 POST result: ${postResult.status}`);
            }
          } catch (err: any) {
            logger.error(`Chat API reply failed: ${err.message}`);
          }
        }
      },
      onSkip: (payload: any, info: any) => {
        logger.warn(`⏭️ Reply skipped: kind=${info?.kind} reason=${info?.reason} text=${(payload?.text || '').slice(0, 100)}`);
      },
      onHeartbeatStrip: () => {
        logger.info(`💓 Heartbeat strip triggered`);
      },
      onError: (err: any, info: any) => {
        logger.error(
          `googlechatpubsub reply ${info?.kind || "?"} failed: ${String(err)}`
        );
        // Clean up typing indicator on error
        if (typingMessageName) {
          getBotToken()
            .then((t) =>
              httpJson(
                `https://chat.googleapis.com/v1/${typingMessageName}`,
                {
                  method: "DELETE",
                  headers: { Authorization: `Bearer ${t}` },
                }
              )
            )
            .catch(() => {});
        }
      },
    },
    replyOptions: {
      onModelSelected,
    },
  });

  // Clean up orphaned typing indicator (e.g. agent replied NO_REPLY / silent skip)
  // If deliver was called, typingMessageName was set to undefined inside deliver.
  // If we get here and it's still set, no delivery happened — delete the stale message.
  if (typingMessageName) {
    logger.info(`🧹 Cleaning up orphaned typing message: ${typingMessageName}`);
    try {
      const cleanupToken = await getBotToken();
      await httpJson(`https://chat.googleapis.com/v1/${typingMessageName}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${cleanupToken}` },
      });
      logger.info(`✅ Orphaned typing message deleted`);
    } catch (err: any) {
      logger.error(`Failed to delete orphaned typing message: ${err.message}`);
    }
  }
}

// ── Chat API reaction ───────────────────────────────────────────────────────

async function sendReaction(
  oauthToken: string,
  messageName: string,
  emoji: string = "⏳"
): Promise<string | undefined> {
  const url = `https://chat.googleapis.com/v1/${messageName}/reactions`;
  const { status, data } = await httpJson(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${oauthToken}` },
    body: { emoji: { unicode: emoji } },
  });

  if (status >= 400) {
    logger.warn(
      `Reaction failed (${status}): ${JSON.stringify(data).slice(0, 300)}`
    );
    return undefined;
  } else {
    logger.info(`⏳ Reacted to ${messageName} (reaction: ${data?.name})`);
    return data?.name as string | undefined;
  }
}

// ── Poll loop ───────────────────────────────────────────────────────────────

async function pollOnce(): Promise<void> {
  try {
    // Periodic renewal
    if (Date.now() - lastRenewalCheck > RENEWAL_INTERVAL) {
      await checkAndRenewAll();
      lastRenewalCheck = Date.now();
    }

    const oauthToken = await getOAuthToken();

    const messages = await pullMessages(oauthToken);
    if (!messages.length) return;

    logger.info(`Pulled ${messages.length} message(s)`);

    // Ack immediately to prevent redelivery
    await ackMessages(
      oauthToken,
      messages.map((m: any) => m.ackId)
    );

    for (const msg of messages) {
      const raw = msg.message?.data;
      if (!raw) continue;

      let data: any;
      try {
        data = JSON.parse(Buffer.from(raw, "base64").toString());
      } catch {
        continue;
      }

      const chatMsg = data.message;
      if (!chatMsg) continue;

      // Dedup
      const msgName = chatMsg.name || "";
      if (msgName && processedMsgIds.has(msgName)) continue;

      const sender = chatMsg.sender || {};
      if (sender.type !== "HUMAN") continue;

      const space = chatMsg.space?.name || "";
      if (!targetSpaces.has(space)) continue;

      const text = (chatMsg.text || "").trim();
      // Google Chat Pub/Sub uses "attachment" (singular array), not "attachments"
      const rawAttachments: any[] = chatMsg.attachment || chatMsg.attachments || [];
      // Require either text or attachments — skip empty messages
      if (!text && rawAttachments.length === 0) continue;

      const displayName = sender.displayName || sender.name || "?";
      logger.info(`📩 [${space}] ${displayName}: ${text.slice(0, 120)}${rawAttachments.length ? ` [${rawAttachments.length} attachment(s)]` : ""}`);

      // For attachment-only messages with no text, use alwaysListen agents only
      const matched = text
        ? routeMessage(text, space)
        : (() => {
            const entry = routingTable.get(space);
            return entry ? [...entry.alwaysListen] : [];
          })();

      if (!matched.length) {
        if (msgName) processedMsgIds.add(msgName);
        continue;
      }

      // Get space-level threading config
      const routingEntry = routingTable.get(space);
      const spaceReplyInThread = routingEntry?.replyInThread ?? false;
      const spaceThreadIsolation = routingEntry?.threadSessionIsolation ?? spaceReplyInThread;

      // React with ⏳ to acknowledge receipt (stored so we can remove it after reply)
      let pendingReactionName: string | undefined;
      if (msgName) {
        pendingReactionName = await sendReaction(oauthToken, msgName).catch(() => undefined);
      }

      // Download attachments (if any) before dispatching to agents
      let downloadedPaths: string[] = [];
      if (rawAttachments.length > 0) {
        try {
          // media.download requires OAuth token (service account JWT returns 403)
          const downloaded = await downloadAttachments(rawAttachments, oauthToken);
          downloadedPaths = downloaded.map((d) => d.localPath);
          if (downloadedPaths.length > 0) {
            logger.info(`📎 Downloaded ${downloadedPaths.length}/${rawAttachments.length} attachment(s)`);
          }
        } catch (err: any) {
          logger.error(`Attachment download error: ${err.message}`);
        }
      }

      // Process each matched agent through the in-process pipeline
      for (const agent of matched) {
        try {
          logger.info(
            `🤖 [${agent.agentId}] Processing via in-process pipeline for ${space} (replyInThread=${spaceReplyInThread}, threadIsolation=${spaceThreadIsolation})`
          );
          await processMessageInPipeline({
            agentId: agent.agentId,
            space,
            spaceDisplayName:
              chatMsg.space?.displayName || `space:${space}`,
            senderId: sender.name || "",
            senderName: displayName,
            text,
            messageName: msgName,
            threadName: chatMsg.thread?.name || "",
            eventTime: data.eventTime || chatMsg.createTime,
            replyInThread: spaceReplyInThread,
            threadSessionIsolation: spaceThreadIsolation,
            attachmentPaths: downloadedPaths,
          });
          logger.info(`✅ [${agent.agentId}] Pipeline complete for ${space}`);
        } catch (err: any) {
          logger.error(
            `[${agent.agentId}] Pipeline error: ${err.message}`
          );
        }
      }

      // Remove the ⏳ reaction now that the agent has finished replying
      if (pendingReactionName) {
        try {
          const reactionToken = await getOAuthToken();
          await httpJson(`https://chat.googleapis.com/v1/${pendingReactionName}`, {
            method: "DELETE",
            headers: { Authorization: `Bearer ${reactionToken}` },
          });
          logger.info(`🧹 Removed ⏳ reaction: ${pendingReactionName}`);
        } catch (err: any) {
          logger.warn(`Failed to remove ⏳ reaction: ${err.message}`);
        }
        pendingReactionName = undefined;
      }

      if (msgName) {
        processedMsgIds.add(msgName);
        if (processedMsgIds.size > MAX_DEDUP) processedMsgIds.clear();
      }
    }
  } catch (e: any) {
    logger.error(`Poll error: ${e.message}`);
    if (
      e.message?.includes("401") ||
      e.message?.includes("UNAUTHENTICATED")
    ) {
      oauthCache.expiresAt = 0;
    }
  }
}

// ── Plugin registration ─────────────────────────────────────────────────────

export default function register(api: any) {
  logger = api.logger ?? console;
  pluginApi = api;

  api.registerChannel({
    id: "googlechatpubsub",
    meta: {
      id: "googlechatpubsub",
      label: "Google Chat (Pub/Sub)",
      selectionLabel: "Google Chat Pub/Sub (no-mention listening)",
      docsPath: "/channels/googlechatpubsub",
      blurb:
        "Listen to Google Chat spaces via Workspace Events + Pub/Sub. No @mention required.",
      aliases: ["gchatpubsub", "gchat-pubsub"],
    },
    capabilities: { chatTypes: ["group"], reactions: true },
    describeMessageTool: () => ({
      actions: ["send", "react", "reactions", "upload-file"] as const,
      capabilities: null,
      schema: null,
    }),
    config: {
      listAccountIds: () => ["default"],
      resolveAccount: (cfg: any) => {
        // Primary: channels.googlechatpubsub (standard channel convention)
        // Fallback: plugins.entries.googlechatpubsub.config (legacy ≤0.1.x)
        const pluginCfg =
          cfg.channels?.googlechatpubsub ||
          cfg.plugins?.entries?.googlechatpubsub?.config ||
          {};
        return { accountId: "default", ...pluginCfg };
      },
    },
    handleAction: async (ctx: any) => {
      const { action, params } = ctx;

      if (action === "react") {
        const messageName = params.messageId || params.message_id || params.target;
        const emoji = params.emoji || "👀";
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
              emoji: { unicode: emoji },
            },
          });
          if (status >= 400) {
            return { ok: false, error: `Chat API react failed (${status}): ${JSON.stringify(data)}` };
          }
          return { ok: true, added: emoji };
        } catch (e: any) {
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
            headers: { Authorization: `Bearer ${token}` },
          });
          return { ok: true, reactions: data.reactions || [] };
        } catch (e: any) {
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
          const { status, data } = await httpJson(
            `https://chat.googleapis.com/v1/${space}/messages`,
            {
              method: "POST",
              headers: { Authorization: `Bearer ${token}` },
              body: { text },
            }
          );
          return { ok: status < 400, messageId: data?.name };
        } catch (e: any) {
          return { ok: false, error: `Send failed: ${e.message}` };
        }
      }

      return { ok: false, error: `Unsupported action: ${action}` };
    },
    outbound: {
      deliveryMode: "direct",
      sendText: async ({ text, target }: any) => {
        try {
          const token = await getBotToken();
          const space = target || config?.bindings?.[0]?.space;
          if (!space) return { ok: false };

          const msgBody: any = { text };
          const { status, data } = await httpJson(
            `https://chat.googleapis.com/v1/${space}/messages`,
            {
              method: "POST",
              headers: { Authorization: `Bearer ${token}` },
              body: msgBody,
            }
          );
          return { ok: status < 400 };
        } catch (e: any) {
          logger.error(`outbound sendText error: ${e.message}`);
          return { ok: false };
        }
      },
    },
  });

  // Register background service
  api.registerService({
      id: "googlechatpubsub-listener",

      start: async () => {
        try {
        logger.info("[googlechatpubsub] start() called");
        const cfg = api.config;
        // Primary: channels.googlechatpubsub (standard channel convention)
        // Fallback: plugins.entries.googlechatpubsub.config (legacy ≤0.1.x)
        const pluginConfig: PubSubConfig =
          cfg.channels?.googlechatpubsub ||
          cfg.plugins?.entries?.googlechatpubsub?.config;

        logger.info(`[googlechatpubsub] pluginConfig exists: ${!!pluginConfig}, enabled: ${pluginConfig?.enabled}`);

        if (!pluginConfig?.enabled) {
          logger.info("[googlechatpubsub] Disabled — skipping start");
          return;
        }

        config = pluginConfig;

        serviceAccountFile =
          config.serviceAccountFile ||
          cfg.channels?.googlechat?.serviceAccountFile ||
          "";

        if (!serviceAccountFile) {
          logger.error("[googlechatpubsub] No serviceAccountFile configured");
          return;
        }

        routingTable = buildRoutingTable(config.bindings);
        targetSpaces = new Set(config.bindings.map((b) => b.space));
        subscriptionState = loadSubState();
        lastRenewalCheck = 0;

        const pollMs = (config.pollIntervalSeconds ?? 3) * 1000;

        logger.info("═".repeat(60));
        logger.info("[googlechatpubsub] Starting listener (v3 — in-process pipeline)");
        logger.info(`  Project     : ${config.projectId}`);
        logger.info(`  Topic       : ${config.topicId}`);
        logger.info(`  Subscription: ${config.subscriptionId}`);
        logger.info(`  Poll        : ${pollMs}ms`);
        for (const space of targetSpaces) {
          const entry = routingTable.get(space)!;
          const kws = [...entry.keywordAgents.keys()];
          const als = entry.alwaysListen.map((a) => a.agentId);
          logger.info(`  ├─ ${space}`);
          logger.info(`  │  keywords: ${JSON.stringify(kws)}`);
          logger.info(`  │  alwaysListen: ${JSON.stringify(als)}`);
          logger.info(`  │  replyInThread: ${entry.replyInThread}`);
          logger.info(`  │  threadSessionIsolation: ${entry.threadSessionIsolation}`);
        }
        logger.info("═".repeat(60));

        // Initial token + subscription check
        try {
          await getOAuthToken();
          await getBotToken();
          await checkAndRenewAll();
          lastRenewalCheck = Date.now();
        } catch (e: any) {
          logger.error(`[googlechatpubsub] Init failed: ${e.message}`);
        }

        pollTimer = setInterval(() => pollOnce(), pollMs);
        logger.info("[googlechatpubsub] Poll loop started");
        } catch (startErr: any) {
          logger.error(`[googlechatpubsub] start() CRASHED: ${startErr.stack || startErr.message}`);
        }
      },

      stop: () => {
        if (pollTimer) {
          clearInterval(pollTimer);
          pollTimer = null;
        }
        logger.info("[googlechatpubsub] Stopped");
      },
    });
}

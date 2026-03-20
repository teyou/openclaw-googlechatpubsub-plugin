# googlechatpubsub — OpenClaw Channel Plugin

> **[📖 Visual Setup Guide](https://teyou.github.io/openclaw-googlechatpubsub-plugin/)** — step-by-step installation with screenshots

Listen to Google Chat spaces via **Workspace Events API + Cloud Pub/Sub** — no `@mention` required.

Messages arrive through Pub/Sub, get routed to one or more agents by keyword or always-listen rules, processed through the OpenClaw pipeline, and replied via the Google Chat API. Thread-first replies and per-thread session isolation are supported.

> **Status:** Alpha (v0.1.0). Works in production but APIs may change.

## How It Works

```
Google Chat Space
       │
       ▼
Workspace Events API ──► Cloud Pub/Sub Topic
                              │
                              ▼
                    ┌─────────────────────┐
                    │  googlechatpubsub   │
                    │  (OpenClaw plugin)  │
                    │                     │
                    │  Poll ► Filter ►    │
                    │  Route ► Pipeline   │
                    └────────┬────────────┘
                             │
                             ▼
                    Google Chat API (reply)
```

## Features

- **No @mention required** — Pub/Sub delivers ALL messages from subscribed spaces
- **Multi-agent routing** — keyword matching + always-listen rules
- **Thread-first replies** — bot replies in threads, never clutters main window
- **Thread-scoped sessions** — each thread gets its own conversation context
- **Emoji reactions** — 👀 on received messages via Chat Reactions API
- **Auto-renewing subscriptions** — handles the 4-hour Workspace Events TTL automatically
- **In-process pipeline** — uses OpenClaw SDK directly (no subprocess hacks)

## Prerequisites

- OpenClaw gateway running (v0.23+)
- Google Workspace account (not consumer Gmail)
- GCP project with billing enabled
- A Google Chat app (bot) already configured with a service account
- The **OAuth user must be a member** of every space in the bindings config

## Installation

```bash
# Create the plugin directory
mkdir -p ~/.openclaw/extensions/googlechatpubsub

# Copy plugin files
cp openclaw.plugin.json ~/.openclaw/extensions/googlechatpubsub/
cp index.ts ~/.openclaw/extensions/googlechatpubsub/
```

## GCP Setup

### 1. Enable APIs

In the [GCP Console](https://console.cloud.google.com/apis/library):
- **Cloud Pub/Sub API** — Enable
- **Google Workspace Events API** — Enable

### 2. Create Pub/Sub Topic

```bash
# Via GCP Console or gcloud:
gcloud pubsub topics create openclaw-chat-events
gcloud pubsub subscriptions create openclaw-chat-events-sub \
  --topic=openclaw-chat-events
```

Grant the Chat API push service account permission to publish:

```bash
gcloud pubsub topics add-iam-policy-binding openclaw-chat-events \
  --member="serviceAccount:chat-api-push@system.gserviceaccount.com" \
  --role="roles/pubsub.editor"
```

### 3. OAuth Consent Screen

1. Go to **APIs & Services → OAuth consent screen**
2. Select **Internal** audience
3. Set app name (e.g., "OpenClaw Pub/Sub")
4. Add developer contact email
5. Add scopes:
   - `https://www.googleapis.com/auth/chat.messages.readonly`
   - `https://www.googleapis.com/auth/chat.spaces.readonly`
   - `https://www.googleapis.com/auth/chat.messages.reactions.create`

### 4. Create OAuth Client

1. Go to **APIs & Services → Credentials → Create Credentials → OAuth client ID**
2. Type: **Web application**
3. Add redirect URI: `http://localhost:3000/oauth/callback`
4. Download the JSON credentials file

### 5. Authorize & Get Tokens

Generate the authorization URL:

```
https://accounts.google.com/o/oauth2/v2/auth?client_id=YOUR_CLIENT_ID&redirect_uri=http://localhost:3000/oauth/callback&response_type=code&scope=https://www.googleapis.com/auth/chat.messages.readonly+https://www.googleapis.com/auth/chat.spaces.readonly+https://www.googleapis.com/auth/chat.messages.reactions.create+https://www.googleapis.com/auth/pubsub&access_type=offline&prompt=consent
```

Open the URL, grant consent, copy the `code` parameter from the redirect, then exchange it:

```bash
curl -s -X POST https://oauth2.googleapis.com/token \
  -d "code=AUTH_CODE" \
  -d "client_id=YOUR_CLIENT_ID" \
  -d "client_secret=YOUR_CLIENT_SECRET" \
  -d "redirect_uri=http://localhost:3000/oauth/callback" \
  -d "grant_type=authorization_code" | python3 -m json.tool > ~/gchat-tokens.json
```

### 6. Find Your Space ID

From the Google Chat URL:
- `https://chat.google.com/room/ABC123example` → `spaces/ABC123example`
- `https://mail.google.com/mail/u/0/#chat/space/ABC123example` → `spaces/ABC123example`

## Configuration

Add to your `openclaw.json`:

```jsonc
{
  // Allow the plugin to load
  "plugins": {
    "allow": ["googlechatpubsub"],
    "entries": {
      "googlechatpubsub": {
        "enabled": true,
        "config": {
          "projectId": "your-gcp-project",
          "topicId": "openclaw-chat-events",
          "subscriptionId": "openclaw-chat-events-sub",
          "pollIntervalSeconds": 3,
          "renewalBufferMinutes": 30,
          "oauth": {
            "clientId": "YOUR_OAUTH_CLIENT_ID",
            "clientSecret": "YOUR_OAUTH_CLIENT_SECRET",
            "tokensFile": "/home/you/gchat-tokens.json"
          },
          "bindings": [
            {
              "space": "spaces/ABC123example",
              "replyInThread": true,
              "threadSessionIsolation": true,
              "agents": [
                { "agentId": "chief-of-staff", "alwaysListen": true },
                { "agentId": "engineer", "mentionKeyword": "eng" },
                { "agentId": "designer", "mentionKeyword": "design" }
              ]
            }
          ]
        }
      }
    }
  },

  // Route each agent to its own session
  "bindings": [
    { "agentId": "chief-of-staff", "match": { "channel": "googlechatpubsub", "accountId": "chief-of-staff" } },
    { "agentId": "engineer", "match": { "channel": "googlechatpubsub", "accountId": "engineer" } },
    { "agentId": "designer", "match": { "channel": "googlechatpubsub", "accountId": "designer" } }
  ]
}
```

Restart the gateway:

```bash
openclaw gateway restart
```

Verify the plugin loaded:

```bash
openclaw plugins list
```

## Multi-Agent Routing

Messages are routed based on two rules:

1. **`alwaysListen`** agents receive every message
2. **`mentionKeyword`** agents receive messages containing their keyword (case-insensitive)

Both are combined — alwaysListen agents are always included, keyword-matched agents are added on top (deduped).

| Message | Routes to |
|---|---|
| `"hello everyone"` | chief-of-staff |
| `"eng, review this PR"` | chief-of-staff + engineer |
| `"design a new landing page"` | chief-of-staff + designer |
| `"eng and design, sync up"` | chief-of-staff + engineer + designer |

## Thread Behavior

| Setting | Effect |
|---|---|
| `replyInThread: false` | Bot replies in main window (default) |
| `replyInThread: true` | Bot always replies in a thread |
| `threadSessionIsolation: true` | Each thread gets its own session/memory |
| `threadSessionIsolation: false` | All threads share one space-level session |

When `replyInThread` is enabled and `threadSessionIsolation` is not set, it defaults to `true`.

## Subscription Lifecycle

- Workspace Events subscriptions have a **4-hour TTL**
- The plugin auto-creates subscriptions on startup
- Checks and renews every 5 minutes (configurable via `renewalBufferMinutes`)
- State persisted in `~/.openclaw/gchat-pubsub-subscription-state.json`

## Configuration Reference

| Option | Type | Default | Description |
|---|---|---|---|
| `enabled` | boolean | `true` | Enable/disable the plugin |
| `projectId` | string | *required* | GCP project ID |
| `topicId` | string | *required* | Pub/Sub topic ID |
| `subscriptionId` | string | *required* | Pub/Sub subscription ID |
| `pollIntervalSeconds` | number | `3` | Seconds between Pub/Sub polls |
| `renewalBufferMinutes` | number | `30` | Minutes before expiry to renew subscription |
| `agentTimeoutSeconds` | number | `60` | Timeout for agent pipeline execution |
| `serviceAccountFile` | string | *from googlechat* | Path to bot service account JSON |
| `oauth.clientId` | string | *required* | OAuth 2.0 client ID |
| `oauth.clientSecret` | string | *required* | OAuth 2.0 client secret |
| `oauth.redirectUri` | string | — | OAuth redirect URI |
| `oauth.tokensFile` | string | *required* | Path to OAuth tokens JSON file |
| `bindings[].space` | string | *required* | Google Chat space name |
| `bindings[].replyInThread` | boolean | `false` | Always reply in threads |
| `bindings[].threadSessionIsolation` | boolean | *=replyInThread* | Isolate sessions per thread |
| `bindings[].agents[].agentId` | string | *required* | Agent ID to route to |
| `bindings[].agents[].mentionKeyword` | string | — | Keyword trigger for this agent |
| `bindings[].agents[].alwaysListen` | boolean | `false` | Receive all messages |

## Troubleshooting

| Issue | Fix |
|---|---|
| Plugin not in `openclaw plugins list` | Add `"googlechatpubsub"` to `plugins.allow` array |
| Subscription fails with 403/404 | OAuth user must be a member of the target space |
| Messages not arriving | Verify IAM binding on Pub/Sub topic for `chat-api-push@system.gserviceaccount.com` |
| OAuth token expired | Plugin auto-refreshes; if refresh_token revoked, re-run the auth flow |
| 403 on reactions | Missing `chat.messages.reactions.create` scope; re-auth with all scopes |
| Multiple replies per message | Check for duplicate listener processes; only one should run |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, code style, and how to submit PRs.

## License

MIT

## Links

- **[📖 Setup Guide](https://teyou.github.io/openclaw-googlechatpubsub-plugin/)** — visual step-by-step installation guide
- [OpenClaw Docs](https://docs.openclaw.ai)
- [Google Workspace Events API](https://developers.google.com/workspace/events)
- [Cloud Pub/Sub Documentation](https://cloud.google.com/pubsub/docs)

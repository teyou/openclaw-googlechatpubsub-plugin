# Contributing to googlechatpubsub

Thanks for your interest in contributing! This plugin bridges Google Chat and OpenClaw via Pub/Sub — contributions that improve reliability, add features, or fix bugs are welcome.

## Getting Started

1. **Fork** the repository
2. **Clone** your fork locally
3. **Install** the plugin into your OpenClaw setup (see [README.md](README.md))
4. Make your changes
5. **Test** against a real Google Chat space (there's no mock harness yet)
6. Open a **Pull Request**

## Development Setup

```bash
# Clone your fork
git clone git@github.com:YOUR_USERNAME/openclaw-googlechatpubsub-plugin.git

# Symlink into your OpenClaw extensions directory
ln -s $(pwd)/openclaw-googlechatpubsub-plugin ~/.openclaw/extensions/googlechatpubsub

# Restart gateway to pick up changes
openclaw gateway restart

# Check plugin loaded
openclaw plugins list

# Tail logs
journalctl --user -u openclaw-gateway -f
```

The plugin is written in TypeScript and loaded by [jiti](https://github.com/unjs/jiti) at runtime — no build step required. Edit `index.ts`, restart the gateway, and test.

## What to Work On

### Good First Issues

- Add unit tests for `routeMessage()` keyword matching
- Improve error messages for common OAuth misconfigurations
- Add `--dry-run` mode that logs what would be sent without calling Chat API

### Feature Ideas

- **Push subscription mode** — use Pub/Sub push instead of pull (requires public endpoint)
- **Domain-wide delegation** — extend subscription TTL from 4h to 24h
- **Message attachments** — download and forward file attachments from Chat messages
- **Typing indicators** — show "bot is typing" via Chat API before agent responds
- **Multi-space auto-discovery** — subscribe to all spaces the OAuth user belongs to
- **Metrics/observability** — expose poll counts, latency, error rates

### Known Limitations

- Multi-agent routing creates sessions under the gateway's primary agent — per-agent session keys require `bindings` entries in `openclaw.json` (documented in README)
- Workspace Events subscriptions expire after 4 hours — the auto-renewal works but isn't battle-tested across long outages
- No support for Google Chat app commands or card interactions (Pub/Sub only delivers message events)

## Code Style

- TypeScript, no build step (jiti handles transpilation)
- Use `logger.info()` / `logger.warn()` / `logger.error()` — no `console.log`
- Template literals for string interpolation (not printf-style `%s`)
- Keep functions focused — the main loop (`pollOnce`) should stay readable
- Error handling: catch and log, don't crash the poll loop

## Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add typing indicator support
fix: handle expired OAuth token during subscription renewal
docs: clarify thread isolation behavior
refactor: extract message routing into separate module
```

## Testing

There's no automated test suite yet (contributions welcome!). For now:

1. Deploy the plugin with your changes
2. Send messages in a Google Chat space (with and without keywords)
3. Verify routing, threading, reactions, and reply delivery
4. Check gateway logs for errors
5. Test subscription renewal by waiting for expiry (~4h) or manually deleting the subscription

## Pull Request Process

1. Keep PRs focused — one feature or fix per PR
2. Update README.md if you change config options or behavior
3. Include a brief description of what you tested
4. CI doesn't exist yet — manual verification is fine

## Reporting Bugs

Open an issue with:
- OpenClaw version (`openclaw --version`)
- Gateway logs (sanitize tokens/secrets)
- Steps to reproduce
- Expected vs. actual behavior

## Code of Conduct

Be respectful and professional.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).

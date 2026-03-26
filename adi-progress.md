# NanoClaw Setup Progress

## Completed

- [x] **Docker** — Dockerfile + docker-compose.yml + .dockerignore created. Image builds and starts successfully.
- [x] **docker-compose plugin** — Installed via Homebrew, configured in `~/.docker/config.json`.
- [x] **Bootstrap** — Node.js 25.6.1, deps, native modules all OK.
- [x] **OneCLI server** — Installed and running at `http://localhost:10254` (dashboard) / `http://localhost:10255` (gateway).
- [x] **OneCLI CLI** — Installed to `~/.local/bin/onecli`, pointed at local instance.
- [x] **ONECLI_URL** — Added to `.env`.
- [x] **Timezone** — Auto-detected as `America/Indianapolis`, written to `.env`.
- [x] **Agent container** — Built (`nanoclaw-agent:latest`) and tested successfully.
- [x] **Git remotes** — `origin` → Adi2p30/nanoclaw-policlaw-adi, `upstream` → qwibitai/nanoclaw.

## In Progress

- [ ] **Anthropic credentials** — Chosen: Claude subscription (Pro/Max). Need to run `claude setup-token` and register token with OneCLI.
- [ ] **Telegram channel** — Selected as the messaging channel. Pending credential setup first.

## Next Steps

1. Run `claude setup-token` in a terminal and paste the token (starts with `sk-ant-`).
2. Register the token with OneCLI (CLI or dashboard at http://localhost:10254).
3. Run `/add-telegram` skill to set up the Telegram bot.
4. Configure mount allowlist.
5. Start the NanoClaw service.
6. Verify end-to-end with a test message in Telegram.

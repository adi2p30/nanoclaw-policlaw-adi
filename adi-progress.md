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

- [ ] **Gemini credentials** — Switched from Claude to Gemini via OpenAI-compatible API. Need to add `GEMINI_API_KEY` to `.env`.
- [ ] **Rebuild container** — Run `./container/build.sh` after adding credentials.
- [ ] **Telegram channel** — Selected as the messaging channel. Pending credential setup first.

## Next Steps

1. Get a Gemini API key from https://aistudio.google.com/apikey
2. Add to `.env`: `GEMINI_API_KEY=your-key-here`
3. Optionally set `GEMINI_MODEL=gemini-2.5-pro` (default) or `gemini-2.0-flash` for faster/cheaper responses.
4. Rebuild the agent container: `./container/build.sh`
5. Run `/add-telegram` skill to set up the Telegram bot.
6. Start the NanoClaw service.
7. Verify end-to-end with a test message in Telegram.

## Architecture Change: Claude → Gemini

The agent container now uses **Gemini via OpenAI-compatible API** instead of `@anthropic-ai/claude-agent-sdk`.

- Model: Gemini (configurable via `GEMINI_MODEL` env var, default: `gemini-2.5-pro`)
- API: OpenAI-compatible endpoint (`https://generativelanguage.googleapis.com/v1beta/openai/`)
- Sessions stored in `/home/node/.claude/nanoclaw-sessions/` as JSON conversation history
- Tools implemented: bash, read_file, write_file, edit_file, find_files, search_files, web_fetch, send_message, schedule/manage tasks, register_group
- `@anthropic-ai/claude-code` removed from container image

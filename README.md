# opencode-poolside-router

Native OpenCode V2 port of [`pi-poolside-router`](https://github.com/hakergeniusz/pi-poolside-router).
It exposes two router models for [Poolside AI](https://poolside.ai) and rotates the
API key on failure so per-key daily quotas stack:

- `poolside/laguna-s` → `poolside/laguna-s-2.1`
- `poolside/laguna-xs` → `poolside/laguna-xs-2.1`

Each request uses one key. The chosen (model, key) pair is **held until it
errors**; only a failed attempt advances to the next key. Keys are tried in this
order: `POOLSIDE_API_KEY_1..N` (numeric), `POOLSIDE_API_KEY_<LABEL>` (lexical),
then plain `POOLSIDE_API_KEY` as the single-key fallback.

## How it maps from the pi original

| pi extension | OpenCode V2 plugin |
|---|---|
| `pi.registerVirtualModel(...)` with a `route()` function | `ctx.provider.transform` registers the alias models (and reuses models.dev's `poolside` provider when present); `ctx.model.transform` hides the concrete ladder entries from the picker and sets alias limits |
| `route(request, ctx)` state machine | `experimental.model.resolve` session hook (per-session position, key-first walk, epoch reset, `lastGood` hint) |
| `request.failed` / retry | `retry` session hook advances the pair and asks OpenCode to retry with the next key |
| per-account provider selection | `http.request` hook applies the selected account's key as `Authorization: Bearer …` |
| `pi.registerCommand("poolside-router", …)` | `ctx.command.transform` registers the same slash command; output is injected with `ctx.session.synthetic` |

Both ladders contain a single model, so rotation is entirely by key — same as
the original. Nothing advances on success.

## Install / load

```jsonc title="opencode.jsonc"
{
  "plugins": [
    {
      "package": "opencode-poolside-router",
      "options": {
        "baseURL": "https://inference.poolside.ai/v1"
      }
    }
  ]
}
```

Environment keys are discovered automatically:

```bash
export POOLSIDE_API_KEY_1=...
export POOLSIDE_API_KEY_2=...
export POOLSIDE_API_KEY=...        # fallback
export POOLSIDE_API_KEY_WORK=...   # becomes poolside-work
```

Options (all optional):

- `baseURL` — override the OpenAI-compatible endpoint (default `https://inference.poolside.ai/v1`).
- `apiKey` — single fallback key when no environment keys are found.
- `keys` — explicit ordered `[{ label?, apiKey }]` list; overrides environment discovery.

## Commands

- `/poolside-router` — show ladders and discovered keys.
- `/poolside-router reset [s|xs]` — restart one or both ladders at the head.

Command arguments are read from the command prompt text; the report is posted
as a synthetic session message.

## Tests

```
bun test
```

Ports the original `smoke.ts` to `node:test` (run by bun) against the pure router core
(`src/router.ts`) — key ordering, rotation, hold-on-success, independent
ladders, direct hints, reset, normalization and single-key fallback. No pi or
OpenCode runtime dependency is needed.

## Known gaps / differences

- OpenCode's `experimental.model.resolve` cannot route to a model on a
  different provider. The pi original rotated across separate
  `poolside-keyN` **providers**; this plugin keeps a single `poolside` provider
  and rotates the Bearer key instead. Aggregator providers (OpenRouter, Kilo,
  NVIDIA) are deliberately not used, matching the original's intent.
- The pi virtual model carried router state in the request. OpenCode has no
  equivalent; state is kept per session in the plugin instance. Epochs and
  `lastGood` are process-global (as before) and are **not** persisted across
  restarts.
- "Missing (model, key) pairs" do not exist here because all concrete models
  live under the one provider — no hole-skipping is needed.
- Retry uses `delay: 0` and OpenCode's built-in maximum attempt count; a key
  cycle that never succeeds stops at that cap instead of looping forever.
- Authentication assumes the openai-compatible `Authorization: Bearer` header.
- `thinkingLevels` from the pi virtual models have no OpenCode equivalent;
  reasoning is controlled by the selected model's own configuration.

## License

MIT — 2026 hakergeniusz

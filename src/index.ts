/**
 * opencode-poolside-router — native OpenCode V2 port of pi-poolside-router.
 *
 * Exposes two router models on the `poolside` provider:
 *
 *   poolside/laguna-s   -> poolside/laguna-s-2.1
 *   poolside/laguna-xs  -> poolside/laguna-xs-2.1
 *
 * The concrete models are registered (or reused from models.dev) through
 * `ctx.provider.transform`; the router aliases are added there too and the
 * concrete entries are hidden from the picker with `ctx.model.transform`.
 * Routing and key rotation are implemented with session hooks:
 *
 *  - `experimental.model.resolve` maps an alias to its concrete model and
 *    selects the current key for the request (the pi `route` equivalent).
 *  - `http.request` applies that key as a Bearer token.
 *  - `retry` advances the (model, key) pair after a failure and asks OpenCode
 *    to retry with the next key. Success holds the pair.
 *
 * Keys are discovered from POOLSIDE_API_KEY, POOLSIDE_API_KEY_1..N and
 * POOLSIDE_API_KEY_<LABEL> (or supplied through plugin options).
 */

import { Model, Plugin, Provider } from "@opencode/plugin"

import {
  ALIASES,
  BASE_URL,
  CONTEXT_WINDOW,
  LADDERS,
  MAX_TOKENS,
  PROVIDER,
  PoolsideRouter,
  discoverKeys,
  type AliasId,
  type KeyEntry,
} from "./router.js"

interface Options {
  /** Override the Poolside OpenAI-compatible endpoint. */
  baseURL?: string
  /** Single fallback key when no environment keys are present. */
  apiKey?: string
  /** Explicit ordered key list. Overrides environment discovery when non-empty. */
  keys?: Array<{ label?: string; apiKey: string }>
}

interface Registration {
  dispose(): Promise<void>
}

const providerID = Provider.ID.make(PROVIDER)
const modelID = (id: string) => Model.ID.make(id)

const LADDER_LABEL: Record<AliasId, string> = {
  "laguna-s": LADDERS["laguna-s"].join(" → "),
  "laguna-xs": LADDERS["laguna-xs"].join(" → "),
}

export default Plugin.define({
  id: "poolside-router",
  async setup(ctx) {
    const options = (ctx.options ?? {}) as Options
    const baseURL = typeof options.baseURL === "string" ? options.baseURL : BASE_URL

    const optionKeys: KeyEntry[] = (options.keys ?? [])
      .filter((entry): entry is { label?: string; apiKey: string } =>
        Boolean(entry && typeof entry.apiKey === "string" && entry.apiKey.length > 0),
      )
      .map((entry, index) => ({
        label: entry.label ?? `poolside-key${index + 1}`,
        apiKey: entry.apiKey,
      }))

    const keys = optionKeys.length > 0 ? optionKeys : discoverKeys()
    const router = new PoolsideRouter(keys)
    const fallbackKey = keys[0]?.apiKey ?? (typeof options.apiKey === "string" ? options.apiKey : "")

    const registrations: Registration[] = []

    // 1. Provider source: keep models.dev's poolside definition when present,
    // otherwise register a self-contained openai-compatible provider.
    registrations.push(
      await ctx.provider.transform((editor) => {
        const aliasModels = ALIASES.map((alias) => ({
          ...Model.Info.default(providerID, modelID(alias)),
          name: alias === "laguna-s" ? "Laguna S (router)" : "Laguna XS (router)",
        }))

        const existing = editor.get(PROVIDER)
        if (existing) {
          editor.update(PROVIDER, (provider) => {
            provider.name = "Poolside"
            provider.activation = "enabled"
            const settings = provider.settings as unknown as Record<string, unknown>
            settings.baseURL = baseURL
            if (fallbackKey) settings.apiKey = fallbackKey
          })
          const seen = new Set<string>()
          const merged = [...Array.from(existing.models.values()), ...aliasModels].filter((model) => {
            if (seen.has(model.id)) return false
            seen.add(model.id)
            return true
          })
          editor.models.set(PROVIDER, merged)
          return
        }

        editor.add({
          info: {
            ...Provider.Info.empty(providerID),
            name: "Poolside",
            activation: "enabled",
            package: "@opencode/ai/providers/openai-compatible",
            settings: {
              baseURL,
              ...(fallbackKey ? { apiKey: fallbackKey } : {}),
            },
          },
          models: aliasModels,
        })
      }),
    )

    // 2. Model policy: hide the concrete ladder entries from the picker (they
    // remain resolvable by the route hook) and give the aliases full limits.
    registrations.push(
      await ctx.model.transform((editor) => {
        for (const concrete of Object.values(LADDERS).map((ladder) => ladder[0])) {
          editor.update(PROVIDER, concrete, (model) => {
            model.enabled = false
          })
        }
        for (const alias of ALIASES) {
          editor.update(PROVIDER, alias, (model) => {
            model.enabled = true
            model.limit.context = CONTEXT_WINDOW
            model.limit.input = CONTEXT_WINDOW
            model.limit.output = MAX_TOKENS
            model.capabilities.tools = true
            model.capabilities.input = ["text"]
            model.capabilities.output = ["text"]
          })
        }
      }),
    )

    // 3. Alias -> concrete routing, plus per-request key selection.
    registrations.push(
      await ctx.session.hook(
        "experimental.model.resolve",
        (event) => {
          const selected = event.model.id
          const alias = ALIASES.find((id) => id === selected)
          if (!alias) return // already concrete, or not one of our models

          const routed = router.route(alias, event.sessionID, event.kind)
          event.model = { providerID, id: modelID(routed.modelID) }
        },
        { providerID: PROVIDER },
      ),
    )

    // 4. Apply the selected account key to the outgoing provider request.
    registrations.push(
      await ctx.session.hook(
        "http.request",
        (event) => {
          const alias = router.aliasForModel(event.model.id, event.sessionID)
          if (!alias) return
          const key = router.keyAt(router.currentKeyIndex(event.sessionID, alias))
          if (!key?.apiKey) return
          event.request.headers.set("authorization", `Bearer ${key.apiKey}`)
        },
        { providerID: PROVIDER },
      ),
    )

    // 5. A failed attempt advances the pair and retries with the next key.
    // Success never reaches this hook, so the pair is held until it errors.
    registrations.push(
      await ctx.session.hook(
        "retry",
        (event) => {
          const alias = router.aliasForModel(event.model.id, event.sessionID)
          if (!alias) return
          const advanced = router.onFailure(alias, event.sessionID)
          if (router.keyCount() > 1 && advanced.keyChanged) {
            event.decision = { retry: true, delay: 0 }
          }
        },
        { providerID: PROVIDER },
      ),
    )

    // 6. /poolside-router status + reset, same surface as the pi original.
    registrations.push(
      await ctx.command.transform((editor) => {
        editor.add({
          name: "poolside-router",
          description: "Show the Poolside router ladders and discovered keys, or reset the ladder position",
          execute: async ({ sessionID, prompt }) => {
            const raw = typeof prompt?.text === "string" ? prompt.text : ""
            const tokens = raw.trim().toLowerCase().split(/\s+/).filter(Boolean)
            // Some hosts pass the full "/poolside-router reset s" text, others
            // pass only the arguments. Accept both.
            const parts = tokens[0] === "poolside-router" ? tokens.slice(1) : tokens

            if (parts[0] === "reset") {
              const ids: AliasId[] =
                parts[1] === "s" || parts[1] === "laguna-s"
                  ? ["laguna-s"]
                  : parts[1] === "xs" || parts[1] === "laguna-xs"
                    ? ["laguna-xs"]
                    : [...ALIASES]
              router.reset(ids)
              await ctx.session.synthetic({
                sessionID,
                text: `poolside-router: reset (${ids.join(", ")}) — next request starts at the ladder head`,
              })
              return
            }

            const discovered = router.keysSnapshot().map((key) => key.label)
            const lines = [
              "poolside-router ladders:",
              `  laguna-s         ${LADDER_LABEL["laguna-s"]}`,
              `  laguna-xs        ${LADDER_LABEL["laguna-xs"]}`,
              "keys discovered: " +
                (discovered.length
                  ? discovered.join(", ")
                  : "none — using the provider's configured key"),
              "advance: key first (all keys on one model), then next model; holds (model, key) until it errors",
              "/poolside-router reset [s|xs] — restart at the ladder head (default: both ladders)",
            ]
            await ctx.session.synthetic({ sessionID, text: lines.join("\n") })
          },
        })
      }),
    )

    return () => {
      void Promise.all(registrations.map((registration) => registration.dispose()))
    }
  },
})

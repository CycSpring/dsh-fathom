/**
 * `@local/dsh-fathom` — Fathom Search tools for the DeepSeek Harness.
 *
 * The plugin is additive: it registers five model tools against the Fathom
 * Search REST API and one system-prompt section, and touches nothing else. No
 * web search provider is registered, `ctx.web` is never consulted, and the
 * built-in `web_search` tool keeps whatever provider it already had.
 *
 * The API key is read per call from the `FATHOM_API_KEY` (or comma-separated
 * `FATHOM_API_KEYS`) credential, so a key saved after the plugin is mounted
 * takes effect on the next search without a restart.
 *
 * Config (all optional, all defaulted):
 *
 *   baseUrl          origin of the Fathom Search API
 *   defaultEngines   engines used when a caller names none
 *   maxKeys          cap on keys read from the credential
 *   retries          retries per key for a transient upstream failure
 *   jinaFirst        try Jina Reader before Fathom /extract
 */
import { installFathomTools } from './lib/tools.js'
import { BASE_URL, DEFAULT_ENGINES, clampInt, normalizeEngines } from './lib/lib.js'

export const name = 'dsh-fathom'

export const inject = ['tools', 'credentials', 'systemPrompt']

/** Resolve the row's config into the shape the tools need. */
function resolveOptions(config) {
  const raw = config !== null && typeof config === 'object' && !Array.isArray(config) ? config : {}
  const baseUrl = typeof raw.baseUrl === 'string' && raw.baseUrl.trim().length > 0
    ? raw.baseUrl.trim().replace(/\/+$/, '')
    : BASE_URL
  const configured = normalizeEngines(raw.defaultEngines)
  return {
    baseUrl,
    defaultEngines: configured.length > 0 ? configured : DEFAULT_ENGINES,
    maxKeys: clampInt(raw.maxKeys, 1, 32, 8),
    retries: clampInt(raw.retries, 0, 3, 1),
    jinaFirst: raw.jinaFirst !== false,
  }
}

export function apply(ctx, config) {
  const disposeTools = installFathomTools(ctx, resolveOptions(config))

  // The fiber owns teardown: unloading this row unregisters every tool and the
  // prompt section it added.
  ctx.effect(() => () => { disposeTools() })

  const credentials = ctx.get('credentials')
  if (credentials !== undefined) {
    credentials.describe('FATHOM_API_KEY').then((info) => {
      if (info !== undefined && info.configured !== true) {
        ctx.logger.warn('fathom_search: FATHOM_API_KEY is not configured; save an ft-… key in ~/.dsh/.credentials.yaml to enable the Fathom tools')
      }
    }).catch((error) => {
      ctx.logger.warn('fathom_search: credential describe failed: %s', error instanceof Error ? error.message : String(error))
    })
  }
}

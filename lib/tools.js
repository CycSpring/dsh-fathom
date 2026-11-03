/**
 * The Fathom Search model tools.
 *
 * Five tools, each a thin typed shell over the documented REST endpoints:
 *
 *   fathom_search        GET /search (one engine) · GET /mega/search (same-category merge)
 *   fathom_image_search  GET /image
 *   fathom_extract       GET /extract (optionally Jina Reader first)
 *   fathom_engines       GET /mega/engines
 *   fathom_usage         GET /me
 *
 * What this file owns, and what it deliberately does not:
 *
 * - Keys resolve per call from the `FATHOM_API_KEY` / `FATHOM_API_KEYS`
 *   credentials, so a key saved later needs no restart. A key-scoped refusal
 *   (401/403/429) moves to the next key; a transient upstream failure
 *   (502/503/504) is retried on the same key first.
 * - No web search provider is registered. The built-in `web_search` keeps its
 *   own provider and `ctx.web` is never touched — this plugin only ADDS tools.
 */
import { defineTool } from './schema.js'
import {
  buildExtractQuery,
  buildImageQuery,
  buildSearchQuery,
  clampInt,
  classifyFailure,
  isImageEngine,
  maskKey,
  normalizeEngines,
  parseKeyList,
  projectEngines,
  projectExtract,
  projectImages,
  projectSearch,
  projectUsage,
  renderEngines,
  renderExtract,
  renderImages,
  renderSearch,
  renderUsage,
} from './lib.js'

const CREDENTIAL_REFS = ['FATHOM_API_KEY', 'FATHOM_API_KEYS']

/** Per-request ceilings. Mega search has been observed at ~60s upstream. */
const SEARCH_TIMEOUT_MS = 120000
const EXTRACT_TIMEOUT_MS = 120000
const META_TIMEOUT_MS = 30000
const JINA_TIMEOUT_MS = 20000

const RESULT_ITEM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    url: { type: 'string', required: true },
    title: { type: 'string' },
    snippet: { type: 'string' },
    engine: { type: 'string' },
  },
}

const SEARCH_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    results: { type: 'array', required: true, items: RESULT_ITEM_SCHEMA },
    enginesFailed: { type: 'array', items: { type: 'string' } },
    tookMs: { type: 'number' },
    requestId: { type: 'string' },
    hasMore: { type: 'boolean' },
    nextStart: { type: 'number' },
    hint: { type: 'string' },
    note: { type: 'string' },
  },
}

const IMAGE_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    results: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          imageUrl: { type: 'string', required: true },
          pageUrl: { type: 'string' },
          title: { type: 'string' },
          snippet: { type: 'string' },
          engine: { type: 'string' },
        },
      },
    },
    enginesFailed: { type: 'array', items: { type: 'string' } },
    tookMs: { type: 'number' },
    requestId: { type: 'string' },
    hasMore: { type: 'boolean' },
    nextStart: { type: 'number' },
    hint: { type: 'string' },
    note: { type: 'string' },
  },
}

const EXTRACT_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    url: { type: 'string', required: true },
    reader: { type: 'string', required: true },
    content: { type: 'string', required: true },
    title: { type: 'string' },
    description: { type: 'string' },
    lang: { type: 'string' },
    cacheStatus: { type: 'string' },
  },
}

const USAGE_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string', required: true },
    status: { type: 'string', required: true },
    keyPrefix: { type: 'string', required: true },
    rpm: {
      type: 'object',
      additionalProperties: false,
      properties: {
        limit: { type: 'number' },
        burst: { type: 'number' },
      },
    },
    quota: {
      type: 'object',
      additionalProperties: false,
      properties: {
        used: { type: 'number' },
        limit: { type: 'number' },
        remaining: { type: 'number' },
      },
    },
    costs: {
      type: 'object',
      additionalProperties: false,
      properties: {
        search: { type: 'number', required: true },
        mega: { type: 'number', required: true },
        extract: { type: 'number', required: true },
      },
    },
  },
}

const ENGINES_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    engines: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', required: true },
          circuit: { type: 'string' },
        },
      },
    },
  },
}

/** Raised inside a tool body; the loop renders it as `Error: <message>`. */
class FathomError extends Error {}

function requiredText(args, name) {
  const value = args[name]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new FathomError(name + ' must be a non-empty string')
  }
  return value.trim()
}

function optionalText(args, name) {
  const value = args[name]
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new FathomError(name + ' must be a string')
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

function optionalHttpUrl(args, name) {
  const value = optionalText(args, name)
  if (value === undefined) throw new FathomError(name + ' must be an absolute HTTP(S) URL')
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    throw new FathomError(name + ' must be an absolute HTTP(S) URL')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new FathomError(name + ' must be an absolute HTTP(S) URL')
  }
  return value
}

function isAbort(error) {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Compose a caller signal with a timeout, tolerating an older runtime. */
function withTimeout(signal, ms) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  const composed = signal === undefined || typeof AbortSignal.any !== 'function'
    ? controller.signal
    : AbortSignal.any([signal, controller.signal])
  return { signal: composed, dispose: () => clearTimeout(timer) }
}

/**
 * Install the Fathom tools and the one system-prompt section, returning a
 * disposer that removes them all. `options` is resolved by `index.js`.
 */
export function installFathomTools(ctx, options) {
  const disposers = []
  const { baseUrl, maxKeys, retries, defaultEngines, jinaFirst } = options

  // Every registration lands in one disposer set, so unloading the row
  // unregisters each tool and the prompt section exactly once.
  const register = (definition) => {
    disposers.push(ctx.tools.register(definition))
  }

  /** Keys in configured order, stored credentials first, then the environment. */
  async function resolveKeys() {
    const out = []
    const seen = new Set()
    const take = (value) => {
      for (const key of parseKeyList(value)) {
        if (seen.has(key)) continue
        seen.add(key)
        out.push(key)
        if (out.length >= maxKeys) return
      }
    }
    const credentials = ctx.get('credentials')
    if (credentials !== undefined) {
      for (const ref of CREDENTIAL_REFS) {
        if (out.length >= maxKeys) break
        try {
          const resolved = await credentials.resolve(ref)
          if (resolved !== undefined && typeof resolved.value === 'string') take(resolved.value)
        } catch (error) {
          ctx.logger.warn('fathom: resolving %s failed: %s', ref, error instanceof Error ? error.message : String(error))
        }
      }
    }
    if (out.length === 0) {
      for (const ref of CREDENTIAL_REFS) {
        const value = process.env[ref]
        if (typeof value === 'string') take(value)
      }
    }
    return out
  }

  /**
   * One HTTP round trip on one key. Resolves to `{ ok: true, value }` or a
   * described failure; only transport errors throw, so the caller decides
   * whether they are retryable.
   */
  /**
   * One HTTP round trip on a key. Returns `{ ok: true, value }` or a described
   * failure carrying its classification; only transport errors throw, so the
   * caller decides whether they are retryable.
   */
  async function call(key, path, query, timeoutMs, signal, project) {
    const url = baseUrl + path + (query.length > 0 ? '?' + query : '')
    const { signal: composed, dispose } = withTimeout(signal, timeoutMs)
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'x-api-key': key,
          accept: 'application/json',
          'user-agent': 'dsh-fathom/0.1',
        },
        signal: composed,
      })
      const raw = await response.text()
      let json
      try {
        json = raw.length > 0 ? JSON.parse(raw) : {}
      } catch {
        json = undefined
      }
      if (!response.ok) {
        return { ok: false, ...classifyFailure(response.status, json) }
      }
      if (json === undefined) {
        return { ok: false, kind: 'transient', message: 'the response body was not JSON' }
      }
      return { ok: true, value: project(json) }
    } finally {
      dispose()
    }
  }

  /**
   * Run one operation across the key pool.
   *
   * The classification, not the status, chooses the recovery: a transient
   * upstream failure is replayed on the same key with backoff, an engine
   * failure is reported at once (no other key can help and the query already
   * names the engine), a key refusal moves to the next key, and a bad request
   * is reported immediately.
   */
  async function runWithKeys(operation, path, query, timeoutMs, signal, project) {
    const keys = await resolveKeys()
    if (keys.length === 0) {
      throw new FathomError(
        operation + ': no Fathom API key is configured — save FATHOM_API_KEY ' +
        '(an ft-… key from https://fathomsearch.xyz/dashboard) in the Harness credentials',
      )
    }
    let last = 'no attempt was made'
    let enginesFailed = []
    for (const key of keys) {
      for (let attempt = 0; attempt <= retries; attempt += 1) {
        let outcome
        try {
          outcome = await call(key, path, query, timeoutMs, signal, project)
        } catch (error) {
          if (isAbort(error)) throw error
          last = error instanceof Error ? error.message : String(error)
          if (attempt < retries) {
            await sleep(500 * (attempt + 1))
            continue
          }
          break
        }
        if (outcome.ok) return outcome.value
        last = outcome.message
        if (outcome.kind === 'engine') {
          enginesFailed = [...new Set([...enginesFailed, outcome.engine])]
          throw new FathomError(operation + ': ' + outcome.message)
        }
        if (outcome.kind === 'fatal') throw new FathomError(operation + ': ' + outcome.message)
        if (outcome.kind === 'transient') {
          if (attempt < retries) {
            await sleep(500 * (attempt + 1))
            continue
          }
          break
        }
        break // kind === 'key': try the next key
      }
      ctx.logger.debug('fathom: key %s refused %s (%s), trying the next key', maskKey(key), operation, last)
    }
    throw new FathomError(
      operation + ': all ' + keys.length + ' configured Fathom key(s) failed — last error: ' + last,
    )
  }

  register(defineTool({
    name: 'fathom_search',
    description: 'Search the web and vertical catalogs through Fathom Search. Use one engine per call: a web engine (duckduckgo, brave, google, bing, baidu, yandex, ecosia, grok) for general results, or one vertical catalog — github for repositories, huggingface for models and datasets, arxiv or semanticscholar or openalex or pubmed for papers, wikidata for entities, wikipedia for definitions, hackernews for tech discourse. Pass two or more web engines only to merge one intent across them. Cite the returned URLs as markdown links.',
    parameters: {
      text: { type: 'string', required: true, description: 'The search query.' },
      engines: {
        type: 'array',
        items: { type: 'string' },
        description: 'Canonical engine names. Omit for duckduckgo.',
      },
      lang: { type: 'string', description: 'Result language, e.g. zh-CN; required for a non-English wikipedia result.' },
      region: { type: 'string', description: 'Result region, e.g. CN or US.' },
      limit: { type: 'number', description: 'Results to return, 1-100 (default 10).' },
      start: { type: 'number', description: 'Pagination offset, for the next page.' },
      site: { type: 'string', description: 'Restrict to a domain on web engines; on github an owner; on huggingface models, datasets, spaces or a Hub author.' },
      file: { type: 'string', description: 'File extension on web engines; on github a language; on huggingface a pipeline tag.' },
      date: { type: 'string', description: 'Date filter, e.g. YYYYMMDD..YYYYMMDD on pubmed.' },
    },
    output: { schema: SEARCH_OUTPUT_SCHEMA, render: renderSearch },
    timeoutMs: SEARCH_TIMEOUT_MS + 10000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const requested = normalizeEngines(args.engines)
      const engines = requested.length > 0 ? requested : defaultEngines
      const query = buildSearchQuery({
        text: requiredText(args, 'text'),
        engines,
        lang: optionalText(args, 'lang'),
        region: optionalText(args, 'region'),
        limit: clampInt(args.limit, 1, 100, 10),
        start: args.start === undefined ? undefined : clampInt(args.start, 0, 10000, 0),
        site: optionalText(args, 'site'),
        file: optionalText(args, 'file'),
        date: optionalText(args, 'date'),
      })
      const mega = engines.length > 1
      return runWithKeys(
        'fathom_search',
        mega ? '/mega/search' : '/search',
        query,
        SEARCH_TIMEOUT_MS,
        exec.signal,
        projectSearch,
      )
    },
  }))

  register(defineTool({
    name: 'fathom_image_search',
    description: 'Search images through Fathom Search. Returns direct image URLs with the page each came from. Accepts web image engines (duckduckgo, brave, google, bing, baidu, yandex, ecosia) and booru tag engines (safebooru is SFW).',
    parameters: {
      text: { type: 'string', required: true, description: 'The image query, or tags for a booru engine.' },
      engines: {
        type: 'array',
        items: { type: 'string' },
        description: 'Canonical image engine names. Omit for duckduckgo.',
      },
      limit: { type: 'number', description: 'Images to return, 1-100 (default 10).' },
      site: { type: 'string', description: 'Restrict to a domain.' },
    },
    output: { schema: IMAGE_OUTPUT_SCHEMA, render: renderImages },
    timeoutMs: SEARCH_TIMEOUT_MS + 10000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const requested = normalizeEngines(args.engines)
      const engines = requested.length > 0 ? requested : ['duckduckgo']
      const unsupported = engines.filter((engine) => !isImageEngine(engine))
      if (unsupported.length > 0) {
        throw new FathomError('these engines serve no images: ' + unsupported.join(', '))
      }
      const query = buildImageQuery({
        text: requiredText(args, 'text'),
        engines,
        limit: clampInt(args.limit, 1, 100, 10),
        site: optionalText(args, 'site'),
      })
      return runWithKeys('fathom_image_search', '/image', query, SEARCH_TIMEOUT_MS, exec.signal, projectImages)
    },
  }))

  register(defineTool({
    name: 'fathom_extract',
    description: 'Read the full body of one HTTP(S) page and return it as Markdown. Use it after a search whose snippet was not enough, or when the URL is already known.',
    parameters: {
      url: { type: 'string', required: true, description: 'The absolute HTTP(S) URL to read.' },
      cache: {
        type: 'string',
        enum: ['use', 'bypass', 'refresh'],
        description: 'Use the cached body (default), skip the cache, or force a refresh.',
      },
    },
    output: { schema: EXTRACT_OUTPUT_SCHEMA, render: renderExtract },
    timeoutMs: EXTRACT_TIMEOUT_MS + JINA_TIMEOUT_MS + 10000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const url = optionalHttpUrl(args, 'url')
      const cache = optionalText(args, 'cache')
      if (cache !== undefined && !['use', 'bypass', 'refresh'].includes(cache)) {
        throw new FathomError('cache must be one of use, bypass, refresh')
      }
      if (jinaFirst) {
        const viaJina = await readWithJina(url, exec.signal)
        if (viaJina !== undefined) return viaJina
      }
      const query = buildExtractQuery(url, cache)
      return runWithKeys('fathom_extract', '/extract', query, EXTRACT_TIMEOUT_MS, exec.signal,
        (json) => projectExtract(json, 'fathom'))
    },
  }))

  register(defineTool({
    name: 'fathom_usage',
    description: 'Report the Fathom Search key\'s plan status, remaining quota, rate limit and per-call cost. Check it before a large batch of searches.',
    parameters: {},
    output: { schema: USAGE_OUTPUT_SCHEMA, render: renderUsage },
    timeoutMs: META_TIMEOUT_MS + 10000,
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      return runWithKeys('fathom_usage', '/me', '', META_TIMEOUT_MS, exec.signal, projectUsage)
    },
  }))

  register(defineTool({
    name: 'fathom_engines',
    description: 'List every Fathom Search engine with its circuit state, to confirm a canonical engine name or see which catalogs currently fail.',
    parameters: {},
    output: { schema: ENGINES_OUTPUT_SCHEMA, render: renderEngines },
    timeoutMs: META_TIMEOUT_MS + 10000,
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      return runWithKeys('fathom_engines', '/mega/engines', '', META_TIMEOUT_MS, exec.signal, projectEngines)
    },
  }))

  /** Jina Reader: free, key-less page text. `undefined` when it is unusable. */
  async function readWithJina(url, signal) {
    const { signal: composed, dispose } = withTimeout(signal, JINA_TIMEOUT_MS)
    try {
      const response = await fetch('https://r.jina.ai/' + url, {
        headers: { accept: 'text/markdown', 'user-agent': 'dsh-fathom/0.1' },
        signal: composed,
      })
      if (!response.ok) return undefined
      const content = (await response.text()).trim()
      if (content.length === 0) return undefined
      return { url, reader: 'jina', content }
    } catch {
      return undefined
    } finally {
      dispose()
    }
  }

  const systemPrompt = ctx.get('systemPrompt')
  if (systemPrompt !== undefined) {
    disposers.push(systemPrompt.section({
      name: 'tool:fathom_search',
      order: 111,
      text: 'fathom_search reaches vertical catalogs the built-in web_search cannot: github, huggingface, arxiv, semanticscholar, openalex, pubmed, wikidata, wikipedia and hackernews. Pick one engine per intent; name two or more only to merge one intent across web engines. Use fathom_extract to read a page whose snippet is not enough.',
    }))
  }

  return function disposeFathomTools() {
    while (disposers.length > 0) {
      const dispose = disposers.pop()
      try {
        dispose()
      } catch (error) {
        ctx.logger.warn('fathom: teardown failed: %s', error instanceof Error ? error.message : String(error))
      }
    }
  }
}

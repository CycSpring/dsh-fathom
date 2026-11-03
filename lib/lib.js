/**
 * Pure helpers for the Fathom Search tools (exported so a plain Node script can
 * exercise them without a Harness).
 *
 * Everything here is total: no I/O, no throwing on unexpected upstream shapes.
 * The API's documented envelopes are
 *   /search  /mega/search  /image  → { query, meta, results[], pagination? }
 *   /extract                       → { url, title, description, markdown, text, lang, meta }
 *   /me                            → { name, status, key_prefix, rpm_*, total_*, usage, cost_* }
 *   /mega/engines                  → { engines: [{ name, circuit_state? }], total }
 * and an error is a non-2xx JSON body { error, code, request_id, message, reason? }.
 */

export const BASE_URL = 'https://fathomsearch.xyz'

/**
 * Vendor default for an unspecified engine set.
 *
 * DuckDuckGo alone, not DuckDuckGo + Brave. Merging two web engines turns every
 * default call into `/mega/search`, which costs more and fails wholesale when
 * EITHER engine's circuit is open — observed live, where a circuit-open Brave
 * made every default search fail with `502` while DuckDuckGo alone answered in
 * under a second. A caller that wants redundancy can ask for it by name.
 */
export const DEFAULT_ENGINES = ['duckduckgo']

/**
 * REST accepts aliases, but normalizing them makes multi-engine routing
 * predictable: `gh` and `github` must land on the same single-engine call.
 */
const ENGINE_ALIASES = new Map([
  ['duck', 'duckduckgo'],
  ['ddg', 'duckduckgo'],
  ['gh', 'github'],
  ['hf', 'huggingface'],
  ['hugging', 'huggingface'],
  ['arx', 'arxiv'],
  ['s2', 'semanticscholar'],
  ['oa', 'openalex'],
  ['pm', 'pubmed'],
  ['pub-med', 'pubmed'],
  ['hn', 'hackernews'],
  ['hacker-news', 'hackernews'],
  ['wiki', 'wikipedia'],
  ['wd', 'wikidata'],
  ['yandere', 'yande'],
  ['xb', 'xbooru'],
  ['gel', 'gelbooru'],
  ['real', 'realbooru'],
  ['safe', 'safebooru'],
  ['ph', 'pornhub'],
  ['xv', 'xvideos'],
  ['ta', 'thisav'],
  ['js', 'javstore'],
  ['ep', 'eporner'],
  ['sb', 'spankbang'],
])

/** Engines that answer `/image` at all (web image search plus the booru tags). */
const IMAGE_ENGINES = new Set([
  'google', 'yandex', 'baidu', 'bing', 'duckduckgo', 'ecosia', 'brave',
  'yande', 'xbooru', 'tbib', 'gelbooru', 'realbooru', 'safebooru',
])

export function normalizeEngineName(value) {
  const name = String(value).trim().toLowerCase()
  return ENGINE_ALIASES.get(name) ?? name
}

/** Canonical engine list, deduped and order-preserving. */
export function normalizeEngines(values) {
  if (values === undefined || values === null) return []
  const list = Array.isArray(values) ? values : [values]
  const out = []
  const seen = new Set()
  for (const value of list) {
    if (typeof value !== 'string') continue
    for (const part of value.split(',')) {
      const trimmed = part.trim()
      if (trimmed.length === 0) continue
      const name = normalizeEngineName(trimmed)
      if (seen.has(name)) continue
      seen.add(name)
      out.push(name)
    }
  }
  return out
}

export function isImageEngine(name) {
  return IMAGE_ENGINES.has(normalizeEngineName(name))
}

/** Split a possibly comma-separated credential value into trimmed keys. */
export function parseKeyList(value) {
  if (typeof value !== 'string') return []
  const out = []
  const seen = new Set()
  for (const part of value.split(',')) {
    const key = part.trim()
    if (key.length === 0 || seen.has(key)) continue
    seen.add(key)
    out.push(key)
  }
  return out
}

/** Fingerprint a key for logs and errors. Never reveals the whole secret. */
export function maskKey(value) {
  if (typeof value !== 'string' || value.length === 0) return ''
  if (value.length <= 14) return value.slice(0, 4) + '…'
  return value.slice(0, 10) + '…' + value.slice(-4)
}

/** Clamp an integer into [min, max]; `fallback` when unset or not a number. */
export function clampInt(value, min, max, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

/* ------------------------------------------------------------------------- *
 * Request building
 * ------------------------------------------------------------------------- */

function put(search, name, value) {
  if (value === undefined || value === null) return
  if (typeof value === 'string' && value.trim().length === 0) return
  search.set(name, String(value))
}

/**
 * The one query string a text search needs. `kind` picks the endpoint:
 * `search` for one engine, `mega` for a same-category multi-engine merge.
 */
export function buildSearchQuery(input) {
  const search = new URLSearchParams()
  put(search, 'text', input.text)
  if (input.engines.length > 0) put(search, 'engines', input.engines.join(','))
  put(search, 'lang', input.lang)
  put(search, 'region', input.region)
  put(search, 'limit', input.limit)
  put(search, 'start', input.start)
  put(search, 'site', input.site)
  put(search, 'file', input.file)
  put(search, 'date', input.date)
  return search.toString()
}

export function buildImageQuery(input) {
  const search = new URLSearchParams()
  put(search, 'text', input.text)
  if (input.engines.length > 0) put(search, 'engines', input.engines.join(','))
  put(search, 'limit', input.limit)
  put(search, 'site', input.site)
  return search.toString()
}

/**
 * JSON, not `format=markdown`: the markdown response is a bare text body, while
 * the JSON envelope carries the same `markdown` field plus title, description,
 * language and the cache status.
 */
export function buildExtractQuery(url, cache) {
  const search = new URLSearchParams()
  put(search, 'url', url)
  put(search, 'format', 'json')
  put(search, 'cache', cache)
  return search.toString()
}

/* ------------------------------------------------------------------------- *
 * Projection
 * ------------------------------------------------------------------------- */

function str(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** One text result, or `undefined` when it has no usable URL. */
function projectResult(raw) {
  if (raw === null || typeof raw !== 'object') return undefined
  const url = str(raw.url)
  if (url === undefined) return undefined
  return {
    url,
    ...(str(raw.title) !== undefined ? { title: raw.title } : {}),
    ...(str(raw.snippet) !== undefined ? { snippet: raw.snippet } : {}),
    ...(str(raw.engine) !== undefined ? { engine: raw.engine } : {}),
  }
}

/** One image result: the image URL, its page, and the tags the engine sent. */
function projectImage(raw) {
  if (raw === null || typeof raw !== 'object') return undefined
  const image = raw.image !== null && typeof raw.image === 'object' ? raw.image : undefined
  const imageUrl = image === undefined ? undefined : str(image.url)
  if (imageUrl === undefined) return undefined
  const source = raw.source !== null && typeof raw.source === 'object' ? raw.source : undefined
  const pageUrl = source === undefined ? undefined : str(source.page_url)
  return {
    imageUrl,
    ...(pageUrl !== undefined ? { pageUrl } : {}),
    ...(str(raw.title) !== undefined ? { title: raw.title } : {}),
    ...(str(raw.snippet) !== undefined ? { snippet: raw.snippet } : {}),
    ...(str(raw.engine) !== undefined ? { engine: raw.engine } : {}),
  }
}

function projectEngineNames(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : []
}

/** Shared envelope projection for `/search`, `/mega/search` and `/image`. */
function projectEnvelope(json, projectOne) {
  const results = Array.isArray(json?.results)
    ? json.results.flatMap((raw) => {
      const one = projectOne(raw)
      return one === undefined ? [] : [one]
    })
    : []
  const meta = json?.meta !== null && typeof json?.meta === 'object' ? json.meta : {}
  const out = { results }
  const failed = projectEngineNames(meta.engines_failed)
  if (failed.length > 0) out.enginesFailed = failed
  const tookMs = typeof meta.took_ms === 'number' ? meta.took_ms : undefined
  if (tookMs !== undefined) out.tookMs = tookMs
  const requestId = str(meta.request_id)
  if (requestId !== undefined) out.requestId = requestId
  const pagination = json?.pagination !== null && typeof json?.pagination === 'object' ? json.pagination : undefined
  if (pagination !== undefined) {
    if (pagination.has_more === true && typeof pagination.next_start === 'number') {
      out.hasMore = true
      out.nextStart = pagination.next_start
    }
  }
  // A vertical catalog with zero hits ships a routing hint in the body; surface
  // it so the model switches engine instead of repeating the call.
  const hint = str(json?.routing_hint) ?? str(json?.hint)
  if (hint !== undefined) out.hint = hint
  const note = str(json?.note)
  if (note !== undefined) out.note = note
  return out
}

export function projectSearch(json) {
  return projectEnvelope(json, projectResult)
}

export function projectImages(json) {
  return projectEnvelope(json, projectImage)
}

export function projectExtract(json, reader) {
  const markdown = str(json?.markdown)
  const text = str(json?.text)
  const content = markdown ?? text
  if (content === undefined) return undefined
  const meta = json?.meta !== null && typeof json?.meta === 'object' ? json.meta : {}
  return {
    url: str(json?.url) ?? '',
    reader,
    content,
    ...(str(json?.title) !== undefined ? { title: json.title } : {}),
    ...(str(json?.description) !== undefined ? { description: json.description } : {}),
    ...(str(json?.lang) !== undefined ? { lang: json.lang } : {}),
    ...(str(meta.cache_status) !== undefined ? { cacheStatus: meta.cache_status } : {}),
  }
}

export function projectUsage(json) {
  const usage = json?.usage !== null && typeof json?.usage === 'object' ? json.usage : {}
  const num = (value) => (typeof value === 'number' ? value : undefined)
  return {
    name: str(json?.name) ?? '',
    status: str(json?.status) ?? 'unknown',
    keyPrefix: str(json?.key_prefix) ?? '',
    rpm: {
      ...(num(json?.rpm_limit) !== undefined ? { limit: json.rpm_limit } : {}),
      ...(num(json?.rpm_burst) !== undefined ? { burst: json.rpm_burst } : {}),
    },
    quota: {
      ...(num(usage.total_used) !== undefined ? { used: usage.total_used } : {}),
      ...(num(usage.total_limit) !== undefined ? { limit: usage.total_limit } : {}),
      ...(num(usage.total_remain) !== undefined ? { remaining: usage.total_remain } : {}),
    },
    costs: {
      search: num(json?.cost_search) ?? 0,
      mega: num(json?.cost_mega) ?? 0,
      extract: num(json?.cost_extract) ?? 0,
    },
  }
}

export function projectEngines(json) {
  const engines = Array.isArray(json?.engines)
    ? json.engines.flatMap((raw) => {
      const name = str(raw?.name)
      if (name === undefined) return []
      return [{ name, ...(str(raw?.circuit_state) !== undefined ? { circuit: raw.circuit_state } : {}) }]
    })
    : []
  return { engines }
}

/* ------------------------------------------------------------------------- *
 * Rendering — compact text for the model, not a JSON dump
 * ------------------------------------------------------------------------- */

export function renderSearch(_args, value) {
  const lines = []
  if (value.results.length === 0) {
    lines.push('No results.')
  } else {
    value.results.forEach((item, index) => {
      const engine = item.engine === undefined ? '' : ' [' + item.engine + ']'
      lines.push((index + 1) + '. ' + (item.title ?? item.url) + engine)
      lines.push('   ' + item.url)
      if (item.snippet !== undefined) lines.push('   ' + item.snippet)
    })
  }
  if (value.hint !== undefined) lines.push('Routing hint: ' + value.hint)
  if (value.enginesFailed !== undefined) lines.push('Engines failed: ' + value.enginesFailed.join(', '))
  if (value.hasMore === true) lines.push('More available: start=' + value.nextStart)
  return [{ type: 'text', text: lines.join('\n') }]
}

export function renderImages(_args, value) {
  const lines = []
  if (value.results.length === 0) lines.push('No images.')
  value.results.forEach((item, index) => {
    lines.push((index + 1) + '. ' + (item.title ?? item.imageUrl))
    lines.push('   image: ' + item.imageUrl)
    if (item.pageUrl !== undefined) lines.push('   page:  ' + item.pageUrl)
    if (item.snippet !== undefined) lines.push('   ' + item.snippet)
  })
  if (value.hint !== undefined) lines.push('Routing hint: ' + value.hint)
  if (value.enginesFailed !== undefined) lines.push('Engines failed: ' + value.enginesFailed.join(', '))
  if (value.hasMore === true) lines.push('More available: start=' + value.nextStart)
  return [{ type: 'text', text: lines.join('\n') }]
}

export function renderExtract(_args, value) {
  return [{ type: 'text', text: value.content }]
}

export function renderUsage(_args, value) {
  const parts = [
    'key: ' + (value.name.length > 0 ? value.name : '(unnamed)') + ' ' + value.keyPrefix,
    'status: ' + value.status,
    'quota: ' + (value.quota.used ?? '?') + ' used / ' + (value.quota.limit ?? '?') + ' limit, ' + (value.quota.remaining ?? '?') + ' remaining',
    'rpm: ' + (value.rpm.limit ?? '?') + ' (burst ' + (value.rpm.burst ?? '?') + ')',
    'cost per call: search ' + value.costs.search + ', mega ' + value.costs.mega + ', extract ' + value.costs.extract,
  ]
  return [{ type: 'text', text: parts.join('\n') }]
}

export function renderEngines(_args, value) {
  if (value.engines.length === 0) return [{ type: 'text', text: 'No engines reported.' }]
  const text = value.engines
    .map((engine) => engine.name + (engine.circuit === undefined ? '' : ' (' + engine.circuit + ')'))
    .join('\n')
  return [{ type: 'text', text }]
}

/* ------------------------------------------------------------------------- *
 * Failure classification
 * ------------------------------------------------------------------------- */

/**
 * Classify a non-2xx Fathom response.
 *
 * The status alone is not enough. A dead engine answers `503` with
 * `meta.engine` — the key is fine and no other key would help — while a genuine
 * rate limit answers `429` without it. Replaying an engine failure on the next
 * key burns quota and returns the same failure, so the body decides:
 *
 *   `engine`    the named engine refused or is circuit-open; the account is fine
 *   `key`       the key itself was refused; another key may work
 *   `transient` the upstream failed in a way worth replaying once
 *   `fatal`     the request was wrong; replaying cannot help
 *
 * @returns `{ kind, engine?, retryInSeconds?, message }`
 */
export function classifyFailure(status, json) {
  const reason = typeof json?.reason === 'string' && json.reason.length > 0 ? json.reason : undefined
  const error = typeof json?.error === 'string' && json.error.length > 0 ? json.error : undefined
  const message = typeof json?.message === 'string' && json.message.length > 0 ? json.message : undefined
  const requestId = typeof json?.request_id === 'string' ? json.request_id : undefined
  const engine = typeof json?.meta?.engine === 'string' ? json.meta.engine : undefined
  const retryInSeconds = typeof json?.meta?.retry_in === 'number' ? json.meta.retry_in : undefined
  const tail = requestId === undefined ? '' : ' (request ' + requestId + ')'
  const detail = [message ?? reason].filter((part) => part !== undefined).join(' — ')

  // A named engine failing is about the engine, whatever the status says.
  if (engine !== undefined) {
    const wait = retryInSeconds === undefined ? '' : ' — retry in about ' + retryInSeconds + 's'
    return {
      kind: 'engine',
      engine,
      ...retryInSeconds === undefined ? {} : { retryInSeconds },
      message: 'engine "' + engine + '" is unavailable' + wait +
        '; the API key is fine, so retry with another engine' + tail,
    }
  }

  if (status === 401) {
    return { kind: 'key', message: 'the API key is missing or invalid: ' + detail + tail }
  }
  if (status === 403) {
    return {
      kind: reason === 'NSFW_REQUIRED' ? 'fatal' : 'key',
      message: (reason === 'NSFW_REQUIRED'
        ? 'that engine needs NSFW enabled on the account'
        : 'the API key is revoked or lacks access') + (detail.length > 0 ? ': ' + detail : '') + tail,
    }
  }
  if (status === 429) {
    return { kind: 'key', message: 'rate limit, period quota or balance is exhausted: ' + detail + tail }
  }
  if (status === 502 || status === 503 || status === 504) {
    const head = status === 504
      ? 'the search engine or page parser timed out'
      : status === 503
        ? 'the service is temporarily unavailable'
        : 'an upstream engine, proxy or page parser failed'
    return { kind: 'transient', message: head + (detail.length > 0 ? ': ' + detail : '') + tail }
  }
  if (status === 400) {
    return { kind: 'fatal', message: 'the request parameters were rejected: ' + detail + tail }
  }
  return { kind: 'fatal', message: 'the request failed with HTTP ' + status + (detail.length > 0 ? ': ' + detail : '') + tail }
}

/** Human-readable cause for a non-2xx Fathom response. */
export function describeFailure(status, json) {
  return classifyFailure(status, json).message
}

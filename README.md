# dsh-fathom

Fathom Search tools for the DeepSeek Harness.

[Fathom Search](https://fathomsearch.xyz/docs) is a multi-engine search API: one
endpoint in front of web engines (DuckDuckGo, Brave, Google, Bing, Baidu,
Yandex, Ecosia, Grok) and vertical catalogs (GitHub, Hugging Face, arXiv,
Semantic Scholar, OpenAlex, PubMed, Wikidata, Wikipedia, Hacker News).

This plugin adds five model tools. It is **additive**: no web search provider is
registered, `ctx.web` is never touched, and the built-in `web_search` keeps
whatever provider it already had.

## Tools

| Tool | Endpoint | Use it for |
|---|---|---|
| `fathom_search` | `/search`, `/mega/search` | Web results, or one vertical catalog |
| `fathom_image_search` | `/image` | Image URLs with their source page |
| `fathom_extract` | `/extract` | Full page body as Markdown |
| `fathom_usage` | `/me` | Remaining quota, rate limit, cost per call |
| `fathom_engines` | `/mega/engines` | Canonical engine names and circuit state |

## Install

Package name: **`@cycspring/dsh-fathom`**. The bundle row it inserts is
`dsh-fathom` (see `cordis.patch.yml`) — one row, no other plugins required.

From a local checkout, point the plugin manager at the package directory:

```
plugin_manager  action: install_bundle  target: /absolute/path/to/dsh-fathom
```

`target` is the directory holding `package.json`, so any clone works; there is
no npm publish required and nothing else to install first. This bundle imports
no `@deepseek-ai/*` packages, which is what lets a linked checkout load at all
(see Notes).

## Setup

Save a key from <https://fathomsearch.xyz/dashboard> under the credential name
`FATHOM_API_KEY` — the same file the rest of the Harness reads:

```yaml
# ~/.dsh/.credentials.yaml
refs:
  FATHOM_API_KEY: ft-xxxxxxxx
```

Several keys may be given as a comma-separated `FATHOM_API_KEYS`, or as a
comma-separated `FATHOM_API_KEY`. Keys are read on every call, so adding one
needs no restart. A key-scoped refusal (`401`, `403`, `429`) moves the call to
the next key; a transient upstream failure (`502`, `503`, `504`) is retried on
the same key first.

The key may also come from the launching environment as a fallback, but the
credential file wins when both are set.

## Routing

One engine per intent. Naming two or more engines merges them through
`/mega/search`, which is only meaningful within one category — two web engines
to widen one query, never a web engine plus a vertical catalog.

| Intent | Engine |
|---|---|
| News, docs, how-to, product | `duckduckgo` + `brave` (default) |
| Source code, repos, issues | `github` |
| ML weights, datasets, Spaces | `huggingface` |
| Papers | `arxiv`, `semanticscholar`, `openalex`, `pubmed` |
| Structured entity | `wikidata` |
| Definition or fact | `wikipedia` (+ `lang`) |
| Tech discourse | `hackernews` |
| X/Twitter posts and trends | `grok` with `site=x.com` |
| Chinese web | `baidu`, `region=CN` |

An engine name is normalized, so `gh`, `hf`, `ddg`, `pm` and similar aliases
resolve to the canonical names.

## Config

Every field is optional; the row's `config` overrides these defaults.

| Field | Default | Meaning |
|---|---|---|
| `baseUrl` | `https://fathomsearch.xyz` | API origin |
| `defaultEngines` | `["duckduckgo"]` | Engines used when a caller names none |
| `maxKeys` | `8` | Cap on keys read from the credential |
| `retries` | `1` | Retries per key for a transient failure (0–3) |
| `jinaFirst` | `true` | Try Jina Reader before Fathom `/extract` |

```yaml
- id: dsh-fathom
  config:
    defaultEngines: [duckduckgo]
    jinaFirst: false
```

`jinaFirst` reads the page through `r.jina.ai` first and falls back to Fathom's
`/extract`, which saves extract quota when the reader is reachable.

## Notes

- Search and extract are capped at 120 s per request; `/mega/search` has been
  observed at ~60 s upstream, and some verticals are slower.
- A single default engine, not a pair. Merging two web engines routes every
  default call through `/mega/search`, which costs more and fails wholesale when
  either engine's circuit is open — observed live, where a circuit-open Brave
  failed every default search while DuckDuckGo alone answered in under a second.
  Ask for `["duckduckgo", "brave"]` explicitly when redundancy is wanted.
- Failures are classified by the response body, not the status alone. A dead
  engine answers `503 circuit_open` with `meta.engine`: the key is fine, no
  other key would help, and the error tells the caller to pick another engine.
  Only a true `401`/`403`/`429` without `meta.engine` advances to the next key.
- The account's NSFW gate is the service's, not this plugin's: a gated engine
  reports `403 NSFW_REQUIRED` and the error is surfaced rather than retried.
- `jinaFirst` is best-effort. `r.jina.ai` was unreachable from the machine this
  was built on, so the Fathom `/extract` path is the one actually exercised.
- This bundle imports nothing from `@deepseek-ai/*`. A bundle installed from a
  workspace directory is linked into the profile, and Node then cannot resolve
  the Harness's own packages from it — `import … from '@deepseek-ai/dsh-tools'`
  fails with `ERR_MODULE_NOT_FOUND`. The tool authoring, schema compilation and
  argument validation it needs are therefore in `lib/schema.js`; the schemas it
  emits are validated by the real registry on registration.

## License

MIT.

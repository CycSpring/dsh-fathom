/**
 * The tiny slice of tool authoring this bundle needs, implemented locally.
 *
 * A bundle installed from a workspace directory is linked into the profile, and
 * Node's bare-specifier resolution then cannot see the Harness's own packages,
 * so `import { defineTool } from '@deepseek-ai/dsh-tools'` fails at load time.
 * Nothing here is worth that dependency: `ctx.tools.register` accepts a plain
 * definition, and the enforced JSON Schema subset is small enough to emit and
 * check directly.
 *
 * The authoring form is a plain property map — `{ type, required, description,
 * enum, items, properties }` — which {@link toJsonSchema} rewrites into the
 * real JSON Schema the registry and the model see (`required: [...]` arrays,
 * not booleans).
 */

const ANNOTATION_KEYWORDS = ['description', 'title', 'default', 'examples']

/**
 * Rewrite one author node into the enforced JSON Schema subset: `type`,
 * `oneOf`, `properties`, `required`, `additionalProperties`, `items`, `enum`,
 * `const`, plus annotations.
 */
function compileNode(node, path) {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) {
    throw new TypeError('schema at ' + path + ' must be an object')
  }
  const out = {}
  const type = node.type

  if (type === 'oneOf' || Array.isArray(node.oneOf)) {
    if (!Array.isArray(node.oneOf) || node.oneOf.length < 2) {
      throw new TypeError('schema at ' + path + ' must declare oneOf with at least two branches')
    }
    out.oneOf = node.oneOf.map((branch, index) => compileNode(branch, path + '.oneOf[' + index + ']'))
  } else if (type === 'object' || node.properties !== undefined) {
    out.type = 'object'
    if (node.properties !== undefined) {
      if (typeof node.properties !== 'object' || node.properties === null) {
        throw new TypeError('schema at ' + path + '.properties must be a property map')
      }
      out.properties = {}
      const required = []
      for (const [key, child] of Object.entries(node.properties)) {
        out.properties[key] = compileNode(child, path + '.properties.' + key)
        if (child.required === true) required.push(key)
      }
      if (required.length > 0) out.required = required
    }
    if (node.additionalProperties !== undefined) out.additionalProperties = node.additionalProperties
  } else if (type === 'array') {
    out.type = 'array'
    if (node.items !== undefined) out.items = compileNode(node.items, path + '.items')
  } else if (typeof type === 'string') {
    out.type = type
  } else {
    throw new TypeError('schema at ' + path + ' must declare a type')
  }

  if (node.enum !== undefined) {
    if (!Array.isArray(node.enum) || node.enum.length === 0) {
      throw new TypeError('schema at ' + path + '.enum must be a non-empty array')
    }
    out.enum = [...node.enum]
  }
  if (node.const !== undefined) out.const = node.const
  for (const keyword of ANNOTATION_KEYWORDS) {
    if (node[keyword] !== undefined) out[keyword] = node[keyword]
  }
  return out
}

/** Rewrite an author property map into a root object schema. */
export function toJsonSchema(spec, path = 'schema') {
  return compileNode(spec, path)
}

function typeOf(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number'
  return typeof value
}

function typeMatches(expected, actual) {
  if (expected === actual) return true
  // A JSON number satisfies `integer` only when it really is one, and an
  // integral value satisfies `number`.
  return expected === 'number' && actual === 'integer'
}

/**
 * Check a value against the subset {@link toJsonSchema} emits, returning
 * path-qualified violations. An empty array means valid.
 */
export function validateValue(schema, value, path = '') {
  const at = path.length === 0 ? '(root)' : path
  if (Array.isArray(schema.oneOf)) {
    const attempts = schema.oneOf.map((branch, index) => validateValue(branch, value, path))
    if (attempts.some((violations) => violations.length === 0)) return []
    return [at + ' matches none of the oneOf branches']
  }
  if (schema.const !== undefined && value !== schema.const) {
    return [at + ' must equal ' + JSON.stringify(schema.const)]
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    return [at + ' must be one of ' + schema.enum.join(', ')]
  }
  if (schema.type === undefined) return []
  const actual = typeOf(value)
  if (!typeMatches(schema.type, actual)) {
    return [at + ' must be ' + schema.type + ', got ' + actual]
  }
  const violations = []
  if (schema.type === 'object') {
    const declared = schema.properties ?? {}
    for (const name of schema.required ?? []) {
      if (!Object.hasOwn(value, name) || value[name] === undefined) {
        violations.push((path.length === 0 ? '' : path + '.') + name + ' is required')
      }
    }
    for (const [name, child] of Object.entries(declared)) {
      if (value[name] === undefined) continue
      violations.push(...validateValue(child, value[name], path.length === 0 ? name : path + '.' + name))
    }
    if (schema.additionalProperties === false) {
      for (const name of Object.keys(value)) {
        if (!Object.hasOwn(declared, name)) violations.push((path.length === 0 ? '' : path + '.') + name + ' is not a declared property')
      }
    }
  } else if (schema.type === 'array' && schema.items !== undefined) {
    value.forEach((entry, index) => {
      violations.push(...validateValue(schema.items, entry, path + '[' + index + ']'))
    })
  }
  return violations
}

/**
 * Build a registry-ready definition from the authoring form, validating the
 * model's arguments before the body runs so a malformed call fails with a
 * precise message instead of searching for nothing.
 */
export function defineTool(options) {
  if (typeof options.name !== 'string' || options.name.length === 0) {
    throw new TypeError('defineTool: name must be a non-empty string')
  }
  if (typeof options.execute !== 'function') {
    throw new TypeError('defineTool(' + options.name + '): execute must be a function')
  }
  if (options.output === undefined || typeof options.output.render !== 'function') {
    throw new TypeError('defineTool(' + options.name + '): output must declare { schema, render }')
  }
  if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
    throw new TypeError('defineTool(' + options.name + '): timeoutMs must be a positive finite number')
  }
  const authorParameters = options.parameters ?? {}
  if (typeof authorParameters !== 'object' || authorParameters === null || Array.isArray(authorParameters)) {
    throw new TypeError('defineTool(' + options.name + '): parameters must be a property map')
  }
  const parameters = compileNode(
    { type: 'object', properties: authorParameters },
    options.name + ' parameters',
  )
  const outputSchema = toJsonSchema(options.output.schema, options.name + ' output')

  return {
    name: options.name,
    description: options.description,
    parameters,
    output: { schema: outputSchema, render: options.output.render },
    ...options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {},
    ...options.isConcurrencySafe !== undefined ? { isConcurrencySafe: options.isConcurrencySafe } : {},
    async execute(args, exec) {
      const violations = validateValue(parameters, args ?? {}, '')
      if (violations.length > 0) {
        throw new Error(options.name + ': invalid arguments — ' + violations.join('; '))
      }
      return options.execute(args ?? {}, exec)
    },
  }
}

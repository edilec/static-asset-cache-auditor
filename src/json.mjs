export class JsonInputError extends Error {
  constructor(message) { super(message); this.name = 'JsonInputError' }
}

function canonicalDecimal(token) {
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?)(\d+))?$/.exec(token)
  if (!match) throw new JsonInputError('JSON number cannot be interpreted exactly.')
  const fractional = match[3] ?? ''
  let digits = `${match[2]}${fractional}`.replace(/^0+/, '')
  if (digits === '') return match[1] === '-' ? '-0' : '0'
  const exponentDigits = (match[5] ?? '0').replace(/^0+/, '') || '0'
  const largest = String(token.length + 324)
  if (exponentDigits.length > largest.length
      || (exponentDigits.length === largest.length && exponentDigits > largest)) {
    throw new JsonInputError('JSON number cannot be interpreted exactly.')
  }
  let exponent = BigInt(exponentDigits) * (match[4] === '-' ? -1n : 1n) - BigInt(fractional.length)
  const trailing = digits.match(/0+$/)?.[0].length ?? 0
  digits = digits.slice(0, digits.length - trailing)
  exponent += BigInt(trailing)
  return `${match[1]}${digits}e${exponent}`
}

function assertNumericPrecision(token) {
  const value = Number(token)
  if (!Number.isFinite(value) || canonicalDecimal(token) !== canonicalDecimal(value.toString())) {
    throw new JsonInputError('JSON number loses precision.')
  }
}

// JSON.parse establishes syntax; this scanner preserves member-key evidence
// that JSON.parse would otherwise overwrite and checks structural depth.
export function parseStrictJson(text, maxDepth) {
  let value
  try { value = JSON.parse(text) }
  catch { throw new JsonInputError('Invalid JSON input.') }
  const stack = []
  const consumeValue = () => {
    const parent = stack.at(-1)
    if (parent && (parent.state === 'value' || parent.state === 'valueOrClose')) {
      parent.state = 'commaOrClose'
    }
  }
  let at = 0
  while (at < text.length) {
    const char = text[at]
    if (char === ' ' || char === '\n' || char === '\r' || char === '\t') { at += 1; continue }
    if (char === '"') {
      const start = at
      at += 1
      while (at < text.length) {
        if (text[at] === '\\') { at += 2; continue }
        if (text[at] === '"') { at += 1; break }
        at += 1
      }
      const parent = stack.at(-1)
      if (parent?.kind === 'object' && parent.state === 'keyOrClose') {
        const key = JSON.parse(text.slice(start, at))
        if (parent.keys.has(key)) throw new JsonInputError('JSON contains a duplicate key.')
        parent.keys.add(key)
        parent.state = 'colon'
      } else consumeValue()
      continue
    }
    if (char === '{' || char === '[') {
      consumeValue()
      if (stack.length + 1 > maxDepth) throw new JsonInputError('JSON depth limit exceeded.')
      stack.push(char === '{'
        ? { kind: 'object', state: 'keyOrClose', keys: new Set() }
        : { kind: 'array', state: 'valueOrClose' })
      at += 1
      continue
    }
    if (char === '}' || char === ']') { stack.pop(); at += 1; continue }
    if (char === ':') { stack.at(-1).state = 'value'; at += 1; continue }
    if (char === ',') {
      const parent = stack.at(-1)
      parent.state = parent.kind === 'object' ? 'keyOrClose' : 'valueOrClose'
      at += 1
      continue
    }
    const start = at
    while (at < text.length && !/[\s,}\]]/.test(text[at])) at += 1
    const token = text.slice(start, at)
    if (/^-?[0-9]/.test(token)) assertNumericPrecision(token)
    consumeValue()
  }
  return value
}

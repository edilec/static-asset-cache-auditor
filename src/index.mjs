import { ConfigError, makeFinding, makeReport, TOOL_ID, validateLimits } from './report.mjs'

export { TOOL_ID }

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const natural = (value) => Number.isSafeInteger(value) && value >= 0
const identifier = (value) => typeof value === 'string'
  && value.length <= 80 && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)
const visible = (value) => typeof value === 'string'
  && value.replace(/[\p{Default_Ignorable_Code_Point}\u0000-\u001f\u007f-\u009f\u2028\u2029]/gu, '').trim().length > 0
const hashNamed = (url) => /[.-][0-9a-f]{8,64}\.[A-Za-z0-9]+$/.test(new URL(url).pathname)

class DeadlineError extends Error {}

function validUrl(value) {
  if (typeof value !== 'string' || value.length === 0) return false
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:')
      && url.username === '' && url.password === '' && url.hash === ''
  } catch { return false }
}

function captureHeaders(headers) {
  const names = new Map()
  const policyHeaders = new Set(['cache-control', 'etag', 'last-modified'])
  for (const header of headers) {
    if (!object(header) || typeof header.name !== 'string' || typeof header.value !== 'string'
      || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(header.name)) return { rule: 'header-invalid' }
    const key = header.name.toLowerCase()
    if (names.has(key) && policyHeaders.has(key)) return { rule: 'header-ambiguous' }
    names.set(key, header.value)
  }
  const cache = names.get('cache-control')
  if (cache === undefined) return { rule: 'cache-policy-missing' }
  if (!visible(cache)) return { rule: 'header-invalid' }
  const directives = new Map()
  const booleanDirectives = new Set(['immutable', 'no-cache', 'no-store', 'public', 'private', 'must-revalidate', 'proxy-revalidate'])
  for (const part of cache.split(',')) {
    const item = part.trim()
    const match = /^([a-z][a-z-]*)(?:=(.*))?$/i.exec(item)
    if (!match) return { rule: 'header-invalid' }
    const key = match[1].toLowerCase()
    if (directives.has(key)) return { rule: 'header-ambiguous' }
    const raw = match[2]
    if (key === 'max-age' || key === 's-maxage') {
      if (raw === undefined || !/^[0-9]+$/.test(raw)) return { rule: 'header-invalid' }
      const value = Number(raw)
      if (!Number.isSafeInteger(value)) return { rule: 'header-invalid' }
      directives.set(key, value)
    } else if (booleanDirectives.has(key) && raw === undefined) {
      directives.set(key, true)
    } else return { rule: 'header-invalid' }
  }
  if (directives.has('immutable') && directives.has('no-cache')) return { rule: 'header-ambiguous' }
  if (directives.has('no-store') && (directives.has('immutable')
    || directives.has('max-age') || directives.has('s-maxage'))) return { rule: 'header-ambiguous' }
  if (directives.has('public') && directives.has('private')) return { rule: 'header-ambiguous' }
  const validator = names.get('etag') ?? names.get('last-modified')
  if (validator !== undefined && !visible(validator)) return { rule: 'header-invalid' }
  return { directives, validator: validator !== undefined }
}

export function auditAssetCache(document, { limits: overrides, now = Date.now, file = 'input.json' } = {}) {
  const limits = validateLimits(overrides)
  if (typeof now !== 'function') throw new ConfigError('now must be a clock function')
  if (typeof file !== 'string' || file.length === 0) throw new ConfigError('file must be a nonempty string')
  const started = now()
  if (!Number.isFinite(started)) throw new ConfigError('now must return a finite number')
  const checkpoint = () => {
    const current = now()
    if (!Number.isFinite(current)) throw new ConfigError('now must return a finite number')
    if (current - started > limits.timeoutMs) throw new DeadlineError()
  }
  const findings = []
  let checked = 0
  let truncated = false
  const add = (ruleId, pointer = '') => {
    if (findings.length >= limits.maxFindings) { truncated = true; return }
    findings.push(makeFinding(ruleId, file, pointer))
  }
  const finish = () => {
    if (truncated) findings.push(makeFinding('findings-truncated', file))
    return makeReport(findings, checked)
  }
  try {
    checkpoint()
    if (!object(document) || document.schemaVersion !== '1'
      || !Array.isArray(document.manifest) || !Array.isArray(document.captures)) {
      add('input-invalid')
      return finish()
    }
    const policy = document.policy
    if (!object(policy) || !natural(policy.mutableMaxAgeSeconds)
      || !natural(policy.immutableMinAgeSeconds)) {
      add('policy-invalid', '/policy')
      return finish()
    }
    if (document.manifest.length > limits.maxAssets || document.captures.length > limits.maxAssets) {
      add('asset-limit')
      return finish()
    }
    if (document.manifest.length === 0 && document.captures.length === 0) {
      add('no-assets')
      return finish()
    }

    const assets = new Map()
    const ids = new Set()
    let manifestComplete = true
    for (const [at, asset] of document.manifest.entries()) {
      checkpoint()
      const pointer = `/manifest/${at}`
      if (!object(asset) || !identifier(asset.id) || !validUrl(asset.url)
        || (asset.kind !== 'mutable' && asset.kind !== 'immutable')) {
        manifestComplete = false
        add('manifest-invalid', pointer)
        continue
      }
      if (ids.has(asset.id) || assets.has(asset.url)) {
        manifestComplete = false
        add('manifest-duplicate', pointer)
        continue
      }
      ids.add(asset.id)
      assets.set(asset.url, { ...asset, pointer })
    }

    const captures = new Map()
    let captureComplete = true
    for (const [at, capture] of document.captures.entries()) {
      checkpoint()
      const pointer = `/captures/${at}`
      if (!object(capture) || !validUrl(capture.url) || !Array.isArray(capture.headers)) {
        captureComplete = false
        add('capture-invalid', pointer)
        continue
      }
      if (captures.has(capture.url)) {
        captureComplete = false
        captures.set(capture.url, null)
        add('capture-duplicate', pointer)
        continue
      }
      captures.set(capture.url, { ...capture, pointer })
    }

    if (manifestComplete) {
      for (const [url, capture] of captures) {
        checkpoint()
        if (capture !== null && !assets.has(url)) add('capture-extra', capture.pointer)
      }
    }

    for (const [url, asset] of assets) {
      checkpoint()
      const capture = captures.get(url)
      if (capture === undefined) {
        if (captureComplete) add('capture-missing', asset.pointer)
        continue
      }
      if (capture === null) continue
      const parsed = captureHeaders(capture.headers)
      if (parsed.rule) {
        add(parsed.rule, asset.pointer)
        if (parsed.rule === 'cache-policy-missing') checked += 1
        continue
      }
      checked += 1
      const controls = parsed.directives
      if (asset.kind === 'immutable') {
        if (!hashNamed(url)) add('immutable-name-unhashed', asset.pointer)
        if (!controls.has('immutable')) add('immutable-policy-missing', asset.pointer)
        const ttl = controls.get('max-age')
        if (ttl === undefined) add('header-invalid', asset.pointer)
        else if (ttl < policy.immutableMinAgeSeconds
          || (controls.get('s-maxage') ?? ttl) < policy.immutableMinAgeSeconds) {
          add('immutable-ttl-short', asset.pointer)
        }
      } else {
        if (controls.has('immutable')) add('mutable-immutable-policy', asset.pointer)
        if (!controls.has('no-cache') && ((controls.get('max-age') ?? 0) > policy.mutableMaxAgeSeconds
          || (controls.get('s-maxage') ?? 0) > policy.mutableMaxAgeSeconds)) {
          add('mutable-ttl-long', asset.pointer)
        }
        if (!controls.has('no-store') && !parsed.validator) add('mutable-validator-missing', asset.pointer)
        if (!controls.has('no-store') && !controls.has('no-cache')
          && !controls.has('max-age')) add('header-invalid', asset.pointer)
      }
    }
    return finish()
  } catch (error) {
    if (!(error instanceof DeadlineError)) throw error
    add('analysis-timeout')
    return finish()
  }
}

export const TOOL_ID = 'static-asset-cache-auditor'

export const DEFAULT_LIMITS = Object.freeze({
  maxBytes: 1048576,
  maxAssets: 1000,
  maxDepth: 32,
  maxFindings: 500,
  timeoutMs: 30000,
})

export const RULES = Object.freeze({
  'input-unreadable': { severity: 'error', incomplete: true, message: 'The input could not be read.' },
  'input-invalid': { severity: 'error', incomplete: true, message: 'The input is invalid or unsupported.' },
  'input-too-large': { severity: 'error', incomplete: true, message: 'The input exceeds the byte limit.' },
  'depth-limit': { severity: 'error', incomplete: true, message: 'The input exceeds the JSON depth limit.' },
  'asset-limit': { severity: 'error', incomplete: true, message: 'The input exceeds the asset count limit.' },
  'analysis-timeout': { severity: 'error', incomplete: true, message: 'The analysis time limit was exceeded.' },
  'findings-truncated': { severity: 'error', incomplete: true, message: 'The findings limit was reached; later observations are unknown.' },
  'no-assets': { severity: 'error', incomplete: true, message: 'No assets were supplied for inspection.' },
  'policy-invalid': { severity: 'error', incomplete: true, message: 'The declared cache policy is unusable.' },
  'manifest-invalid': { severity: 'error', incomplete: true, message: 'A manifest asset is unusable.' },
  'manifest-duplicate': { severity: 'error', incomplete: true, message: 'A manifest id or URL is duplicated.' },
  'capture-invalid': { severity: 'error', incomplete: true, message: 'A captured response is unusable.' },
  'capture-missing': { severity: 'error', incomplete: true, message: 'No captured response matches this manifest asset.' },
  'capture-duplicate': { severity: 'error', incomplete: true, message: 'More than one captured response matches this URL.' },
  'capture-extra': { severity: 'error', incomplete: true, message: 'A captured response has no manifest declaration.' },
  'header-ambiguous': { severity: 'error', incomplete: true, message: 'Captured cache headers are duplicated or contradictory.' },
  'header-invalid': { severity: 'error', incomplete: true, message: 'Captured cache headers cannot be interpreted.' },
  'cache-policy-missing': { severity: 'error', incomplete: false, message: 'The captured response has no Cache-Control policy.' },
  'immutable-name-unhashed': { severity: 'error', incomplete: false, message: 'An immutable asset lacks a hash-shaped filename.' },
  'immutable-policy-missing': { severity: 'error', incomplete: false, message: 'An immutable asset lacks an immutable cache directive.' },
  'immutable-ttl-short': { severity: 'error', incomplete: false, message: 'An immutable asset has a shorter TTL than declared policy requires.' },
  'mutable-immutable-policy': { severity: 'error', incomplete: false, message: 'A mutable asset declares immutable caching.' },
  'mutable-ttl-long': { severity: 'error', incomplete: false, message: 'A mutable asset exceeds its declared cache TTL.' },
  'mutable-validator-missing': { severity: 'error', incomplete: false, message: 'A cacheable mutable asset has no revalidation validator.' },
  'report-write-refused': { severity: 'error', incomplete: true, message: 'The report destination was refused or could not be written safely.' },
})
for (const rule of Object.values(RULES)) Object.freeze(rule)

export class ConfigError extends Error {
  constructor(message) { super(message); this.name = 'ConfigError' }
}

const byCodeUnit = (a, b) => a === b ? 0 : a < b ? -1 : 1
const safe = (value) => (typeof value === 'string' ? value : '')
  .replace(/[\p{Default_Ignorable_Code_Point}\u0000-\u001f\u007f-\u009f\u2028\u2029]/gu, '').slice(0, 160)

export function validateLimits(overrides = {}) {
  if (overrides === null || Array.isArray(overrides) || typeof overrides !== 'object') {
    throw new ConfigError('limits must be an object')
  }
  const limits = { ...DEFAULT_LIMITS }
  for (const [key, value] of Object.entries(overrides)) {
    if (!Object.hasOwn(DEFAULT_LIMITS, key)) throw new ConfigError(`Unknown limit "${key}"`)
    if (!Number.isSafeInteger(value) || value <= 0) throw new ConfigError(`${key} must be a positive integer`)
    if (key === 'timeoutMs' && value > 3600000) throw new ConfigError('timeoutMs must be at most 3600000')
    limits[key] = value
  }
  return Object.freeze(limits)
}

export function makeFinding(ruleId, file = 'input.json', pointer = '') {
  const rule = RULES[ruleId]
  if (rule === undefined) throw new TypeError(`Unknown ruleId "${ruleId}"`)
  return {
    ruleId,
    severity: rule.severity,
    message: rule.message,
    location: { file: safe(file) || 'input.json', ...(pointer ? { pointer: safe(pointer) } : {}) },
  }
}

export function makeReport(findings, checked) {
  const ordered = [...findings].sort((a, b) =>
    byCodeUnit(a.location.file, b.location.file)
    || byCodeUnit(a.location.pointer ?? '', b.location.pointer ?? '')
    || byCodeUnit(a.ruleId, b.ruleId))
  const errors = ordered.filter((finding) => finding.severity === 'error').length
  const warnings = ordered.filter((finding) => finding.severity === 'warning').length
  return {
    schemaVersion: '1',
    tool: TOOL_ID,
    status: ordered.some((finding) => RULES[finding.ruleId]?.incomplete)
      ? 'incomplete' : errors > 0 ? 'fail' : 'pass',
    summary: { checked, errors, warnings },
    findings: ordered,
  }
}

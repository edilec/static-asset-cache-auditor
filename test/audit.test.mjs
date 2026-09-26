import test from 'node:test'
import assert from 'node:assert/strict'
import { auditAssetCache, TOOL_ID } from '../src/index.mjs'

function cleanDocument() {
  return {
    schemaVersion: '1',
    policy: { mutableMaxAgeSeconds: 3600, immutableMinAgeSeconds: 31536000 },
    manifest: [
      { id: 'app-js', url: 'https://assets.example.test/app.abcdef12.js', kind: 'immutable' },
      { id: 'index-js', url: 'https://assets.example.test/index.js', kind: 'mutable' },
    ],
    captures: [
      { url: 'https://assets.example.test/app.abcdef12.js', headers: [
        { name: 'Cache-Control', value: 'public, max-age=31536000, immutable' },
      ] },
      { url: 'https://assets.example.test/index.js', headers: [
        { name: 'cache-control', value: 'public, max-age=3600' },
        { name: 'ETag', value: '"v1"' },
      ] },
    ],
  }
}

const rules = (report) => report.findings.map((finding) => finding.ruleId)

test('explicit immutable hashed and mutable revalidating assets pass', () => {
  const report = auditAssetCache(cleanDocument())
  assert.equal(TOOL_ID, 'static-asset-cache-auditor')
  assert.equal(report.status, 'pass')
  assert.equal(report.summary.checked, 2)
  assert.deepEqual(rules(report), [])
})

test('reordered equivalent captures still pass without false findings', () => {
  const document = cleanDocument()
  document.captures.reverse()
  const report = auditAssetCache(document)
  assert.equal(report.status, 'pass')
  assert.deepEqual(rules(report), [])
})

test('zero assets are incomplete rather than a vacuous pass', () => {
  const document = cleanDocument()
  document.manifest = []
  document.captures = []
  const report = auditAssetCache(document)
  assert.equal(report.status, 'incomplete')
  assert.deepEqual(rules(report), ['no-assets'])
})

test('a mutable URL with long immutable caching fails by manifest intent', () => {
  const document = cleanDocument()
  document.captures[1].headers[0].value = 'public, max-age=31536000, immutable'
  const report = auditAssetCache(document)
  assert.equal(report.status, 'fail')
  assert.deepEqual(rules(report), ['mutable-immutable-policy', 'mutable-ttl-long'])
})

test('a hashed-looking name declared mutable still obeys mutable policy', () => {
  const document = cleanDocument()
  document.manifest[1].url = 'https://assets.example.test/index.1234abcd.js'
  document.captures[1].url = document.manifest[1].url
  document.captures[1].headers[0].value = 'max-age=31536000, immutable'
  const report = auditAssetCache(document)
  assert.equal(report.status, 'fail')
  assert.deepEqual(rules(report), ['mutable-immutable-policy', 'mutable-ttl-long'])
})

test('mutable max-age is legal at N and fails at N+1', () => {
  const document = cleanDocument()
  document.policy.mutableMaxAgeSeconds = 60
  document.captures[1].headers[0].value = 'max-age=60'
  assert.equal(auditAssetCache(document).status, 'pass')
  document.captures[1].headers[0].value = 'max-age=61'
  const report = auditAssetCache(document)
  assert.equal(report.status, 'fail')
  assert.deepEqual(rules(report), ['mutable-ttl-long'])
})

test('mutable shared-cache max-age is also bounded at N and N+1', () => {
  const document = cleanDocument()
  document.policy.mutableMaxAgeSeconds = 60
  document.captures[1].headers[0].value = 'max-age=0, s-maxage=60'
  assert.equal(auditAssetCache(document).status, 'pass')
  document.captures[1].headers[0].value = 'max-age=0, s-maxage=61'
  assert.deepEqual(rules(auditAssetCache(document)), ['mutable-ttl-long'])
})

test('immutable minimum TTL is legal at N and fails at N-1', () => {
  const document = cleanDocument()
  document.policy.immutableMinAgeSeconds = 60
  document.captures[0].headers[0].value = 'max-age=60, immutable'
  assert.equal(auditAssetCache(document).status, 'pass')
  document.captures[0].headers[0].value = 'max-age=59, immutable'
  const report = auditAssetCache(document)
  assert.equal(report.status, 'fail')
  assert.deepEqual(rules(report), ['immutable-ttl-short'])
})

test('immutable shared-cache TTL is legal at N and fails at N-1', () => {
  const document = cleanDocument()
  document.policy.immutableMinAgeSeconds = 60
  document.captures[0].headers[0].value = 'max-age=60, s-maxage=60, immutable'
  assert.equal(auditAssetCache(document).status, 'pass')
  document.captures[0].headers[0].value = 'max-age=60, s-maxage=59, immutable'
  const report = auditAssetCache(document)
  assert.equal(report.status, 'fail')
  assert.deepEqual(rules(report), ['immutable-ttl-short'])
})

test('no-cache and immutable on one response are contradictory evidence', () => {
  const document = cleanDocument()
  document.captures[0].headers[0].value = 'max-age=31536000, no-cache, immutable'
  const report = auditAssetCache(document)
  assert.equal(report.status, 'incomplete')
  assert.deepEqual(rules(report), ['header-ambiguous'])
})

test('an immutable declaration without a hash-shaped filename fails', () => {
  const document = cleanDocument()
  document.manifest[0].url = 'https://assets.example.test/app.js'
  document.captures[0].url = document.manifest[0].url
  const report = auditAssetCache(document)
  assert.equal(report.status, 'fail')
  assert.deepEqual(rules(report), ['immutable-name-unhashed'])
})

test('an immutable declaration without immutable directive fails', () => {
  const document = cleanDocument()
  document.captures[0].headers[0].value = 'max-age=31536000'
  const report = auditAssetCache(document)
  assert.equal(report.status, 'fail')
  assert.deepEqual(rules(report), ['immutable-policy-missing'])
})

test('a cacheable mutable asset without validator fails', () => {
  const document = cleanDocument()
  document.captures[1].headers.pop()
  const report = auditAssetCache(document)
  assert.equal(report.status, 'fail')
  assert.deepEqual(rules(report), ['mutable-validator-missing'])
})

test('mutable no-store is safe without a validator', () => {
  const document = cleanDocument()
  document.captures[1].headers = [{ name: 'Cache-Control', value: 'no-store' }]
  const report = auditAssetCache(document)
  assert.equal(report.status, 'pass')
  assert.deepEqual(rules(report), [])
})

test('mutable no-cache with a validator is safe even when max-age is long', () => {
  const document = cleanDocument()
  document.captures[1].headers[0].value = 'no-cache, max-age=31536000'
  const report = auditAssetCache(document)
  assert.equal(report.status, 'pass')
  assert.deepEqual(rules(report), [])
})

test('s-maxage alone cannot establish a browser TTL bound', () => {
  const document = cleanDocument()
  document.captures[1].headers[0].value = 's-maxage=3600'
  const report = auditAssetCache(document)
  assert.equal(report.status, 'incomplete')
  assert.deepEqual(rules(report), ['header-invalid'])
})

test('Last-Modified can revalidate a mutable asset without ETag', () => {
  const document = cleanDocument()
  document.captures[1].headers[1] = { name: 'Last-Modified', value: 'Wed, 01 Jan 2025 00:00:00 GMT' }
  const report = auditAssetCache(document)
  assert.equal(report.status, 'pass')
  assert.deepEqual(rules(report), [])
})

test('a captured absence of Cache-Control is a known failure', () => {
  const document = cleanDocument()
  document.captures[1].headers = [{ name: 'ETag', value: '"v1"' }]
  const report = auditAssetCache(document)
  assert.equal(report.status, 'fail')
  assert.deepEqual(rules(report), ['cache-policy-missing'])
})

test('a missing capture is incomplete, not evidence of no policy', () => {
  const document = cleanDocument()
  document.captures.pop()
  const report = auditAssetCache(document)
  assert.equal(report.status, 'incomplete')
  assert.deepEqual(rules(report), ['capture-missing'])
})

test('an unusable manifest row makes the capture index incomplete, not extra', () => {
  const document = cleanDocument()
  document.manifest[1].kind = 'muta' // unusable declaration, not an absent asset
  const report = auditAssetCache(document)
  assert.equal(report.status, 'incomplete')
  assert.deepEqual(rules(report), ['manifest-invalid'])
})

test('an unusable capture row makes the join incomplete, not missing', () => {
  const document = cleanDocument()
  document.captures[1].headers = 'not-captured'
  const report = auditAssetCache(document)
  assert.equal(report.status, 'incomplete')
  assert.deepEqual(rules(report), ['capture-invalid'])
})

test('a duplicated capture is incomplete rather than last-wins', () => {
  const document = cleanDocument()
  document.captures.push(structuredClone(document.captures[1]))
  const report = auditAssetCache(document)
  assert.equal(report.status, 'incomplete')
  assert.deepEqual(rules(report), ['capture-duplicate'])
})

test('a duplicated manifest id or URL is incomplete', () => {
  const document = cleanDocument()
  document.manifest[1].id = document.manifest[0].id
  assert.deepEqual(rules(auditAssetCache(document)), ['manifest-duplicate'])
  document.manifest[1].id = 'index-js'
  document.manifest[1].url = document.manifest[0].url
  assert.deepEqual(rules(auditAssetCache(document)), ['manifest-duplicate'])
})

test('an extra captured asset is incomplete when the manifest index is complete', () => {
  const document = cleanDocument()
  document.captures.push({ url: 'https://assets.example.test/extra.js', headers: [] })
  const report = auditAssetCache(document)
  assert.equal(report.status, 'incomplete')
  assert.deepEqual(rules(report), ['capture-extra'])
})

test('duplicate Cache-Control headers are ambiguous, not first-wins', () => {
  const document = cleanDocument()
  document.captures[1].headers.push({ name: 'cache-control', value: 'max-age=31536000, immutable' })
  const report = auditAssetCache(document)
  assert.equal(report.status, 'incomplete')
  assert.deepEqual(rules(report), ['header-ambiguous'])
})

test('duplicate validator headers are ambiguous, not first-wins', () => {
  const document = cleanDocument()
  document.captures[1].headers.push({ name: 'etag', value: '"v2"' })
  const report = auditAssetCache(document)
  assert.equal(report.status, 'incomplete')
  assert.deepEqual(rules(report), ['header-ambiguous'])
})

test('duplicate unrelated response headers do not invalidate correct cache evidence', () => {
  const document = cleanDocument()
  document.captures[1].headers.push(
    { name: 'Set-Cookie', value: 'sample=1' },
    { name: 'set-cookie', value: 'sample=2' },
  )
  const report = auditAssetCache(document)
  assert.equal(report.status, 'pass')
  assert.deepEqual(rules(report), [])
})

test('malformed TTL is unknown rather than treated as zero', () => {
  const document = cleanDocument()
  document.captures[1].headers[0].value = 'max-age=not-a-number'
  const report = auditAssetCache(document)
  assert.equal(report.status, 'incomplete')
  assert.deepEqual(rules(report), ['header-invalid'])
})

test('a rendered-empty validator is not usable evidence', () => {
  const document = cleanDocument()
  document.captures[1].headers[1].value = '\u200e'
  const report = auditAssetCache(document)
  assert.equal(report.status, 'incomplete')
  assert.deepEqual(rules(report), ['header-invalid'])
})

test('only a syntactically valid quoted ETag can establish mutable revalidation', () => {
  const document = cleanDocument()
  for (const value of ['"v1"', 'W/"v1"']) {
    document.captures[1].headers[1].value = value
    assert.equal(auditAssetCache(document).status, 'pass', value)
  }
  for (const value of ['not-an-etag', '"v1"\u0001']) {
    document.captures[1].headers[1].value = value
    const report = auditAssetCache(document)
    assert.equal(report.status, 'incomplete', value)
    assert.deepEqual(rules(report), ['header-invalid'])
  }
})

test('unsafe manifest identifiers are incomplete and do not reach output', () => {
  const document = cleanDocument()
  document.manifest[1].id = '\u202e'
  const report = auditAssetCache(document)
  assert.equal(report.status, 'incomplete')
  assert.deepEqual(rules(report), ['manifest-invalid'])
  assert.equal(JSON.stringify(report).includes('\u202e'), false)
})

test('a URL carrying embedded credentials is unusable and never rendered', () => {
  const document = cleanDocument()
  document.manifest[1].url = 'https://user:SYNTHETIC-CREDENTIAL@assets.example.test/index.js'
  const report = auditAssetCache(document)
  assert.equal(report.status, 'incomplete')
  assert.deepEqual(rules(report), ['manifest-invalid'])
  assert.equal(JSON.stringify(report).includes('SYNTHETIC-CREDENTIAL'), false)
})

test('query values remain internal even for a policy failure', () => {
  const document = cleanDocument()
  document.manifest[1].url += '?token=SYNTHETIC-SECRET-CANARY'
  document.captures[1].url = document.manifest[1].url
  document.captures[1].headers[0].value = 'max-age=31536000, immutable'
  const report = auditAssetCache(document)
  assert.equal(report.status, 'fail')
  assert.equal(JSON.stringify(report).includes('SYNTHETIC-SECRET-CANARY'), false)
  assert.deepEqual(rules(report), ['mutable-immutable-policy', 'mutable-ttl-long'])
})

test('asset count is accepted at N and incomplete at N+1', () => {
  const document = cleanDocument()
  assert.equal(auditAssetCache(document, { limits: { maxAssets: 2 } }).status, 'pass')
  const report = auditAssetCache(document, { limits: { maxAssets: 1 } })
  assert.equal(report.status, 'incomplete')
  assert.deepEqual(rules(report), ['asset-limit'])
})

test('captured response count is accepted at N and incomplete at N+1', () => {
  const document = cleanDocument()
  assert.equal(auditAssetCache(document, { limits: { maxAssets: 2 } }).status, 'pass')
  document.captures.push({ url: 'https://assets.example.test/extra.js', headers: [] })
  const report = auditAssetCache(document, { limits: { maxAssets: 2 } })
  assert.equal(report.status, 'incomplete')
  assert.deepEqual(rules(report), ['asset-limit'])
})

test('finding count is complete at N and incomplete at N+1', () => {
  const document = cleanDocument()
  document.captures[1].headers[0].value = 'max-age=31536000, immutable'
  const exact = auditAssetCache(document, { limits: { maxFindings: 2 } })
  assert.equal(exact.status, 'fail')
  assert.deepEqual(rules(exact), ['mutable-immutable-policy', 'mutable-ttl-long'])
  const exceeded = auditAssetCache(document, { limits: { maxFindings: 1 } })
  assert.equal(exceeded.status, 'incomplete')
  assert.deepEqual(rules(exceeded), ['findings-truncated', 'mutable-immutable-policy'])
})

test('time budget is allowed at N and incomplete at N+1', () => {
  const clock = (delta) => {
    let first = true
    return () => { if (first) { first = false; return 0 } return delta }
  }
  assert.equal(auditAssetCache(cleanDocument(), { limits: { timeoutMs: 5 }, now: clock(5) }).status, 'pass')
  const report = auditAssetCache(cleanDocument(), { limits: { timeoutMs: 5 }, now: clock(6) })
  assert.equal(report.status, 'incomplete')
  assert.deepEqual(rules(report), ['analysis-timeout'])
})

test('a backward injected clock never yields a clean cache audit', () => {
  let reads = 0
  const report = auditAssetCache(cleanDocument(), { now: () => reads++ === 0 ? 10 : 9 })
  assert.equal(report.status, 'incomplete')
  assert.deepEqual(rules(report), ['analysis-timeout'])
  assert.equal(auditAssetCache(cleanDocument(), { now: () => 10 }).status, 'pass')
})

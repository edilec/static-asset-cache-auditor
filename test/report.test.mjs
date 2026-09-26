import test from 'node:test'
import assert from 'node:assert/strict'
import { makeFinding, makeReport, validateLimits } from '../src/report.mjs'

test('a complete checked report passes without findings', () => {
  const report = makeReport([], 1)
  assert.equal(report.status, 'pass')
  assert.deepEqual(report.summary, { checked: 1, errors: 0, warnings: 0 })
})

test('a known unsafe mutable policy fails', () => {
  const report = makeReport([makeFinding('mutable-ttl-long', 'input.json', '/manifest/0')], 1)
  assert.equal(report.status, 'fail')
  assert.equal(report.findings[0].severity, 'error')
})

test('missing capture evidence stays incomplete even beside a known error', () => {
  const report = makeReport([
    makeFinding('mutable-ttl-long', 'input.json', '/manifest/0'),
    makeFinding('capture-missing', 'input.json', '/manifest/1'),
  ], 1)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 2)
})

test('findings sort by UTF-16 code unit rather than locale', () => {
  const report = makeReport([
    makeFinding('capture-missing', 'a.json', '/assets/a_b'),
    makeFinding('capture-missing', 'a.json', '/assets/a-b'),
    makeFinding('capture-missing', 'Z.json', '/assets/0'),
  ], 0)
  assert.deepEqual(report.findings.map((finding) => `${finding.location.file}${finding.location.pointer}`), [
    'Z.json/assets/0', 'a.json/assets/a-b', 'a.json/assets/a_b',
  ])
})

test('unknown limit names and non-positive bounds are configuration errors', () => {
  assert.throws(() => validateLimits({ maxAsset: 1 }), /Unknown limit/)
  assert.throws(() => validateLimits({ maxAssets: 0 }), /positive integer/)
  assert.equal(validateLimits({ maxAssets: 2 }).maxAssets, 2)
})

test('C1, bidi and default-ignorable marks have lossless safe location spellings', () => {
  const report = makeReport([makeFinding('input-invalid', 'a\u0085\u202e\u034fb.json')], 0)
  assert.equal(report.findings[0].location.file, 'a\\u{0085}\\u{202e}\\u{034f}b.json')
  assert.equal(JSON.stringify(report).includes('\u0085'), false)
  assert.equal(JSON.stringify(report).includes('\u202e'), false)
  assert.equal(JSON.stringify(report).includes('\u034f'), false)
  const ordinary = makeFinding('input-invalid', 'ab.json')
  const literalEscape = makeFinding('input-invalid', 'a\\u{0085}b.json')
  assert.notEqual(report.findings[0].location.file, ordinary.location.file)
  assert.notEqual(makeFinding('input-invalid', 'a\u0085b.json').location.file, literalEscape.location.file)
})

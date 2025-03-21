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

test('C1, bidi and default-ignorable marks cannot hide inside a report location', () => {
  const report = makeReport([makeFinding('input-invalid', 'a\u0085\u202e\u034fb.json')], 0)
  assert.equal(report.findings[0].location.file, 'ab.json')
  assert.equal(JSON.stringify(report).includes('\u0085'), false)
  assert.equal(JSON.stringify(report).includes('\u202e'), false)
  assert.equal(JSON.stringify(report).includes('\u034f'), false)
})

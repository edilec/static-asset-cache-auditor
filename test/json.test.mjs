import test from 'node:test'
import assert from 'node:assert/strict'
import { parseStrictJson } from '../src/json.mjs'

test('JSON nesting at the configured depth is accepted', () => {
  assert.deepEqual(parseStrictJson('{"a":{"b":1}}', 2), { a: { b: 1 } })
})

test('JSON nesting one level beyond the configured depth is unknown', () => {
  assert.throws(() => parseStrictJson('{"a":{"b":{"c":1}}}', 2), /depth limit/)
})

test('a duplicate key is rejected rather than silently taking its last value', () => {
  assert.throws(() => parseStrictJson('{"policy":{"max":1,"max":2}}', 3), /duplicate key/)
})

test('a malformed JSON diagnostic never repeats the quoted document', () => {
  assert.throws(() => parseStrictJson('{"secret":"SYNTHETIC-CANARY",', 3), (error) => {
    assert.equal(error.message, 'Invalid JSON input.')
    assert.equal(error.message.includes('SYNTHETIC-CANARY'), false)
    return true
  })
})

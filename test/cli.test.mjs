import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const bin = new URL('../bin/static-asset-cache-auditor.mjs', import.meta.url).pathname

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
        { name: 'Cache-Control', value: 'max-age=31536000, immutable' },
      ] },
      { url: 'https://assets.example.test/index.js', headers: [
        { name: 'Cache-Control', value: 'max-age=3600' }, { name: 'ETag', value: '"v1"' },
      ] },
    ],
  }
}

async function workspace(t) {
  const base = await mkdtemp(join(tmpdir(), 'static-cache-audit-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  const input = join(base, 'input.json')
  await writeFile(input, JSON.stringify(cleanDocument()))
  return { base, input }
}

function cli(args) {
  const result = spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8' })
  return { code: result.status, stdout: result.stdout, stderr: result.stderr }
}

const args = ({ base, input }) => ['--input', input, '--root', base]
const rules = (report) => report.findings.map((finding) => finding.ruleId)

test('--help documents the input, optional report and exit codes', () => {
  const result = cli(['--help'])
  assert.equal(result.code, 0)
  assert.match(result.stdout, /--input/)
  assert.match(result.stdout, /--report/)
  assert.match(result.stdout, /Exit 2/)
})

test('clean captured assets pass through the real CLI with deterministic JSON', async (t) => {
  const space = await workspace(t)
  const first = cli(args(space))
  const second = cli(args(space))
  assert.equal(first.code, 0)
  assert.equal(first.stdout, second.stdout)
  assert.equal(JSON.parse(first.stdout).status, 'pass')
  assert.equal(JSON.parse(first.stdout).summary.checked, 2)
  assert.equal(first.stdout.includes(space.base), false)
  assert.match(first.stderr, /pass/)
})

test('a mutable URL with immutable long caching fails through the real CLI', async (t) => {
  const space = await workspace(t)
  const document = cleanDocument()
  document.captures[1].headers[0].value = 'max-age=31536000, immutable'
  await writeFile(space.input, JSON.stringify(document))
  const result = cli(args(space))
  assert.equal(result.code, 1)
  const report = JSON.parse(result.stdout)
  assert.equal(report.status, 'fail')
  assert.deepEqual(rules(report), ['mutable-immutable-policy', 'mutable-ttl-long'])
})

test('invalid CLI configuration exits 2 with empty stdout', async (t) => {
  const space = await workspace(t)
  const result = cli([...args(space), '--max-asset', '2'])
  assert.equal(result.code, 2)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /Unknown option/)
})

test('a nonexistent root is invalid configuration with empty stdout', async (t) => {
  const space = await workspace(t)
  const result = cli(['--input', space.input, '--root', join(space.base, 'no-root')])
  assert.equal(result.code, 2)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /--root/)
})

test('a regular file cannot be the declared root even when it is the input', async (t) => {
  const space = await workspace(t)
  assert.equal(cli(args(space)).code, 0)
  const result = cli(['--input', space.input, '--root', space.input])
  assert.equal(result.code, 2)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /--root/)
})

test('an unreadable input exits 2 with an incomplete report', async (t) => {
  const space = await workspace(t)
  const result = cli(['--input', join(space.base, 'missing.json'), '--root', space.base])
  assert.equal(result.code, 2)
  const report = JSON.parse(result.stdout)
  assert.equal(report.status, 'incomplete')
  assert.deepEqual(rules(report), ['input-unreadable'])
})

test('invalid JSON and duplicate keys cannot pass or leak document text', async (t) => {
  const space = await workspace(t)
  await writeFile(space.input, '{"secret":"SYNTHETIC-CANARY",')
  const malformed = cli(args(space))
  assert.equal(malformed.code, 2)
  assert.deepEqual(rules(JSON.parse(malformed.stdout)), ['input-invalid'])
  assert.equal((malformed.stdout + malformed.stderr).includes('SYNTHETIC-CANARY'), false)
  const original = JSON.stringify(cleanDocument())
  const duplicated = original.replace('"kind":"mutable"', '"kind":"immutable","kind":"mutable"')
  assert.notEqual(duplicated, original)
  await writeFile(space.input, duplicated)
  const duplicate = cli(args(space))
  assert.equal(duplicate.code, 2)
  assert.deepEqual(rules(JSON.parse(duplicate.stdout)), ['input-invalid'])
})

test('rounded fractional policy lexemes cannot become integer cache limits', async (t) => {
  const space = await workspace(t)
  const original = JSON.stringify(cleanDocument())
  for (const field of ['mutableMaxAgeSeconds', 'immutableMinAgeSeconds']) {
    const value = field === 'mutableMaxAgeSeconds' ? '3600' : '31536000'
    const exact = original.replace(`"${field}":${value}`, `"${field}":${value}.0`)
    assert.notEqual(exact, original)
    await writeFile(space.input, exact)
    assert.equal(cli(args(space)).code, 0, `exact decimal spelling of ${field}`)
    const rounded = original.replace(`"${field}":${value}`, `"${field}":${value}.00000000000000001`)
    assert.notEqual(rounded, original)
    await writeFile(space.input, rounded)
    const result = cli(args(space))
    assert.equal(result.code, 2, field)
    assert.equal(JSON.parse(result.stdout).status, 'incomplete')
  }
})

test('escaped control bytes in an ETag are incomplete through the CLI', async (t) => {
  const space = await workspace(t)
  const document = cleanDocument()
  assert.equal(cli(args(space)).code, 0)
  document.captures[1].headers[1].value = '"v1"\u0001'
  await writeFile(space.input, JSON.stringify(document))
  const result = cli(args(space))
  assert.equal(result.code, 2)
  assert.deepEqual(rules(JSON.parse(result.stdout)), ['header-invalid'])
  assert.equal(result.stdout.includes(String.fromCodePoint(1)), false)
})

test('invalid UTF-8 is incomplete rather than repaired', async (t) => {
  const space = await workspace(t)
  await writeFile(space.input, Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x80, 0x7d]))
  const result = cli(args(space))
  assert.equal(result.code, 2)
  assert.deepEqual(rules(JSON.parse(result.stdout)), ['input-invalid'])
})

test('byte limit is silent at N and incomplete at N+1', async (t) => {
  const space = await workspace(t)
  const size = (await readFile(space.input)).length
  const exact = cli([...args(space), '--max-bytes', String(size)])
  assert.equal(exact.code, 0)
  assert.equal(JSON.parse(exact.stdout).status, 'pass')
  const exceeded = cli([...args(space), '--max-bytes', String(size - 1)])
  assert.equal(exceeded.code, 2)
  assert.deepEqual(rules(JSON.parse(exceeded.stdout)), ['input-too-large'])
})

test('JSON depth limit is silent at N and incomplete at N+1', async (t) => {
  const space = await workspace(t)
  const exact = cli([...args(space), '--max-depth', '5'])
  assert.equal(exact.code, 0)
  const exceeded = cli([...args(space), '--max-depth', '4'])
  assert.equal(exceeded.code, 2)
  assert.deepEqual(rules(JSON.parse(exceeded.stdout)), ['depth-limit'])
})

test('a symlinked input outside the declared root is never read', async (t) => {
  const space = await workspace(t)
  const outside = await mkdtemp(join(tmpdir(), 'static-cache-outside-'))
  t.after(() => rm(outside, { recursive: true, force: true }))
  await writeFile(join(outside, 'private.json'), 'SYNTHETIC-PRIVATE-CANARY')
  const named = join(space.base, 'linked.json')
  await symlink(join(outside, 'private.json'), named)
  const result = cli(['--input', named, '--root', space.base])
  assert.equal(result.code, 2)
  assert.deepEqual(rules(JSON.parse(result.stdout)), ['input-unreadable'])
  assert.equal((result.stdout + result.stderr).includes('SYNTHETIC-PRIVATE-CANARY'), false)
})

test('a symlinked input staying inside the declared root is readable', async (t) => {
  const space = await workspace(t)
  const named = join(space.base, 'linked.json')
  await symlink('input.json', named)
  const result = cli(['--input', named, '--root', space.base])
  assert.equal(result.code, 0)
  assert.equal(JSON.parse(result.stdout).status, 'pass')
})

test('a safe new report contains exactly the JSON sent to stdout', async (t) => {
  const space = await workspace(t)
  const out = join(space.base, 'report.json')
  const result = cli([...args(space), '--report', out])
  assert.equal(result.code, 0)
  assert.equal(await readFile(out, 'utf8'), result.stdout)
})

test('an existing regular report may be replaced without touching the input', async (t) => {
  const space = await workspace(t)
  const out = join(space.base, 'report.json')
  const inputBefore = await readFile(space.input, 'utf8')
  await writeFile(out, 'old report')
  const result = cli([...args(space), '--report', out])
  assert.equal(result.code, 0)
  assert.equal(await readFile(out, 'utf8'), result.stdout)
  assert.equal(await readFile(space.input, 'utf8'), inputBefore)
})

test('a destination symlink is refused with incomplete stdout and leaves its target intact', async (t) => {
  const space = await workspace(t)
  const target = join(space.base, 'target.json')
  const out = join(space.base, 'report.json')
  await writeFile(target, 'preserve')
  await symlink(target, out)
  const result = cli([...args(space), '--report', out])
  assert.equal(result.code, 2)
  assert.deepEqual(rules(JSON.parse(result.stdout)), ['report-write-refused'])
  assert.equal(await readFile(target, 'utf8'), 'preserve')
})

test('a symlinked report parent cannot escape the declared root', async (t) => {
  const space = await workspace(t)
  const outside = await mkdtemp(join(tmpdir(), 'static-cache-output-'))
  t.after(() => rm(outside, { recursive: true, force: true }))
  await symlink(outside, join(space.base, 'linked'))
  const out = join(space.base, 'linked', 'report.json')
  const result = cli([...args(space), '--report', out])
  assert.equal(result.code, 2)
  assert.deepEqual(rules(JSON.parse(result.stdout)), ['report-write-refused'])
  await assert.rejects(() => readFile(join(outside, 'report.json')), { code: 'ENOENT' })
})

test('a symlinked report parent staying inside the declared root is allowed', async (t) => {
  const space = await workspace(t)
  const actual = join(space.base, 'actual')
  await mkdir(actual)
  await symlink(actual, join(space.base, 'linked'))
  const result = cli([...args(space), '--report', join(space.base, 'linked', 'report.json')])
  assert.equal(result.code, 0)
  assert.equal(await readFile(join(actual, 'report.json'), 'utf8'), result.stdout)
})

test('a lexical report path outside the declared root is refused', async (t) => {
  const space = await workspace(t)
  const outside = await mkdtemp(join(tmpdir(), 'static-cache-lexical-'))
  t.after(() => rm(outside, { recursive: true, force: true }))
  const out = join(outside, 'report.json')
  const result = cli([...args(space), '--report', out])
  assert.equal(result.code, 2)
  assert.deepEqual(rules(JSON.parse(result.stdout)), ['report-write-refused'])
  await assert.rejects(() => readFile(out), { code: 'ENOENT' })
})

test('a report hard-linked to the named input is refused and input remains intact', async (t) => {
  const space = await workspace(t)
  const out = join(space.base, 'report.json')
  const before = await readFile(space.input, 'utf8')
  await link(space.input, out)
  const result = cli([...args(space), '--report', out])
  assert.equal(result.code, 2)
  assert.deepEqual(rules(JSON.parse(result.stdout)), ['report-write-refused'])
  assert.equal(await readFile(space.input, 'utf8'), before)
})

test('a distinct missing input can still produce an incomplete report file', async (t) => {
  const space = await workspace(t)
  const missing = join(space.base, 'missing.json')
  const out = join(space.base, 'report.json')
  const result = cli(['--input', missing, '--root', space.base, '--report', out])
  assert.equal(result.code, 2)
  assert.deepEqual(rules(JSON.parse(result.stdout)), ['input-unreadable'])
  assert.equal(await readFile(out, 'utf8'), result.stdout)
  await assert.rejects(() => readFile(missing), { code: 'ENOENT' })
})

test('a dangling named input symlink to a new report is refused before writing', async (t) => {
  const space = await workspace(t)
  const named = join(space.base, 'linked.json')
  const out = join(space.base, 'report.json')
  await symlink('report.json', named)
  const result = cli(['--input', named, '--root', space.base, '--report', out])
  assert.equal(result.code, 2)
  assert.deepEqual(rules(JSON.parse(result.stdout)), ['input-unreadable', 'report-write-refused'])
  await assert.rejects(() => readFile(out), { code: 'ENOENT' })
  await assert.rejects(() => readFile(named), { code: 'ENOENT' })
})

test('two dangling named input symlink hops to a new report are refused', async (t) => {
  const space = await workspace(t)
  const named = join(space.base, 'linked.json')
  const middle = join(space.base, 'middle.json')
  const out = join(space.base, 'report.json')
  await symlink('middle.json', named)
  await symlink('report.json', middle)
  const result = cli(['--input', named, '--root', space.base, '--report', out])
  assert.equal(result.code, 2)
  assert.deepEqual(rules(JSON.parse(result.stdout)), ['input-unreadable', 'report-write-refused'])
  await assert.rejects(() => readFile(out), { code: 'ENOENT' })
})

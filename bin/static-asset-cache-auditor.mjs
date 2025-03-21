#!/usr/bin/env node
import { readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { TextDecoder } from 'node:util'
import { auditAssetCache } from '../src/index.mjs'
import { JsonInputError, parseStrictJson } from '../src/json.mjs'
import { ConfigError, makeFinding, makeReport, TOOL_ID, validateLimits } from '../src/report.mjs'
import { assertWritableDestination } from '../src/write-guard.mjs'

const HELP = `Usage: static-asset-cache-auditor --input FILE [options]

Read a saved manifest and captured headers; never fetch an asset.

Options:
  --input FILE          Local JSON evidence (required)
  --root DIR            Input and report root (default: working directory)
  --report FILE         Also write exactly the stdout JSON inside --root
  --max-bytes N         Maximum input bytes (default: 1048576)
  --max-assets N        Maximum manifest and capture rows each (default: 1000)
  --max-depth N         Maximum JSON object/array depth (default: 32)
  --max-findings N      Maximum ordinary findings (default: 500)
  --timeout-ms N        Cooperative analysis budget (default: 30000)
  --help                Show this help

Exit 0: complete pass. Exit 1: complete policy failure.
Exit 2: invalid configuration or incomplete evidence; configuration errors have empty stdout.
JSON reports go to stdout; a brief human summary goes to stderr.
`

function parseArgs(argv) {
  if (argv.includes('--help')) return { help: true }
  const options = { root: process.cwd(), limits: {} }
  const names = new Map([
    ['--max-bytes', 'maxBytes'], ['--max-assets', 'maxAssets'],
    ['--max-depth', 'maxDepth'], ['--max-findings', 'maxFindings'],
    ['--timeout-ms', 'timeoutMs'],
  ])
  const seen = new Set()
  for (let at = 0; at < argv.length; at += 2) {
    const flag = argv[at]
    const value = argv[at + 1]
    if (!['--input', '--root', '--report', ...names.keys()].includes(flag)) {
      throw new ConfigError('Unknown option.')
    }
    if (seen.has(flag)) throw new ConfigError(`Option ${flag} was repeated.`)
    seen.add(flag)
    if (value === undefined || value.startsWith('--')) throw new ConfigError(`Option ${flag} needs a value.`)
    if (names.has(flag)) {
      if (!/^[0-9]+$/.test(value)) throw new ConfigError(`Option ${flag} needs a positive integer.`)
      options.limits[names.get(flag)] = Number(value)
    } else if (flag === '--input') options.input = value
    else if (flag === '--root') options.root = value
    else options.report = value
  }
  if (!options.input) throw new ConfigError('--input is required.')
  options.limits = validateLimits(options.limits)
  return options
}

const inside = (path, root) => path === root || path.startsWith(root + sep)
const safeFile = (named, root) => {
  const path = relative(root, named)
  if (path === '' || path === '..' || path.startsWith('..' + sep) || isAbsolute(path)) return 'input.json'
  return path
}

async function inspectInput(options, root, file) {
  let path
  try { path = await realpath(resolve(options.input)) }
  catch { return makeReport([makeFinding('input-unreadable', file)], 0) }
  if (!inside(path, root)) return makeReport([makeFinding('input-unreadable', file)], 0)
  let bytes
  try {
    const info = await stat(path)
    if (!info.isFile()) return makeReport([makeFinding('input-unreadable', file)], 0)
    if (info.size > options.limits.maxBytes) return makeReport([makeFinding('input-too-large', file)], 0)
    bytes = await readFile(path)
  } catch { return makeReport([makeFinding('input-unreadable', file)], 0) }
  if (bytes.length > options.limits.maxBytes) return makeReport([makeFinding('input-too-large', file)], 0)
  let text
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
  catch { return makeReport([makeFinding('input-invalid', file)], 0) }
  let document
  try { document = parseStrictJson(text, options.limits.maxDepth) }
  catch (error) {
    if (!(error instanceof JsonInputError)) throw error
    const rule = error.message.includes('depth limit') ? 'depth-limit' : 'input-invalid'
    return makeReport([makeFinding(rule, file)], 0)
  }
  return auditAssetCache(document, { limits: options.limits, file })
}

async function main() {
  let options
  try { options = parseArgs(process.argv.slice(2)) }
  catch (error) {
    process.stderr.write(`${TOOL_ID}: ${error instanceof ConfigError ? error.message : 'Invalid configuration.'}\n`)
    process.exitCode = 2
    return
  }
  if (options.help) { process.stdout.write(HELP); return }
  let root
  try { root = await realpath(resolve(options.root)) }
  catch {
    process.stderr.write(`${TOOL_ID}: --root must name an existing directory.\n`)
    process.exitCode = 2
    return
  }
  const file = safeFile(resolve(options.input), root)
  let report = await inspectInput(options, root, file)
  if (options.report !== undefined) {
    try {
      const destination = await assertWritableDestination(options.report, {
        root, inputs: [options.input], label: '--report',
      })
      await writeFile(destination, JSON.stringify(report) + '\n', 'utf8')
    } catch {
      report = makeReport([...report.findings, makeFinding('report-write-refused', file)], report.summary.checked)
    }
  }
  process.stdout.write(JSON.stringify(report) + '\n')
  process.stderr.write(`${TOOL_ID}: ${report.status}, ${report.summary.checked} asset(s) checked\n`)
  process.exitCode = report.status === 'pass' ? 0 : report.status === 'fail' ? 1 : 2
}

main().catch(() => {
  process.stderr.write(`${TOOL_ID}: execution failed without a complete report.\n`)
  process.exitCode = 2
})

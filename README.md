# Static Asset Cache Auditor

Check whether a saved build manifest and captured response headers agree about
how static assets may be cached. Long-lived immutable caching is useful for a
content-addressed URL, but dangerous for a mutable URL such as index.js:
clients may keep an old build after deployment. This tool reads exported
evidence and reports that mismatch; it never requests a URL or changes a cache.

Zero runtime and development dependencies. Node.js 22 or newer is required.

## Quick start

~~~sh
npm run check
node bin/static-asset-cache-auditor.mjs --input examples/clean.json
node bin/static-asset-cache-auditor.mjs --input examples/mutable-immutable-error.json
~~~

The first example exits 0 (pass); the second exits 1 (fail). Both use only
synthetic example.test URLs. The tool does not resolve or fetch them.

For a saved export outside the working directory, declare its root:

~~~sh
node bin/static-asset-cache-auditor.mjs --input /saved/capture.json --root /saved
~~~

Optional --report /saved/report.json writes the same bytes emitted on JSON
stdout under that root. Stderr carries a brief human summary, not report data.

## Input format

The input is UTF-8 JSON with this shape:

~~~json
{
  "schemaVersion": "1",
  "policy": { "mutableMaxAgeSeconds": 3600, "immutableMinAgeSeconds": 31536000 },
  "manifest": [
    { "id": "app-js", "url": "https://assets.example.test/app.abcdef12.js", "kind": "immutable" }
  ],
  "captures": [
    { "url": "https://assets.example.test/app.abcdef12.js", "headers": [
      { "name": "Cache-Control", "value": "public, max-age=31536000, immutable" }
    ] }
  ]
}
~~~

The kind is the build author's declaration, not a guess based on the filename.
Manifest ids must be unique, 1–80 ASCII letters/digits followed by optional
letters, digits, period, underscore or hyphen. URLs are absolute HTTP(S), with
no embedded credentials or fragment. The exact URL joins each manifest item
to one captured response; query values are used only for that in-memory join
and never printed. The captured headers array is complete for that response.
Header names are case-insensitive. Combine repeated Cache-Control fields in
the export before running this tool; duplicate cache policy/validator fields
are ambiguous and produce incomplete. Repeated unrelated fields such as
Set-Cookie do not invalidate a good cache policy.

An immutable asset needs a path ending in period or hyphen, 8–64 lowercase hex
characters, then a file extension, plus Cache-Control immutable and a numeric
max-age at least immutableMinAgeSeconds. If s-maxage is supplied for an
immutable asset, it must also meet that minimum. A mutable asset must not declare
immutable. Without no-cache or no-store, max-age must be present and both it
and s-maxage, if present, must not exceed mutableMaxAgeSeconds. s-maxage alone
does not establish a browser TTL bound. A cacheable mutable asset needs a
syntactically valid quoted ETag (optionally `W/` prefixed) or a visible
Last-Modified value to revalidate; a bare or control-bearing ETag is unknown
evidence, not a validator. no-cache with a validator is safe even alongside
a long numeric max-age because it requires revalidation. no-store is valid
without a validator. Malformed or unsupported
cache directives, including contradictory no-cache and immutable, make the
evidence incomplete, not zero TTL. Absence of
Cache-Control in a complete capture is a known failure.

## Rules

| Rule | Severity | Meaning |
| --- | --- | --- |
| input-unreadable, input-invalid, input-too-large, depth-limit | error, incomplete | Input could not be safely evaluated. |
| asset-limit, analysis-timeout, findings-truncated, no-assets | error, incomplete | Coverage is bounded or empty. |
| policy-invalid, manifest-invalid, manifest-duplicate | error, incomplete | Declared policy/index cannot be trusted. |
| capture-invalid, capture-missing, capture-duplicate, capture-extra | error, incomplete | Captured response index is incomplete or ambiguous. |
| header-ambiguous, header-invalid | error, incomplete | Header evidence cannot support a policy claim. |
| cache-policy-missing | error | A complete capture has no Cache-Control header. |
| immutable-name-unhashed, immutable-policy-missing, immutable-ttl-short | error | Declared immutable asset lacks safe naming or policy. |
| mutable-immutable-policy, mutable-ttl-long, mutable-validator-missing | error | Declared mutable asset cannot be safely refreshed. |
| report-write-refused | error, incomplete | Optional output could not be written safely. |

Every finding carries a relative file label and a JSON pointer, never a raw
URL, header value, credential or absolute host path. Prohibited control and
invisible code points in a file label are spelled as `\\u{hhhh}` and literal
backslashes are doubled, so distinct short paths do not collapse in reports.
The label uses the canonical input path when the named path is a symlink.
An injected clock that moves backward makes the analysis incomplete.
Findings sort by UTF-16
code unit, first file, then pointer, then rule id. Identical inputs and options
produce byte-identical output.

## CLI, limits and exits

--help lists the options. Limits are positive integers; unknown or misspelled
options are rejected:

| Option | Default | Boundary |
| --- | ---: | --- |
| --max-bytes | 1,048,576 | Input file bytes. |
| --max-assets | 1,000 | Manifest rows and capture rows, each. |
| --max-depth | 32 | JSON object/array nesting. |
| --max-findings | 500 | Ordinary findings; truncation is incomplete. |
| --timeout-ms | 30,000 | Cooperative analysis time; maximum 3,600,000. |

At the exact limit, evidence is evaluated; one beyond makes the report
incomplete. The analysis clock is injectable in the library, so tests do not
depend on wall time. Duplicate JSON object keys, numeric lexemes that lose
precision when parsed, and invalid UTF-8 are rejected without echoing the
document or parser's quoted snippet. Exact decimal spellings of an integer,
such as `3600.0`, remain usable.

| Exit | stdout | Meaning |
| ---: | --- | --- |
| 0 | JSON pass report | Complete evidence, no error finding. |
| 1 | JSON fail report | Complete evidence, known policy failure. |
| 2 | empty | Invalid CLI configuration or usage. |
| 2 | JSON incomplete report | Unreadable/invalid/limited evidence or refused report write. |

The optional report destination is confined to the real --root. The write
guard refuses a symlink at the destination, an escaping symlinked parent, a
hard link to the named input, and a dangling input symlink that would become
the new report, even through multiple hops. A distinct missing input may still
produce its incomplete report file. A refused write never claims success.

## Limits and non-goals

This is a reporter over exported headers and declarations, not a browser or CDN
test. It cannot verify that a filename hash equals content bytes, that old
deployments were purged, or that a real client revalidated. It does not fetch
assets, inspect a live cache, infer policy intent from a filename, modify
headers, or invalidate anything. Captures and manifest rows must be complete
and trustworthy enough for the specific claim; unknown evidence is never a
pass. The analysis timeout is cooperative, so a single synchronous filesystem
operation cannot be interrupted mid-call.

## Development

npm run lint, npm test, and npm run check use only Node's built-ins. The library
exports TOOL_ID and auditAssetCache from src/index.mjs.

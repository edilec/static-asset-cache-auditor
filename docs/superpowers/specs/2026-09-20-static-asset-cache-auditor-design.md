# Static Asset Cache Auditor design

## Purpose and boundary

Audit one saved JSON document containing a build manifest and captured response
headers. The tool reads no deployed asset and makes no HTTP request. It checks
whether each asset's captured caching policy agrees with an explicit manifest
declaration. It cannot prove that a deployment invalidated an old URL or that
a filename digest matches content bytes.

## Input contract

The document has `schemaVersion: "1"`, `policy` with nonnegative integer
`mutableMaxAgeSeconds` and `immutableMinAgeSeconds`, a `manifest` array, and a
`captures` array. Each manifest item has a unique safe ASCII `id`, an absolute
HTTP(S) `url`, and explicit `kind: "mutable" | "immutable"`. Each capture has a
URL and a complete array of `{name, value}` headers. The exact URL joins a
manifest item to one capture internally; URLs and header values never appear in
the report. Missing, duplicated or malformed joins are incomplete, not clean.
Duplicate JSON object keys are likewise incomplete. The input file's real path
must be inside `--root` (default: current directory).

## Policy checks

An immutable declaration requires a hash-shaped path component immediately
before the file extension (`.` or `-` plus 8–64 lowercase hex characters), a
`Cache-Control` `immutable` directive, and a `max-age` at least the declared
immutable minimum. A mutable declaration is authoritative even if its filename
looks hashed: `immutable` is forbidden, both `max-age` and `s-maxage` must be
at or below the declared mutable maximum, and cacheable responses need `ETag`
or `Last-Modified` to revalidate. `no-store` is an allowed mutable strategy
without a validator. Missing or malformed cache directives are distinguished
from valid but unsafe policies. Duplicate/conflicting control headers are
incomplete rather than arbitrarily first- or last-wins. A captured absence of
`Cache-Control` is a known policy failure, not a missing capture.

## Report and verification

The report follows the catalog envelope and uses only safe manifest ids,
relative file labels, JSON pointers and fixed messages. It sorts findings by
UTF-16 code unit. Known unsafe policies fail; missing/ambiguous evidence takes
precedence as incomplete; zero checked assets is incomplete. The library takes
an injected clock. CLI usage/configuration errors exit 2 with empty stdout;
unreadable/invalid/over-limit input exits 2 with an incomplete JSON report;
complete pass/fail exit 0/1. The CLI enforces byte, asset-count, JSON-depth
and cooperative time bounds, each with N and N+1 tests. `--help` documents all
flags and exits; a human summary goes to stderr. Optional `--report FILE`
writes byte-identical JSON under `--root` only after the catalog write guard
refuses a destination symlink, escaping parent, input hard link and dangling
named-input symlink (including multiple hops). Safe new and existing regular
files work. A write refusal emits an incomplete report at exit 2 without a
success claim; malformed CLI configuration still leaves stdout empty. Runnable clean and failing
examples contain only synthetic domains, assets and header values. Tests must
show a mutable URL with long immutable policy failing and an explicitly
declared hashed immutable asset passing, with rule-level fail-on-removal proof.

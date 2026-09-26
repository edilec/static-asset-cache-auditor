# Static Asset Cache Auditor Implementation Plan

**Goal:** Build a dependency-free offline reporter for manifest-declared asset cache policy against saved headers.

**Architecture:** A strict JSON reader and frozen report catalog feed a pure manifest/capture audit function. A CLI adds path confinement, bounds, guarded optional report output and stream/exit behavior.

**Tech Stack:** Node >=22 ESM, built-in `fs`, `path`, `url`, `node:test`, `node:assert/strict`.

**Spec:** `docs/superpowers/specs/2026-09-20-static-asset-cache-auditor-design.md`

## Global constraints

- No network, dependencies, actors, real data or remote Git actions.
- Manifest `kind` is authoritative; do not infer mutable/immutable intent from the filename.
- Never emit captured URL/query or header values. Sort by UTF-16 code unit; inject the clock.
- `npm run check` must pass; each README guarantee needs a named test that fails when its protection is removed.

## Task 1: Report, bounds and strict JSON

**Files:** Create `src/report.mjs`, `src/json.mjs`, `test/report.test.mjs`, `test/json.test.mjs`.

**Interfaces:** `makeFinding(ruleId,file,pointer)`, `makeReport(findings,checked)`, `parseStrictJson(text,maxDepth)`, `validateLimits(overrides)`.

- [ ] Write a red test for pass/fail/incomplete precedence, severity and code-unit order; mutate a severity and incomplete flag to prove behavior is pinned.
- [ ] Write JSON examples at depth N and N+1, with duplicate keys and a quoted parse marker; assert bounded generic incomplete diagnostics, then run red.
- [ ] Implement frozen rules, deterministic report and strict JSON parser/key scanner; run `node --test test/report.test.mjs test/json.test.mjs` green.
- [ ] Commit after `git diff --check`.

## Task 2: Pure cache audit

**Files:** Create `src/index.mjs`, `test/audit.test.mjs`.

**Interfaces:** `auditAssetCache(document,{limits,now,file}) -> report`; `TOOL_ID` is exported.

- [ ] Write a red passing control for an explicitly immutable hashed asset with long immutable policy and a mutable asset with short TTL plus validator; test zero assets as incomplete.
- [ ] Implement structural validation, exact URL capture join and header parsing; run the control green.
- [ ] In red/green cycles, pin mutable-name long immutable failure, immutable name/policy/TTL failures, validator and no-store cases, missing/duplicate captures, malformed/duplicate cache directives, unknown evidence in either manifest or capture, safe identifiers, and N/N+1 TTL/asset/time bounds. Assert status and exact rule ids, including good cases at each bound.
- [ ] Mutate every README policy guarantee once, run `node --test test/audit.test.mjs`, and commit the comparison slice.

## Task 3: CLI and guarded output

**Files:** Create `bin/static-asset-cache-auditor.mjs`, `src/write-guard.mjs`, `test/cli.test.mjs`; modify `package.json`.

**Interfaces:** `--input FILE [--root DIR] [--report FILE]` and finite bound flags; JSON stdout, human stderr.

- [ ] Write real-CLI red tests for clean/failing input, unreadable/invalid input, empty-stdout usage error, deterministic bytes, N/N+1 byte/depth limits and read confinement.
- [ ] Write real-CLI red tests for safe new/existing report writes, destination symlink, escaping parent, input hard link and one/two-hop dangling input alias. Safe output bytes must match stdout; refusal exits incomplete without success claim.
- [ ] Implement CLI and copy the current catalog write guard, passing the named input. Run focused tests green and temporarily remove each guard to prove its test fails.
- [ ] Commit after focused checks and `git diff --check`.

## Task 4: Ship and verify

**Files:** Modify `README.md`, `package.json`; create `examples/clean.json`, `examples/mutable-immutable-error.json`, `examples/README.md`.

- [ ] Document exact schema, rule/severity table, quick start, exits, limits, validators/invalidation limits, output guard and non-goals; add runnable clean/failing npm example scripts.
- [ ] Run `npm run check`; read every test name against its body and scan changed files for raw U+0000/U+2028/U+2029 and dependency/network additions.
- [ ] Commit the shipping slice and report exact HEAD, test count, mutation evidence and clean tree.

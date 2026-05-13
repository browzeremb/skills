# Runner detection — auto-discover the host's test runner + mutation tool

The tester subagent runs this discovery flow before authoring tests.

---

## Detection cascade

| Signal | Runner | Mutation tool |
|---|---|---|
| `package.json#devDependencies["vitest"]` OR `vitest.config.{ts,js,mjs}` exists | `vitest` | `stryker` |
| `package.json#devDependencies["jest"]` OR `jest.config.{ts,js,mjs,json}` exists | `jest` | `stryker` |
| `package.json#scripts.test` invokes `node --test` | `node:test` | `stryker` (limited support) |
| `pyproject.toml#tool.pytest` OR `pytest.ini` OR `setup.cfg#tool:pytest` exists | `pytest` | `mutmut` |
| `go.mod` exists AND `_test.go` files present | `go test` | `go-mutesting` |
| `Cargo.toml` exists AND `#[cfg(test)]` blocks present | `cargo test` | (none — Rust mutation tooling immature) |

Discovery order: check from top to bottom. First match wins. Multiple
runners in the same repo (monorepo) → pick the runner that owns the
files in `task.scope.files[]` for this feature.

---

## Skipping when no infra

If none of the above match AND no `*test*` file pattern exists in the
host's source tree, set:

```yaml
skipped: true
skipReason: "host has no test runner detected — no package.json#devDependencies test runner, no test config files, no _test.* sources"
```

Do NOT author tests in a vacuum. The acceptance phase will record the
skip and the operator decides whether to introduce test infra in a
follow-up feature.

---

## Scoped invocation

When invoking the discovered runner, ALWAYS scope to changed files:

| Runner | Scoped invocation |
|---|---|
| vitest | `pnpm vitest run <changed-test-files>` or `pnpm vitest --filter=<pkg>` (Turborepo) |
| jest | `npx jest <changed-test-files>` or `npx jest --findRelatedTests <changed-source-files>` |
| node:test | `node --test <changed-test-files>` |
| pytest | `pytest <changed-test-files>` or `pytest --co -q <path>` to enumerate first |
| go test | `go test ./<pkg>/...` for the package owning the change |
| cargo test | `cargo test -p <crate>` for the crate owning the change |

Never run the host-wide gate command unless the scope spans the entire
host.

---

## Mutation tool invocation

| Tool | Scoped invocation | Reads results from |
|---|---|---|
| stryker | `npx stryker run --mutate "src/<changed-source-files>"` | `reports/mutation/mutation.json` |
| mutmut | `mutmut run --paths-to-mutate <changed-source-files>` then `mutmut results --json` | stdout |
| go-mutesting | `go-mutesting --do-not-remove-tmp-folder ./<pkg>/...` | parsed from stdout patterns |

Capture the JSON output, parse killed / survived counts per category,
write into `TESTS.md.frontmatter.summary` and per-test
`testsAdded[].killedMutants` / `totalMutants`.

---

## Mutation categories — what counts

The 6 canonical categories per the contract:

| Category | Example mutation |
|---|---|
| `boolean` | `&&` → `\|\|` |
| `conditional` | `>` → `>=`, `<` → `<=` |
| `arithmetic` | `+` → `-`, `*` → `/` |
| `boundary` | `[0..N]` → `[1..N]`, off-array edges |
| `off-by-one` | `i < N` → `i <= N` |
| `return-value` | `return X` → `return null`, `return !X` |

The mutation tool reports per-mutation-kind. Aggregate into these 6
canonical buckets in `mutationCategoriesCovered[]` (a category is
"covered" when at least one mutation in that bucket was killed).

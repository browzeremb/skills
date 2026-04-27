---
name: architecture-blueprint-generator
description: "Generate a comprehensive ARCHITECTURE_BLUEPRINT.md for the current repo by analyzing the technology stack, dominant architectural pattern, layer boundaries, and dependency flow. Use to document architecture from scratch, refresh a stale blueprint, onboard a contributor, or produce the artefact `browzer-bootstraper` Phase 3b consumes. Auto-detects stack (Node, .NET, Java, React, Angular, Python, Flutter, Go, Rust) and pattern (Clean Architecture, Microservices, Layered, MVVM, MVC, Hexagonal, Event-Driven, Serverless, Monolithic) by reading package manifests, folder shape, and import graph — no operator picklist. Emits a single markdown artefact at the path the caller specifies (default: `docs/ARCHITECTURE_BLUEPRINT.md`). Triggers: 'generate an architecture blueprint', 'document the architecture', 'create ARCHITECTURE.md', 'blueprint this codebase', 'onboarding architecture doc', 'C4 diagram for this repo', 'extract architecture decisions'."
argument-hint: "[output: <path>] [diagrams: c4|uml|flow|component|none] [detail: high|detailed|comprehensive|implementation-ready]"
allowed-tools: Bash(browzer *), Bash(git *), Bash(find *), Bash(ls *), Bash(cat *), Read, Write, Edit, Glob, Grep
---

# architecture-blueprint-generator — produce ARCHITECTURE_BLUEPRINT.md

Reads the current repo, detects the stack + dominant architectural pattern, and writes a single markdown artefact that captures the architecture, layer boundaries, dependency flow, extension points, and decision rationale.

This skill is the artefact source for `browzer-bootstraper` Phase 3b. It can also run standalone when a contributor asks for an onboarding doc or wants to capture the current state before a refactor.

## Inputs (all optional)

| Arg | Default | Meaning |
| --- | --- | --- |
| `output: <path>` | `docs/ARCHITECTURE_BLUEPRINT.md` | Where to write the artefact |
| `diagrams: <kind>` | `c4` | `c4` \| `uml` \| `flow` \| `component` \| `none` |
| `detail: <level>` | `comprehensive` | `high` \| `detailed` \| `comprehensive` \| `implementation-ready` |
| `focus: extensibility` | off | Emphasize extension points, plugins, hooks |

If the caller omits everything, default to `docs/ARCHITECTURE_BLUEPRINT.md`, C4 diagrams, comprehensive detail.

## Workflow

1. **Discover the stack** — read `package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `*.csproj`, `pom.xml`, `pubspec.yaml`. Note runtime, package manager, language version, monorepo tool (turbo/nx/lerna/lage/rush), build system.
2. **Discover the pattern** — walk the top folder shape (`apps/`, `packages/`, `services/`, `src/domain`, `src/infrastructure`, `cmd/`, `internal/`, …). Cross-reference with import graph via `browzer deps` (or fall back to grep on `import|require|using`). Choose the closest match from: Clean Architecture, Microservices, Layered, MVVM, MVC, Hexagonal, Event-Driven, Serverless, Monolithic. If none fit cleanly, name the actual pattern in plain language.
3. **Inventory layers + boundaries** — for each layer: responsibilities, allowed dependencies, forbidden dependencies, communication mechanism (direct call, event, queue, HTTP).
4. **Capture cross-cutting concerns** — auth, logging, error handling, validation, observability, caching, persistence.
5. **Capture extension points** — plugins, hooks, registration patterns, DI bindings, feature flags.
6. **Capture decision records** — when the codebase reveals a clear "we chose X over Y because Z" (often via comments, ADRs, or commit history), surface it. If the repo has `docs/adr/` or similar, link to it; don't duplicate.
7. **Render diagrams** — emit Mermaid (preferred) for C4 / flow / component / sequence as appropriate. `diagrams: none` skips this section.
8. **Write the artefact** to `<output>` (single file, no sidecars).

## Output template

The artefact MUST follow this structure (rename sections only when the codebase makes a section meaningless):

```markdown
# Architecture Blueprint — <Project Name>

## 1. Overview
One paragraph: what the project does, why it exists, the dominant architectural choice in one sentence.

## 2. Stack
- Runtime / language version
- Package manager / monorepo tool
- Key frameworks (web, ORM, queue, auth)
- Storage (Postgres, Redis, Neo4j, S3, …)

## 3. Architectural pattern
Named pattern + 2–3 bullets on how it's implemented here (specific folder names, specific module names).

## 4. Layers + boundaries
| Layer | Responsibilities | Allowed deps | Forbidden deps |
| --- | --- | --- | --- |
| … | … | … | … |

## 5. Component diagram
```mermaid
<diagram per `diagrams:` flag>
```

## 6. Cross-cutting concerns
Auth, logging, error handling, validation, observability, caching, persistence — one paragraph each.

## 7. Extension points
Plugins / hooks / DI bindings / feature flags — name the file or registration site for each.

## 8. Decision records (or links)
…

## 9. Anti-patterns to avoid
Concrete patterns the codebase explicitly rejects (with file references).
```

## Examples

**Input:** `architecture-blueprint-generator` (no args) on a monorepo with `apps/{api,web,worker}` + `packages/{core,shared,db}`.
**Action:** Detect Node.js + pnpm + Turborepo. Pattern = "monorepo with layered packages, hexagonal `core`". Write `docs/ARCHITECTURE_BLUEPRINT.md` with C4 diagrams, comprehensive detail.

**Input:** `output: docs/ARCH.md; diagrams: none; detail: high`.
**Action:** Write a high-level summary (≤ 2 pages) to `docs/ARCH.md` with no diagrams.

**Input:** invoked by `browzer-bootstraper` Phase 3b in a parallel agent with `output: $SCRATCH_DIR/ARCHITECTURE_BLUEPRINT.md`.
**Action:** Write to the scratch path; bootstraper mirrors the result into `docs/browzer/rag-steroids/` afterwards.

## Anti-patterns

- **Don't invent stacks the repo doesn't use** — if no `package.json`, the project isn't Node.js.
- **Don't pick a pattern by name alone** — if the folder layout doesn't match, describe what's actually there.
- **Don't write multiple files** — the artefact is one markdown document at `<output>`. Diagrams inline as Mermaid.
- **Don't duplicate ADRs that already exist** — link to `docs/adr/` instead of restating them.
- **Don't run if the repo has no source files** (e.g. fresh init): say so and exit.

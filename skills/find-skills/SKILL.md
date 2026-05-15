---
name: find-skills
description: "Discover and install agent skills from the open skills.sh ecosystem when the user asks for a capability that may already exist as a packaged skill. Use whenever the user says 'find a skill for X', 'is there a skill that…', 'can you do <X>', 'I wish I had help with <domain>', 'install a skill for <topic>', or 'search the skills marketplace'. Wraps the `npx skills` CLI: `find` (search), `add` (install), `check` (updates), `update` (apply), `init` (scaffold a new skill). Always check the skills.sh leaderboard before searching, prefer skills with 1K+ installs from reputable sources (vercel-labs, anthropics, microsoft), and verify the source repo before recommending. If no relevant skill exists, fall back to direct help and suggest `npx skills init`. Triggers: 'find a skill', 'is there a skill', 'install a skill for', 'can you do <X>', 'help me with <domain>', 'extend my capabilities', 'browse skills.sh'."
---

# find-skills — discover + install skills from the open skills ecosystem

This skill has **two distinct modes**. Read the invocation context to choose:

- **Programmatic mode** — invoked by `orchestrate-task-delivery` S6 or `browzer:explorer` to enumerate installed skills for a feature. Writes `SKILLS_FOUND.md` under `docs/browzer/<feat-id>/` with only invocable skill names. See §0 below.
- **Interactive mode** — invoked by a user asking "find a skill for X". Searches the skills.sh marketplace and recommends skills to install. See §1 onwards.

Wraps the `npx skills` CLI (the package manager for skills.sh) so a user asking for a capability gets a quality-vetted skill recommendation, not a hand-rolled answer when a packaged one already exists.

## §0 — Programmatic mode (S6 / explorer dispatch)

**Triggered when:** the caller passes a `<feat-id>` argument OR the invocation context is an agent dispatch (not a user prompt). Goal: enumerate skills already installed that are relevant to the feature's domain — these are the only skills agents can invoke via `Skill(...)`.

### Step 1 — Scan installed skill locations

```bash
# Project-level skills
find ".claude/skills" -name "*.md" 2>/dev/null

# Plugin skills (all loaded plugins)
find ".claude/plugins" -name "SKILL.md" 2>/dev/null

# User-level skills
find "$HOME/.claude/skills" -name "*.md" 2>/dev/null
```

For each file found, extract the `name` field from YAML frontmatter and the plugin prefix from the path (e.g. `plugins/cache/browzer-marketplace/browzer/<ver>/skills/<name>/SKILL.md` → invocable as `browzer:<name>`).

### Step 2 — Match against feature domain

Read the PRD for the feature directly from `docs/browzer/<feat-id>/staging/PRD.md` via the `Read` tool. If the PRD file is not yet present (find-skills was invoked before generate-prd), fall back to the operator's invocation prompt for domain context. Extract domain keywords (framework, libraries, patterns).

> In the markdown-chains pipeline, phase artefacts live at `docs/browzer/<feat-id>/staging/*.md` and are read directly with the `Read` tool — there is no `browzer get-step` indirection. The CLI verb is retained for legacy `workflow.json` features only and SHOULD NOT be invoked from new skills.

For each installed skill, score relevance by comparing its `description` frontmatter against the domain keywords:

- `high` — description directly matches a library or pattern in scope
- `medium` — adjacent domain (e.g. testing skill when feature has test requirements)
- `low` — generic utility skill

### Step 3 — Emit SKILLS_FOUND.md

Write `docs/browzer/<feat-id>/SKILLS_FOUND.md` (plain markdown, no staging/ prefix).

**Canonical top-level key is `installed` (array).** Each element shape: `{ skill: string, domain: string, relevance: string, source: string, discoveredFrom: string }`.

<!-- schema migration: relevance moved from numeric weight to enum string on 2026-05-12. The example block has always used "high"/"medium"/"low" strings — the prior `number` type annotation was a typo. Any downstream consumer that parsed relevance as a number (e.g. an aggregator computing avg relevance) must update to treat this field as `"high" | "medium" | "low"`. -->

The `discoveredFrom` field is **MANDATORY** for every `installed[]` element. It is the absolute path of the `SKILL.md` file that resolved this entry (e.g. `.claude/skills/<name>/SKILL.md`, `~/.claude/skills/<name>/SKILL.md`, or a plugin path like `.claude/plugins/cache/browzer-marketplace/browzer/<ver>/skills/<name>/SKILL.md`).

The `discoveredFrom` field makes discovery auditable. Downstream consumers (PO, code-review specialist selection) can re-stat the path to confirm the skill is still on disk.

Concrete example (parsable JSON, minimum one element):

```json
{
  "featId": "feat-20260101-my-feature",
  "discoveredAt": "2026-01-01T12:00:00.000Z",
  "installed": [
    {
      "skill": "browzer:rag-implementation",
      "domain": "RAG / vector search",
      "relevance": "high",
      "source": "plugin:browzer",
      "discoveredFrom": ".claude/plugins/cache/browzer-marketplace/browzer/5.0.0/skills/rag-implementation/SKILL.md"
    }
  ]
}
```

`skill` MUST be the exact invocable string — `browzer:<name>` for plugin skills, `<name>` for project/user skills. Never include a marketplace URL or install command in this field.

**Anti-pattern:** Do not emit `matched_installed_skills` as a top-level key. The canonical key is `installed`; using `matched_installed_skills` breaks the judge contract and causes downstream agent dispatch to skip the skills entirely.

**Anti-pattern:** Skills emitted WITHOUT `discoveredFrom` cannot be re-validated by downstream agents and SHOULD be treated as unverifiable.

Return one line: `find-skills: <N> installed skills matched; <M> marketplace gaps identified`.

## How it works

1. **Identify the need** — domain (React, testing, design, deployment) + specific task (write tests, create animations, review PRs).
2. **Check the leaderboard FIRST** at https://skills.sh/ — top skills are install-ranked. Reputable defaults:
   - `vercel-labs/agent-skills` — React, Next.js, web design (100K+ installs each)
   - `anthropics/skills` — Frontend design, document processing (100K+ installs)
   - `microsoft/agent-skills`, `ComposioHQ/awesome-claude-skills` — broader ecosystem
3. **If the leaderboard doesn't cover it**, run a search:

   ```bash
   npx skills find <query>
   ```

4. **Vet before recommending**:
   - Install count ≥ 1K (be skeptical under 100).
   - Source reputation — official orgs over unknown authors.
   - GitHub stars on the source repo (treat <100 stars with skepticism).
5. **Present options** with name, what it does, install count, source, install command, learn-more link.
6. **Install on confirmation**:

   ```bash
   npx skills add <owner/repo@skill> -g -y
   ```

   `-g` = user-level install, `-y` = skip confirmation.

## CLI reference

| Command                   | Purpose                              |
| ------------------------- | ------------------------------------ |
| `npx skills find [query]` | Interactive or keyword search        |
| `npx skills add <pkg>`    | Install from GitHub or other sources |
| `npx skills check`        | Check for updates                    |
| `npx skills update`       | Apply available updates              |
| `npx skills init <name>`  | Scaffold a brand-new skill           |

## Examples

**Input:** "how do I make my React app faster?"
**Action:** Check leaderboard → recommend `vercel-labs/agent-skills@react-best-practices` (185K installs).
**Response:**

```
"react-best-practices" — React and Next.js performance optimization
guidelines from Vercel Engineering. (185K installs)

Install: npx skills add vercel-labs/agent-skills@react-best-practices
Learn more: https://skills.sh/vercel-labs/agent-skills/react-best-practices
```

**Input:** "can you help me with PR reviews?"
**Action:** `npx skills find pr review` → vet results → recommend the top hit.

**Input:** "I need to create a changelog"
**Action:** `npx skills find changelog` → vet → recommend or fall back if none qualify.

## Common categories (search seeds)

| Category     | Example queries                          |
| ------------ | ---------------------------------------- |
| Web          | react, nextjs, typescript, css, tailwind |
| Testing      | testing, jest, playwright, e2e           |
| DevOps       | deploy, docker, kubernetes, ci-cd        |
| Docs         | docs, readme, changelog, api-docs        |
| Quality      | review, lint, refactor, best-practices   |
| Design       | ui, ux, design-system, accessibility     |
| Productivity | workflow, automation, git                |

## Search tips

- **Specific keywords beat generic ones**: "react testing" > "testing".
- **Try alternative terms**: if "deploy" misses, try "deployment" or "ci-cd".
- **Lean on popular sources**: many quality skills live under `vercel-labs/agent-skills` or `ComposioHQ/awesome-claude-skills`.

## When nothing relevant exists

1. Say so explicitly — don't recommend a low-quality match just to fill space.
2. Offer to help directly with general capabilities.
3. Suggest the user scaffold their own:

   ```bash
   npx skills init my-<domain>-skill
   ```

## Anti-patterns

- Recommending a skill purely on a search-result match without vetting install count + source.
- Reading skill READMEs back to the user instead of just installing the skill and letting it self-document on first invocation.
- Suggesting `npx skills add` for skills already shipped inside the active plugin (check loaded skills first).

## Skill invocation naming — canonical format

When a skill is discovered (either via this tool or via the Explorer pass in `generate-task`) and its name is stored in `task.explorer.skillsFound[].skill`, the value in that field is the **exact string to pass to `Skill(...)`**.

Two forms are valid:

| Form              | When to use                                                     | Example                                                      |
| ----------------- | --------------------------------------------------------------- | ------------------------------------------------------------ |
| `<plugin>:<name>` | Skills from an external plugin (not the active built-in plugin) | `browzer:prisma-migrate`, `vercel-labs:react-best-practices` |
| `<name>`          | Skills shipped inside the currently active plugin (no prefix)   | `find-skills`, `code-review`, `execute-task`                 |

Rules:

- **Never** invent the form — always use the value from `skillsFound[].skill` verbatim.
- The `domain` field in `#SkillFound` is for human display only; it is NOT part of the `Skill(...)` invocation.
- If a skill fails to load with `<plugin>:<name>`, do NOT retry with `<name>` alone (or vice versa) — the forms are not interchangeable because they resolve against different registries.

---
name: find-skills
description: "Discover and install agent skills from the open skills.sh ecosystem when the user asks for a capability that may already exist as a packaged skill. Use whenever the user says 'find a skill for X', 'is there a skill that…', 'can you do <X>', 'I wish I had help with <domain>', 'install a skill for <topic>', or 'search the skills marketplace'. Wraps the `npx skills` CLI: `find` (search), `add` (install), `check` (updates), `update` (apply), `init` (scaffold a new skill). Always check the skills.sh leaderboard before searching, prefer skills with 1K+ installs from reputable sources (vercel-labs, anthropics, microsoft), and verify the source repo before recommending. If no relevant skill exists, fall back to direct help and suggest `npx skills init`. Triggers: 'find a skill', 'is there a skill', 'install a skill for', 'can you do <X>', 'help me with <domain>', 'extend my capabilities', 'browse skills.sh'."
allowed-tools: Bash(npx *), Bash(curl *), WebFetch
---

# find-skills — discover + install skills from the open skills ecosystem

Wraps the `npx skills` CLI (the package manager for skills.sh) so a user asking for a capability gets a quality-vetted skill recommendation, not a hand-rolled answer when a packaged one already exists.

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

| Command | Purpose |
| --- | --- |
| `npx skills find [query]` | Interactive or keyword search |
| `npx skills add <pkg>` | Install from GitHub or other sources |
| `npx skills check` | Check for updates |
| `npx skills update` | Apply available updates |
| `npx skills init <name>` | Scaffold a brand-new skill |

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

| Category | Example queries |
| --- | --- |
| Web | react, nextjs, typescript, css, tailwind |
| Testing | testing, jest, playwright, e2e |
| DevOps | deploy, docker, kubernetes, ci-cd |
| Docs | docs, readme, changelog, api-docs |
| Quality | review, lint, refactor, best-practices |
| Design | ui, ux, design-system, accessibility |
| Productivity | workflow, automation, git |

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

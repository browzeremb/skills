#!/usr/bin/env python3
"""Map installed Claude skills against a repo's detected tech stack.

Walks four skill roots by default — recursively — so both flat and nested
(plugin-style) layouts are discovered:
  ~/.claude/skills          (user-installed, flat)
  ~/.claude/plugins         (user-installed plugins)
  <repo>/.claude/skills     (workspace-local)
  <repo>/.claude/plugins    (workspace-local plugins)

Additional roots can be added via --extra-skill-root. For each SKILL.md
found, reads the YAML frontmatter, then scores the skill against signals
extracted from the repo's manifests (package.json, go.mod, pyproject.toml,
requirements*.txt).

Emits:
  - Human markdown doc (--out) grouped by High / Medium / Low relevance
  - JSON manifest (--manifest) with:
      skills:           [{name, tier, score, rationale, source}, ...]
      signals:          detected libs / frameworks / domains
      vocab_suggestions: terms worth adding to DEFAULT_VOCAB
        (filtered to remove generic language names)

Pure stdlib. No network. No writes outside --out / --manifest.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from collections import defaultdict
from pathlib import Path
from typing import Iterable

# --- YAML frontmatter: cheap parser ------------------------------------------
# Avoids a PyYAML dep. Handles the subset used by Claude SKILL.md files:
# top-level key: value, with values that may be quoted strings or bare scalars.
_FRONTMATTER_RE = re.compile(r"\A---\s*\n(.*?)\n---\s*\n", re.DOTALL)


def parse_frontmatter(text: str) -> dict[str, str]:
    m = _FRONTMATTER_RE.match(text)
    if not m:
        return {}
    body = m.group(1)
    out: dict[str, str] = {}
    current_key: str | None = None
    for raw in body.splitlines():
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        if raw.startswith((" ", "\t")) and current_key:
            out[current_key] += " " + raw.strip()
            continue
        if ":" in raw:
            k, _, v = raw.partition(":")
            key = k.strip()
            val = v.strip()
            if (val.startswith('"') and val.endswith('"')) or (
                val.startswith("'") and val.endswith("'")
            ):
                val = val[1:-1]
            out[key] = val
            current_key = key
    return out


# --- Skill discovery ---------------------------------------------------------


_SKIP_DURING_WALK: frozenset[str] = frozenset({
    "node_modules", ".git", "dist", "build", "__pycache__",
    ".turbo", ".next", "coverage", ".venv", "venv", ".cache",
    # Claude's plugin "cache" dir keeps every version of every plugin ever
    # installed plus transient git checkouts — not active skill homes.
    # Active plugin skills live under ~/.claude/plugins/marketplaces/.
    "cache",
})


def iter_skill_dirs(roots: Iterable[Path]) -> Iterable[Path]:
    """Yield every skill directory (containing SKILL.md) under `roots`.

    Walks recursively so nested layouts — `<plugin>/tools/<skill>/SKILL.md`,
    `<plugin>/rag/<skill>/SKILL.md`, etc. — are discovered. Uses os.walk
    with followlinks=True because on most setups `~/.claude/skills/` is a
    directory of symlinks into `~/.agents/skills/` (or similar); Path.rglob
    does not follow symlinks, so the plain-rglob version would silently skip
    every symlinked skill. Cycle detection via visited-dir inodes keeps
    followlinks safe.
    """
    seen_skills: set[Path] = set()
    visited_dirs: set[Path] = set()
    for root in roots:
        if not root.exists() or not root.is_dir():
            continue
        for dirpath, dirnames, filenames in os.walk(root, followlinks=True):
            try:
                dirpath_resolved = Path(dirpath).resolve()
            except OSError:
                dirnames[:] = []
                continue
            if dirpath_resolved in visited_dirs:
                dirnames[:] = []
                continue
            visited_dirs.add(dirpath_resolved)
            dirnames[:] = [d for d in dirnames if d not in _SKIP_DURING_WALK]
            if "SKILL.md" in filenames:
                skill_md = Path(dirpath) / "SKILL.md"
                try:
                    resolved = skill_md.resolve()
                except OSError:
                    continue
                if resolved in seen_skills:
                    continue
                seen_skills.add(resolved)
                yield skill_md.parent


def load_skill(skill_dir: Path) -> dict | None:
    skill_md = skill_dir / "SKILL.md"
    try:
        text = skill_md.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None
    fm = parse_frontmatter(text)
    name = fm.get("name") or skill_dir.name
    description = fm.get("description", "")
    return {
        "name": name,
        "description": description,
        "path": str(skill_dir),
        "haystack": (name + " " + description).lower(),
    }


# --- Repo signal extraction --------------------------------------------------

# Map package name → (display_term, category). display_term is what we'll
# surface in the vocab-suggestion list (lowercased, trigger-friendly).
SIGNAL_KEYWORDS: dict[str, tuple[str, str]] = {
    # web frameworks
    "fastify": ("fastify", "web"),
    "express": ("express", "web"),
    "hono": ("hono", "web"),
    "koa": ("koa", "web"),
    "@nestjs/core": ("nestjs", "web"),
    "next": ("next.js", "web"),
    "react": ("react", "web"),
    "vue": ("vue", "web"),
    "svelte": ("svelte", "web"),
    "@sveltejs/kit": ("sveltekit", "web"),
    "@remix-run/react": ("remix", "web"),
    "astro": ("astro", "web"),
    # orm / db
    "drizzle-orm": ("drizzle", "db"),
    "@prisma/client": ("prisma", "db"),
    "prisma": ("prisma", "db"),
    "kysely": ("kysely", "db"),
    "typeorm": ("typeorm", "db"),
    "sequelize": ("sequelize", "db"),
    "mongoose": ("mongoose", "db"),
    "pg": ("postgres", "db"),
    "postgres": ("postgres", "db"),
    "mysql2": ("mysql", "db"),
    "better-sqlite3": ("sqlite", "db"),
    "mongodb": ("mongodb", "db"),
    "redis": ("redis", "db"),
    "ioredis": ("redis", "db"),
    "neo4j-driver": ("neo4j", "db"),
    # queues
    "bullmq": ("bullmq", "queue"),
    "bull": ("bull", "queue"),
    "inngest": ("inngest", "queue"),
    # auth
    "better-auth": ("better-auth", "auth"),
    "@clerk/nextjs": ("clerk", "auth"),
    "@clerk/clerk-sdk-node": ("clerk", "auth"),
    "auth0": ("auth0", "auth"),
    "next-auth": ("next-auth", "auth"),
    "@auth/core": ("next-auth", "auth"),
    "lucia": ("lucia", "auth"),
    "@supabase/supabase-js": ("supabase", "auth"),
    # ui
    "tailwindcss": ("tailwind", "ui"),
    "@radix-ui/react-dialog": ("radix-ui", "ui"),
    "@chakra-ui/react": ("chakra", "ui"),
    "@mantine/core": ("mantine", "ui"),
    "@mui/material": ("mui", "ui"),
    # testing
    "vitest": ("vitest", "testing"),
    "jest": ("jest", "testing"),
    "mocha": ("mocha", "testing"),
    "@playwright/test": ("playwright", "testing"),
    "cypress": ("cypress", "testing"),
    # tooling
    "turbo": ("turborepo", "build"),
    "nx": ("nx", "build"),
    "vite": ("vite", "build"),
    "esbuild": ("esbuild", "build"),
    "webpack": ("webpack", "build"),
    "rollup": ("rollup", "build"),
    "tsup": ("tsup", "build"),
    "@biomejs/biome": ("biome", "build"),
    "eslint": ("eslint", "build"),
    "prettier": ("prettier", "build"),
    # validation
    "zod": ("zod", "validation"),
    "yup": ("yup", "validation"),
    "joi": ("joi", "validation"),
    "valibot": ("valibot", "validation"),
    "ajv": ("ajv", "validation"),
    # llm / ai
    "langchain": ("langchain", "llm"),
    "langfuse": ("langfuse", "llm"),
    "llamaindex": ("llamaindex", "llm"),
    "openai": ("openai sdk", "llm"),
    "@anthropic-ai/sdk": ("anthropic sdk", "llm"),
    "@modelcontextprotocol/sdk": ("mcp", "llm"),
    "tiktoken": ("tiktoken", "llm"),
    "js-tiktoken": ("tiktoken", "llm"),
    # vector stores (distinct from generic db)
    "@pinecone-database/pinecone": ("pinecone", "vector"),
    "pinecone-client": ("pinecone", "vector"),
    "chromadb": ("chroma", "vector"),
    "@qdrant/js-client-rest": ("qdrant", "vector"),
    "qdrant-client": ("qdrant", "vector"),
    "weaviate-ts-client": ("weaviate", "vector"),
    "weaviate-client": ("weaviate", "vector"),
    # api flavors
    "@trpc/server": ("trpc", "web"),
    "@trpc/client": ("trpc", "web"),
    "graphql": ("graphql", "web"),
    "@apollo/server": ("apollo", "web"),
    # queues / workflow
    "pg-boss": ("pg-boss", "queue"),
    "bree": ("bree", "queue"),
    "@temporalio/client": ("temporal", "queue"),
    "@temporalio/worker": ("temporal", "queue"),
    # search
    "algoliasearch": ("algolia", "search"),
    "@elastic/elasticsearch": ("elasticsearch", "search"),
    "typesense": ("typesense", "search"),
    "meilisearch": ("meilisearch", "search"),
    # storage
    "@aws-sdk/client-s3": ("s3", "storage"),
    "minio": ("minio", "storage"),
    "@google-cloud/storage": ("gcs", "storage"),
    # email / comms
    "resend": ("resend", "email"),
    "@sendgrid/mail": ("sendgrid", "email"),
    "postmark": ("postmark", "email"),
    "twilio": ("twilio", "comms"),
    # realtime
    "socket.io": ("socket.io", "realtime"),
    "pusher-js": ("pusher", "realtime"),
    "ably": ("ably", "realtime"),
    # analytics
    "posthog-js": ("posthog", "analytics"),
    "posthog-node": ("posthog", "analytics"),
    "mixpanel-browser": ("mixpanel", "analytics"),
    "@segment/analytics-node": ("segment", "analytics"),
    "amplitude-js": ("amplitude", "analytics"),
    # forms / rich text / viz
    "react-hook-form": ("react-hook-form", "ui"),
    "framer-motion": ("framer motion", "ui"),
    "@tiptap/react": ("tiptap", "ui"),
    "lexical": ("lexical", "ui"),
    "@lexical/react": ("lexical", "ui"),
    "@react-three/fiber": ("react three fiber", "ui"),
    "three": ("three.js", "ui"),
    "leaflet": ("leaflet", "ui"),
    "mapbox-gl": ("mapbox", "ui"),
    "@tanstack/react-table": ("tanstack table", "ui"),
    "@tanstack/react-router": ("tanstack router", "web"),
    "@xyflow/react": ("react flow", "ui"),
    "reactflow": ("react flow", "ui"),
    # validation — specialized bridges (zod already in vocab; these aren't)
    "drizzle-zod": ("drizzle-zod", "validation"),
    "@hookform/resolvers": ("hook-form resolvers", "validation"),
    "fastify-type-provider-zod": ("fastify-zod", "validation"),
    # payments
    "stripe": ("stripe", "payments"),
    "@stripe/stripe-js": ("stripe", "payments"),
    # observability
    "@opentelemetry/api": ("opentelemetry", "obs"),
    "@sentry/node": ("sentry", "obs"),
    # state
    "@tanstack/react-query": ("tanstack query", "state"),
    "swr": ("swr", "state"),
    "zustand": ("zustand", "state"),
    "jotai": ("jotai", "state"),
    "redux": ("redux", "state"),
}

# Categories that define a stack's identity. A single match in one of these is
# enough to promote a skill to High tier — e.g. a repo using Fastify benefits
# from fastify-best-practices even if that skill only mentions "fastify" once.
# Non-core categories (ui, analytics, email, etc.) still need breadth (score≥3)
# to earn High — they're decorations, not load-bearing architecture.
CORE_CATEGORIES: frozenset[str] = frozenset({
    "web", "db", "vector", "queue", "auth", "llm", "search", "storage",
})

# Already-present vocab. Kept in sync with user-prompt-browzer-search.mjs —
# if the guard's list grows, update this set so we don't over-suggest.
EXISTING_VOCAB: set[str] = {
    "fastify", "express", "hono", "koa", "nestjs", "nest.js",
    "next", "next.js", "nextjs", "react", "vue", "svelte", "sveltekit",
    "remix", "astro", "solid.js", "solidjs",
    "drizzle", "prisma", "kysely", "typeorm", "sequelize", "mongoose",
    "postgres", "postgresql", "mysql", "sqlite", "mongodb", "redis",
    "neo4j", "cypher",
    "bullmq", "bull", "celery", "sidekiq", "agenda", "inngest", "trigger.dev",
    "better-auth", "betterauth", "clerk", "auth0", "nextauth", "next-auth",
    "lucia", "supabase",
    "tailwind", "tailwindcss", "shadcn", "shadcn/ui", "radix", "radix-ui",
    "chakra", "mantine", "mui", "material-ui",
    "vitest", "jest", "mocha", "chai", "playwright", "cypress",
    "testing-library",
    "turborepo", "turbo", "lerna", "nx", "rush", "vite", "esbuild", "swc",
    "webpack", "rollup", "tsup", "biome", "eslint", "prettier",
    "zod", "yup", "joi", "valibot", "ajv",
    "langchain", "langfuse", "langgraph", "llamaindex", "ai sdk",
    "openai sdk", "anthropic sdk", "mcp", "model context protocol",
    "stripe", "paddle", "lemon squeezy",
    "vercel", "railway", "netlify", "cloudflare workers", "cloudflare",
    "fly.io", "render", "aws lambda",
    "grafana", "prometheus", "datadog", "sentry", "opentelemetry", "otel",
    "react-query", "tanstack query", "tanstack", "swr", "zustand", "jotai",
    "redux", "mobx", "recoil",
    "pnpm workspaces", "yarn workspaces",
}


def read_json(path: Path) -> dict | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def collect_signals(repo: Path) -> tuple[set[str], dict[str, set[str]]]:
    """Return (trigger_terms, categories)."""
    triggers: set[str] = set()
    categories: dict[str, set[str]] = defaultdict(set)

    skip_dirs = {"node_modules", ".git", "dist", "build", ".next", ".turbo",
                 "coverage", ".venv", "venv", "__pycache__"}

    def add(pkg: str) -> None:
        hit = SIGNAL_KEYWORDS.get(pkg)
        if not hit:
            return
        term, cat = hit
        triggers.add(term)
        categories[cat].add(term)

    for pkg_json in repo.rglob("package.json"):
        if any(part in skip_dirs for part in pkg_json.parts):
            continue
        data = read_json(pkg_json)
        if not data:
            continue
        for key in ("dependencies", "devDependencies", "peerDependencies",
                    "optionalDependencies"):
            deps = data.get(key) or {}
            if isinstance(deps, dict):
                for name in deps:
                    add(name)

    # go.mod (best-effort)
    for go_mod in repo.rglob("go.mod"):
        if any(part in skip_dirs for part in go_mod.parts):
            continue
        try:
            text = go_mod.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        if "gin-gonic/gin" in text:
            triggers.add("gin")
            categories["web"].add("gin")
        if "labstack/echo" in text:
            triggers.add("echo")
            categories["web"].add("echo")
        if "gofiber/fiber" in text:
            triggers.add("fiber")
            categories["web"].add("fiber")

    # pyproject.toml / requirements*.txt (regex-light)
    py_libs = {
        "fastapi": ("fastapi", "web"),
        "flask": ("flask", "web"),
        "django": ("django", "web"),
        "sqlalchemy": ("sqlalchemy", "db"),
        "pydantic": ("pydantic", "validation"),
        "langchain": ("langchain", "llm"),
        "langfuse": ("langfuse", "llm"),
        "llama-index": ("llamaindex", "llm"),
        "openai": ("openai sdk", "llm"),
        "anthropic": ("anthropic sdk", "llm"),
        "tiktoken": ("tiktoken", "llm"),
        "chromadb": ("chroma", "vector"),
        "pinecone-client": ("pinecone", "vector"),
        "qdrant-client": ("qdrant", "vector"),
        "weaviate-client": ("weaviate", "vector"),
        "celery": ("celery", "queue"),
        "redis": ("redis", "db"),
        "psycopg": ("postgres", "db"),
        "psycopg2": ("postgres", "db"),
        "asyncpg": ("postgres", "db"),
    }
    for candidate in list(repo.rglob("pyproject.toml")) + \
                     list(repo.rglob("requirements*.txt")):
        if any(part in skip_dirs for part in candidate.parts):
            continue
        try:
            text = candidate.read_text(encoding="utf-8",
                                       errors="replace").lower()
        except OSError:
            continue
        for lib, (term, cat) in py_libs.items():
            if re.search(rf"\b{re.escape(lib)}\b", text):
                triggers.add(term)
                categories[cat].add(term)

    return triggers, categories


# --- Scoring -----------------------------------------------------------------


def score_skill(skill: dict, triggers: set[str]) -> tuple[int, list[str]]:
    hay = skill["haystack"]
    matched = [t for t in sorted(triggers) if t in hay]
    return len(matched), matched


def tier_of(score: int, matched: list[str],
            term_to_cat: dict[str, str]) -> str:
    """Assign a tier based on breadth AND architectural centrality.

    Rationale: skill descriptions are narrow (most mention 1–2 libs). Requiring
    3 matches to qualify as High means a textbook stack like fastify+drizzle+
    zod+postgres+vitest scores every matching skill at Medium, which is wrong
    — fastify-best-practices IS the first skill to reach for on that repo.
    Solution: one hit in a CORE_CATEGORIES match promotes a skill to High
    because that category defines the stack. Matches outside core categories
    (ui, analytics, email, …) still need breadth (≥3) to be High — they're
    decorations, not architecture.
    """
    if any(term_to_cat.get(t) in CORE_CATEGORIES for t in matched):
        return "High"
    if score >= 3:
        return "High"
    if score >= 1:
        return "Medium"
    return "Low"


# --- Output ------------------------------------------------------------------


def render_markdown(repo: Path, skills: list[dict],
                    categories: dict[str, set[str]]) -> str:
    lines: list[str] = []
    lines.append(f"# Claude Skills Relevance Map — {repo.name}")
    lines.append("")
    lines.append(
        "Generated by `give-claude-rag-steroids` / `map_skills.py`. "
        "Ranks every Claude skill installed on this machine against the "
        "tech signals extracted from this repo's manifests. High-tier "
        "skills are the ones to reach for first on this codebase."
    )
    lines.append("")

    if categories:
        lines.append("## Detected stack signals")
        lines.append("")
        for cat in sorted(categories):
            terms = ", ".join(sorted(categories[cat]))
            lines.append(f"- **{cat}**: {terms}")
        lines.append("")

    buckets: dict[str, list[dict]] = {"High": [], "Medium": [], "Low": []}
    for s in skills:
        buckets[s["tier"]].append(s)

    for tier in ("High", "Medium", "Low"):
        entries = buckets[tier]
        if not entries:
            continue
        lines.append(f"## {tier} relevance ({len(entries)})")
        lines.append("")
        for s in entries:
            hits = ", ".join(s["matched"]) if s["matched"] else "—"
            desc = (s["description"] or "").strip().replace("\n", " ")
            if len(desc) > 220:
                desc = desc[:217] + "…"
            lines.append(f"### {s['name']}")
            lines.append("")
            lines.append(f"- Matched signals: {hits}")
            lines.append(f"- Source: `{s['path']}`")
            if desc:
                lines.append(f"- Description: {desc}")
            lines.append("")

    lines.append("## How to use this doc")
    lines.append("")
    lines.append(
        "- For any task on this repo, open the High tier first — those skills "
        "explicitly mention the libraries this codebase runs on."
    )
    lines.append(
        "- Medium-tier skills are domain-adjacent (e.g. testing, commit "
        "style, documentation). Reach for them when the task is orthogonal "
        "to the core stack."
    )
    lines.append(
        "- Low-tier skills are listed for completeness; invoking them on "
        "this repo usually wastes context."
    )
    lines.append("")
    return "\n".join(lines)


# --- CLI ---------------------------------------------------------------------


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", required=True, type=Path,
                    help="Path to the repo to analyze")
    ap.add_argument("--out", required=True, type=Path,
                    help="Destination markdown path")
    ap.add_argument("--manifest", required=True, type=Path,
                    help="Destination JSON manifest path")
    ap.add_argument("--extra-skill-root", action="append", default=[],
                    type=Path,
                    help="Additional directory to scan for skills")
    args = ap.parse_args()

    repo: Path = args.repo.resolve()
    if not repo.is_dir():
        print(f"error: --repo is not a directory: {repo}", file=sys.stderr)
        return 2

    # Default roots to scan. We walk recursively from each, so any layout
    # with SKILL.md somewhere inside is discovered. Plugins live under
    # ~/.claude/plugins/ (user installs) or inside the repo at
    # <repo>/.claude/plugins/ (workspace-scoped).
    roots = [
        Path.home() / ".claude" / "skills",
        Path.home() / ".claude" / "plugins",
        repo / ".claude" / "skills",
        repo / ".claude" / "plugins",
        *args.extra_skill_root,
    ]

    skills_raw = [s for s in (load_skill(d) for d in iter_skill_dirs(roots))
                  if s]
    if not skills_raw:
        print("warn: no skills found under any root; writing empty report",
              file=sys.stderr)

    triggers, categories = collect_signals(repo)

    # Invert categories for O(1) term → category lookup in tier_of.
    term_to_cat: dict[str, str] = {}
    for cat, terms in categories.items():
        for term in terms:
            term_to_cat[term] = cat

    scored: list[dict] = []
    for s in skills_raw:
        score, matched = score_skill(s, triggers)
        scored.append({
            **s,
            "score": score,
            "matched": matched,
            "tier": tier_of(score, matched, term_to_cat),
        })
    scored.sort(key=lambda s: (-s["score"], s["name"].lower()))

    vocab_suggestions = sorted(t for t in triggers if t not in EXISTING_VOCAB)

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.manifest.parent.mkdir(parents=True, exist_ok=True)

    args.out.write_text(render_markdown(repo, scored, categories),
                        encoding="utf-8")
    args.manifest.write_text(json.dumps({
        "repo": str(repo),
        "signals": sorted(triggers),
        "categories": {k: sorted(v) for k, v in categories.items()},
        "vocab_suggestions": vocab_suggestions,
        "skills": [
            {
                "name": s["name"],
                "tier": s["tier"],
                "score": s["score"],
                "matched": s["matched"],
                "source": s["path"],
            }
            for s in scored
        ],
    }, indent=2), encoding="utf-8")

    print(f"wrote {args.out}")
    print(f"wrote {args.manifest}")
    print(f"skills: {len(scored)} (High: "
          f"{sum(1 for s in scored if s['tier']=='High')}, Medium: "
          f"{sum(1 for s in scored if s['tier']=='Medium')}, Low: "
          f"{sum(1 for s in scored if s['tier']=='Low')})")
    print(f"vocab suggestions: {len(vocab_suggestions)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

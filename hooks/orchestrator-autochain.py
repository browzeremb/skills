#!/usr/bin/env python3
"""
orchestrator-autochain — Stop hook that blocks end-of-turn when
orchestrate-task-delivery is mid-pipeline in autonomous mode and the
last assistant response emitted a phase-end confirmation line WITHOUT
calling the next phase's Skill(...) in the same response.

Wired as a `Stop` hook in `~/.claude/settings.json` (or project-level
`.claude/settings.json`). Reads `docs/browzer/feat-*/workflow.json`
to resolve `.config.mode`. If mode != autonomous, the hook is a no-op.

The hook respects `stop_hook_active` to avoid infinite loops: once a
single Stop has already been blocked, we let the next Stop through
unconditionally so the operator can recover.
"""

from __future__ import annotations

import glob
import json
import os
import re
import sys
from pathlib import Path

PHASE_END_PATTERN = re.compile(
    r"""(?xm)
    ^[ \t]*
    (?P<skill>[a-z][a-z0-9-]+)            # skill name
    :\s+
    (?:updated\ workflow\.json\s+|stopped\ at\s+|paused\ at\s+)?
    STEP_\d{2}_[A-Z][A-Z_0-9]*            # STEP_NN_NAME
    [^\n]*?
    status\s+(?P<status>COMPLETED|AWAITING_REVIEW|PAUSED_PENDING_OPERATOR)
    """
)

PIPELINE_TERMINAL_PATTERN = re.compile(
    r"^orchestrate-task-delivery:\s+(completed|stopped)\b",
    re.MULTILINE,
)

PHASE_PAUSE_PATTERN = re.compile(
    r"^[a-z][a-z0-9-]+:\s+paused at STEP_\d{2}_[A-Z][A-Z_0-9]*",
    re.MULTILINE,
)


def _read_transcript(path: str) -> list[dict]:
    entries: list[dict] = []
    try:
        with open(path, encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    entries.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
    except OSError:
        return []
    return entries


def _latest_assistant(entries: list[dict]) -> dict | None:
    for entry in reversed(entries):
        kind = entry.get("type") or entry.get("role")
        if kind == "assistant":
            return entry
    return None


def _content_blocks(entry: dict) -> list:
    msg = entry.get("message")
    if isinstance(msg, dict):
        content = msg.get("content")
    else:
        content = entry.get("content")
    if isinstance(content, str):
        return [{"type": "text", "text": content}]
    if isinstance(content, list):
        return content
    return []


def _resolve_mode(cwd: str) -> str | None:
    pattern = os.path.join(cwd, "docs", "browzer", "feat-*", "workflow.json")
    candidates = sorted(glob.glob(pattern), key=os.path.getmtime, reverse=True)
    for path in candidates:
        try:
            with open(path, encoding="utf-8") as fh:
                wf = json.load(fh)
        except (OSError, json.JSONDecodeError):
            continue
        mode = (wf.get("config") or {}).get("mode")
        if mode:
            return mode
    return None


def main() -> int:
    try:
        payload = json.loads(sys.stdin.read() or "{}")
    except json.JSONDecodeError:
        return 0

    if payload.get("stop_hook_active"):
        return 0

    transcript = payload.get("transcript_path")
    if not transcript or not os.path.exists(transcript):
        return 0

    cwd = payload.get("cwd") or os.getcwd()
    mode = _resolve_mode(cwd)
    if mode != "autonomous":
        return 0

    entries = _read_transcript(transcript)
    last = _latest_assistant(entries)
    if not last:
        return 0

    blocks = _content_blocks(last)
    text_parts: list[str] = []
    skill_called = False
    for block in blocks:
        if not isinstance(block, dict):
            continue
        btype = block.get("type")
        if btype == "text":
            text_parts.append(block.get("text", ""))
        elif btype == "tool_use" and block.get("name") == "Skill":
            skill_called = True

    if skill_called:
        return 0

    text = "\n".join(text_parts)

    if PIPELINE_TERMINAL_PATTERN.search(text):
        return 0

    if PHASE_PAUSE_PATTERN.search(text):
        return 0

    match = PHASE_END_PATTERN.search(text)
    if not match:
        return 0

    skill = match.group("skill")
    status = match.group("status")
    hint = (
        f"orchestrator-autochain: phase '{skill}' reported status {status} but no "
        "Skill(...) call followed in this response. workflow.json `.config.mode == "
        '"autonomous"` requires you to invoke the next phase\'s Skill(...) in the '
        "SAME response turn (orchestrate-task-delivery/SKILL.md §Step 3 chain "
        "contract + references/mode-contract.md §Step 4.0.5). Resume the chain by "
        "calling the next-phase Skill now. If the pipeline is genuinely complete, "
        "emit 'orchestrate-task-delivery: completed <featureId> in <Nm>' as the "
        "final cursor before stopping."
    )

    sys.stdout.write(
        json.dumps({"decision": "block", "reason": hint}, ensure_ascii=False)
    )
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

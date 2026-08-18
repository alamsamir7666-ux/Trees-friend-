#!/usr/bin/env python3
"""
Fix ALL hardcoded repo paths in test files.

Two patterns to fix:
1. const REPO_ROOT = "/home/z/my-project/Trees-friend-";
   → already fixed by fix-test-paths.py for 25 files

2. Inline paths in fs.readFileSync("..."):
   "/home/z/my-project/repos/Trees-friend-/artifacts/api-server/src/routes/ai.ts"
   "/home/z/my-project/Trees-friend-/artifacts/api-server/src/routes/ai.ts"

Strategy: replace any hardcoded absolute path that ends with a known
source file path with a path.resolve(__dirname, "../src/...") call.

But that's invasive (changes fs.readFileSync calls). Simpler: define
a REPO_ROOT constant at the top of each file (if not present) and
replace the inline string with `${REPO_ROOT}/artifacts/...`.

Even simpler for files that already have REPO_ROOT: just replace the
inline absolute path with `${REPO_ROOT}/...`. For files without
REPO_ROOT: add it + replace.

This script handles both cases.
"""
import re
from pathlib import Path

TEST_DIR = Path("/home/z/my-project/Trees-friend-/artifacts/api-server/test")
PATH_IMPORT = 'import * as path from "node:path";'
REPO_ROOT_DECL = 'const REPO_ROOT = path.resolve(__dirname, "../../..");'

# Match any hardcoded absolute path containing "Trees-friend-"
# Captures the part after "Trees-friend-/" (the relative repo path).
HARDCODED_PATH_RE = re.compile(
    r'"(/home/z/my-project/(?:repos/)?Trees-friend-/([^"]+))"'
)

state = {"files_fixed": 0, "paths_fixed": 0}

for ts_file in sorted(TEST_DIR.glob("*.ts")):
    content = ts_file.read_text()
    if not HARDCODED_PATH_RE.search(content):
        continue

    original = content

    # Step 1: ensure `import * as path from "node:path";` is present
    if PATH_IMPORT not in content:
        # Find the last import line to insert after.
        lines = content.split("\n")
        last_import_idx = -1
        for i, line in enumerate(lines):
            if line.strip().startswith("import ") and 'from "' in line:
                last_import_idx = i
        if last_import_idx >= 0:
            lines.insert(last_import_idx + 1, PATH_IMPORT)
            content = "\n".join(lines)
        else:
            content = PATH_IMPORT + "\n" + content

    # Step 2: ensure REPO_ROOT const is present
    if "const REPO_ROOT" not in content:
        # Insert after the path import (which we just ensured exists).
        content = content.replace(
            PATH_IMPORT,
            PATH_IMPORT + "\n\n" + REPO_ROOT_DECL,
            1,
        )
        # If there's already a `import { describe, it, expect } from "vitest";`
        # before our path import, the REPO_ROOT goes after the path import.
        # But if the file has other imports after path, we want REPO_ROOT
        # before them. The simple replace above puts it right after the
        # path import, which is fine.

    # Step 3: replace all hardcoded paths with a template literal
    # `${REPO_ROOT}/<relative>`. We MUST wrap in backticks (not double quotes)
    # because ${...} interpolation only works inside template literals.
    # The original was a double-quoted string, so we swap the surrounding
    # quotes from " to `.
    def replace_path(match):
        state["paths_fixed"] += 1
        full_path = match.group(1)  # /home/z/.../Trees-friend-/artifacts/...
        relative = match.group(2)   # artifacts/...
        # Use backticks for template literal so ${REPO_ROOT} interpolates.
        return f"`${{REPO_ROOT}}/{relative}`"

    content = HARDCODED_PATH_RE.sub(replace_path, content)

    if content != original:
        ts_file.write_text(content)
        state["files_fixed"] += 1
        print(f"  fixed: {ts_file.name}")

print(f"\n{state['files_fixed']} files fixed, {state['paths_fixed']} paths replaced.")

#!/usr/bin/env python3
"""
Fix hardcoded REPO_ROOT paths in test files.

Pattern: replace
    const REPO_ROOT = "/home/z/my-project/Trees-friend-";
with
    const REPO_ROOT = path.resolve(__dirname, "../../..");

And ensure `import * as path from "node:path";` is present.
"""
import re
import sys
from pathlib import Path

TEST_DIR = Path("/home/z/my-project/Trees-friend-/artifacts/api-server/test")
HARDCODED = 'const REPO_ROOT = "/home/z/my-project/Trees-friend-";'
REPLACEMENT = 'const REPO_ROOT = path.resolve(__dirname, "../../..");'
PATH_IMPORT = 'import * as path from "node:path";'

files_fixed = 0
for ts_file in sorted(TEST_DIR.glob("*.ts")):
    content = ts_file.read_text()
    if HARDCODED not in content:
        continue

    # Replace the hardcoded path with the portable one.
    new_content = content.replace(HARDCODED, REPLACEMENT)

    # Ensure the path import is present. Insert after the last existing
    # `import ... from "node:..."` line, or after the first `import` line
    # if no node: import exists.
    if PATH_IMPORT not in new_content:
        # Find the last node: import line (or any import line) to insert after.
        lines = new_content.split("\n")
        last_import_idx = -1
        for i, line in enumerate(lines):
            if line.strip().startswith("import ") and 'from "' in line:
                last_import_idx = i
        if last_import_idx >= 0:
            lines.insert(last_import_idx + 1, PATH_IMPORT)
            new_content = "\n".join(lines)
        else:
            # No imports at all — prepend at the top.
            new_content = PATH_IMPORT + "\n" + new_content

    ts_file.write_text(new_content)
    files_fixed += 1
    print(f"  fixed: {ts_file.name}")

print(f"\n{files_fixed} files fixed.")

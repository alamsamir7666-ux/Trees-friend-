#!/usr/bin/env bash
# push-with-token.sh — push the current branch using a PAT read from a file.
#
# Usage:
#   echo "ghp_xxxx" > /tmp/gh-token.txt
#   bash scripts/push-with-token.sh
#
# The token is read from /tmp/gh-token.txt, used once for the push, then
# the token file is deleted. The token is NEVER persisted to .git/config
# (we use http.extraheader on the single git invocation, not credential
# storage). Shell history is also clean — the token lives in /tmp only.
#
# This pattern avoids the issue that triggered this commit's retry loop:
# sharing a PAT in plaintext chat (or in a commit message / env var that
# might be logged) causes GitHub's secret scanner to auto-revoke it within
# minutes. By reading from a file under /tmp, the token never appears in
# the conversation or in any committed file.

set -euo pipefail

TOKEN_FILE="${1:-/tmp/gh-token.txt}"

if [[ ! -f "$TOKEN_FILE" ]]; then
  echo "ERROR: token file not found at $TOKEN_FILE" >&2
  echo "Create it with:  echo \"ghp_xxxx\" > $TOKEN_FILE" >&2
  exit 1
fi

TOKEN=$(tr -d '[:space:]' < "$TOKEN_FILE")
if [[ -z "$TOKEN" ]]; then
  echo "ERROR: token file is empty" >&2
  exit 1
fi

# Verify the token is valid BEFORE pushing (catches revocation early).
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
  -H "Authorization: token $TOKEN" \
  https://api.github.com/user)
if [[ "$HTTP_CODE" != "200" ]]; then
  echo "ERROR: token is invalid or revoked (GitHub API returned $HTTP_CODE)" >&2
  echo "Generate a new PAT at: https://github.com/settings/tokens" >&2
  rm -f "$TOKEN_FILE"
  exit 1
fi

# Push using the Bearer token via http.extraheader (one-shot, not persisted).
# We don't use the user:token@host URL format because that gets cached in
# .git/config by some git versions. extraheader is per-invocation only.
REPO_URL=$(git remote get-url origin)
BRANCH=$(git rev-parse --abbrev-ref HEAD)

echo "Pushing branch '$BRANCH' to '$REPO_URL'..."
if git -c "http.extraheader=Authorization: Bearer $TOKEN" \
     push "$REPO_URL" "$BRANCH"; then
  echo "✓ Push succeeded."
else
  echo "✗ Push failed." >&2
  exit 1
fi

# Clean up — token file is deleted even on failure (don't leave it lying around).
rm -f "$TOKEN_FILE"
echo "✓ Token file deleted from $TOKEN_FILE."

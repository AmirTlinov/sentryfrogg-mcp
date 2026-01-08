 [LEGEND]

[CONTENT]
# Public Release Checklist

This project can create local state files (`profiles.json`, `.mcp_profiles.key`) that must never be committed.

## 1) Quick sanity

- Run `npm run check` and `npm test`.
- Confirm ignored local state is not tracked:
  - `git ls-files .mcp_profiles.key profiles.json` should print nothing.
- Check if secret files exist in history:
  - `git log --oneline -- .mcp_profiles.key profiles.json`
  - if this prints commits, follow section **2** before going public.
- Optional: scan history for other likely-sensitive filenames (names only):
  - `git log --all --pretty=format: --name-only | rg -i "password|token|secret|\\.pem$|id_rsa|\\.key$" | sort -u`

## 2) If secrets were committed in git history

If those files (or any other secrets) were ever committed, do **not** make the repository public until you:

1. Rotate credentials (DB/SSH/API tokens) and replace `ENCRYPTION_KEY`.
2. Purge history and force-push (coordinate with collaborators first).

Example purge (uses `git filter-repo`):

```bash
git filter-repo --path .mcp_profiles.key --path profiles.json --invert-paths
```

If `git filter-repo` is not available, you can use the built-in `git filter-branch` (slower, but works for small repos):

```bash
git filter-branch --force --index-filter \
  "git rm --cached --ignore-unmatch .mcp_profiles.key profiles.json" \
  --prune-empty --tag-name-filter cat -- --all

rm -rf .git/refs/original
git reflog expire --expire=now --all
git gc --prune=now --aggressive
```

After rewriting history:
- Re-tag/release as needed
- Force-push branches and tags
- Ask collaborators to re-clone

## 3) GitHub hygiene

- Ensure `SECURITY.md` is present and GitHub “Private vulnerability reporting” is enabled.
- Keep templates and docs up to date:
  - `.github/ISSUE_TEMPLATE/*`
  - `.github/pull_request_template.md`
  - `README.md`, `mcp_config.md`, `CHANGELOG.md`

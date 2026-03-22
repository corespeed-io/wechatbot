---
name: publish
description: Publish wechatbot packages to npm and PyPI. Use when the user wants to release, publish, or deploy a new version of the Node.js or Python SDK package.
---

# Publish Packages

This project has two publishable packages with separate GitHub Actions workflows:

| Package | Registry | Directory | Workflow | Tag pattern |
|---------|----------|-----------|----------|-------------|
| `@wechatbot/wechatbot` | npm | `nodejs/` | `.github/workflows/publish-npm.yml` | `node-v*` |
| `wechatbot-sdk` | PyPI | `python/` | `.github/workflows/publish-pypi.yml` | `py-v*` |

## Pre-publish Checklist

Before publishing, verify the following:

1. **Version is bumped** — ensure the version in the package manifest is updated:
   - npm: `nodejs/package.json` → `"version"` field
   - PyPI: `python/pyproject.toml` → `[project] version` field
2. **Tests pass** — run tests locally before tagging:
   - npm: `cd nodejs && npm test`
   - PyPI: `cd python && pytest`
3. **Build succeeds** — verify the package builds cleanly:
   - npm: `cd nodejs && npm run build`
   - PyPI: `cd python && python -m build`
4. **Changes are committed and pushed** to the main branch

## Publishing via Git Tag

Create and push a tag to trigger the GitHub Actions workflow:

### Publish Node.js to npm

```bash
# 1. Bump version in nodejs/package.json
# 2. Commit the change
git add nodejs/package.json
git commit -m "chore: bump node package to vX.Y.Z"
git push

# 3. Tag and push
git tag node-vX.Y.Z
git push origin node-vX.Y.Z
```

### Publish Python to PyPI

```bash
# 1. Bump version in python/pyproject.toml
# 2. Commit the change
git add python/pyproject.toml
git commit -m "chore: bump python package to vX.Y.Z"
git push

# 3. Tag and push
git tag py-vX.Y.Z
git push origin py-vX.Y.Z
```

## Publishing via Manual Dispatch

Both workflows support manual triggering from GitHub Actions UI with a **dry run** option:

1. Go to the repo → **Actions** tab
2. Select **Publish to npm** or **Publish to PyPI**
3. Click **Run workflow**
4. Optionally enable **Dry run** to test without actually publishing
   - npm dry run: runs `npm publish --dry-run`
   - PyPI dry run: publishes to **TestPyPI** instead of PyPI

## Required Secrets & Setup

### npm

- Add an npm automation token as `NPM_TOKEN` in GitHub repo → Settings → Secrets and variables → Actions
- Generate at [npmjs.com](https://www.npmjs.com/) → Access Tokens → Automation

### PyPI (Trusted Publishing — no tokens needed)

- Configure a trusted publisher at [pypi.org](https://pypi.org/) → Your project → Publishing
  - Owner: GitHub username/org
  - Repository: `wechatbot`
  - Workflow: `publish-pypi.yml`
  - Environment: `pypi`
- Create GitHub environments `pypi` (and optionally `testpypi`) in repo → Settings → Environments

## Publishing Both at Once

To release both packages simultaneously:

```bash
# Bump both versions, commit, then tag both
git tag node-vX.Y.Z
git tag py-vX.Y.Z
git push origin node-vX.Y.Z py-vX.Y.Z
```

## Troubleshooting

| Issue | Solution |
|-------|----------|
| npm 403 Forbidden | Check `NPM_TOKEN` is valid; ensure the package name isn't taken by another user |
| npm provenance error | Ensure `id-token: write` permission is set (already configured) |
| PyPI auth failure | Verify trusted publisher is configured with correct workflow name and environment |
| TestPyPI upload fails | Create `testpypi` environment in GitHub; configure trusted publisher on test.pypi.org |
| Version conflict | The version already exists on the registry; bump the version number |

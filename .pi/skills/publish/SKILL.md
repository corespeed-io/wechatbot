---
name: publish
description: Publish wechatbot packages to npm and PyPI. Use when the user wants to release, publish, or deploy a new version of the Node.js or Python SDK package.
---

# Publish Packages

This project has two publishable packages with separate GitHub Actions workflows:

| Package | Registry | Directory | Workflow | Tag pattern |
|---------|----------|-----------|----------|-------------|
| `@wechatbot/wechatbot` | npm | `nodejs/` | `.github/workflows/publish-npm.yml` | `node-v*` |
| `@wechatbot/pi-agent` | npm | `pi-agent/` | `.github/workflows/publish-pi-agent.yml` | `pi-agent-v*` |
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

## First-Time Publishing (New Package)

OIDC Trusted Publishing **cannot** be used for the very first publish of a package — the package must already exist on the registry. Follow these steps for initial setup:

### npm — First Publish

1. **Create an npm account** at [npmjs.com](https://www.npmjs.com/) if you don't have one
2. **Login locally**: `npm login`
3. **Publish manually** from the package directory:
   ```bash
   cd nodejs
   npm publish --access public
   ```
4. After the first version is live, configure Trusted Publishing (see below) for all subsequent releases

### PyPI — First Publish

Option A — **Pending trusted publisher** (recommended, no token needed):

1. Go to [pypi.org](https://pypi.org/) → log in → **Publishing** → **Add a pending publisher**
2. Fill in: package name (`wechatbot-sdk`), owner (`corespeed-io`), repo (`wechatbot`), workflow (`publish-pypi.yml`), environment (`pypi`)
3. Trigger the GitHub Actions workflow — PyPI will accept the first publish via OIDC

Option B — Manual publish:

1. Create a PyPI account and generate an API token at [pypi.org](https://pypi.org/) → Account settings → API tokens
2. Publish locally:
   ```bash
   cd python
   python -m build
   twine upload dist/*
   ```
3. After the first version is live, configure Trusted Publishing (see below)

## Configuring Trusted Publishing (OIDC)

Both npm and PyPI use OIDC Trusted Publishing — GitHub Actions exchanges a short-lived OIDC token with the registry, so **no long-lived secrets are needed**.

### npm — Configure Trusted Publisher

1. Go to [npmjs.com](https://www.npmjs.com/) → log in → click your package (`@wechatbot/wechatbot`)
2. **Settings** → **Trusted Publishers** → **Add a trusted publisher**
3. Fill in:
   - Repository owner: `corespeed-io`
   - Repository name: `wechatbot`
   - Workflow filename: `publish-npm.yml`
4. Click **Add**
5. Workflow requirements:
   - `permissions: id-token: write` must be set in the workflow
   - npm >= 11.5.1 (the workflow upgrades automatically since Node 22 ships with ~10.x)
   - Do **NOT** set `NODE_AUTH_TOKEN` env var — it overrides OIDC
   - `package.json` must have a `repository` field matching the GitHub repo

### PyPI — Configure Trusted Publisher

1. Go to [pypi.org](https://pypi.org/) → log in → your project (`wechatbot-sdk`) → **Publishing**
2. **Add a new publisher**:
   - Owner: `corespeed-io`
   - Repository: `wechatbot`
   - Workflow: `publish-pypi.yml`
   - Environment: `pypi`
3. Click **Add**
4. In GitHub repo → **Settings** → **Environments**, create environments `pypi` (and optionally `testpypi`)

## Publishing Both at Once

To release both packages simultaneously:

```bash
# Bump both versions, commit, then tag both
git tag node-vX.Y.Z
git tag py-vX.Y.Z
git push origin node-vX.Y.Z py-vX.Y.Z
```

## Go Module Publishing (Future Reference)

Go modules don't use a central registry with upload — they are published by **pushing a git tag**. The Go module proxy (`proxy.golang.org`) automatically fetches from GitHub.

1. Ensure `go.mod` exists in the module directory with the correct `module` path (e.g. `module github.com/corespeed-io/wechatbot/go`)
2. Bump version by tagging:
   ```bash
   # If the module is in repo root:
   git tag vX.Y.Z

   # If the module is in a subdirectory (e.g. go/):
   git tag go/vX.Y.Z
   ```
3. Push the tag: `git push origin go/vX.Y.Z`
4. The Go proxy picks it up automatically — no CI workflow, no tokens, no Trusted Publishing needed
5. Verify: `go list -m github.com/corespeed-io/wechatbot/go@vX.Y.Z`

> For major versions v2+, the module path must include the major version suffix (e.g. `module github.com/corespeed-io/wechatbot/go/v2`).

## Rust Crate Publishing (Future Reference)

Rust crates are published to [crates.io](https://crates.io/). Unlike npm/PyPI, crates.io does **not** support OIDC Trusted Publishing — a token is required.

### First Publish

1. Create an account at [crates.io](https://crates.io/) (login via GitHub)
2. Generate an API token: crates.io → Account Settings → API Tokens
3. Login locally: `cargo login <token>`
4. Publish:
   ```bash
   cd rust
   cargo publish
   ```

### CI Publishing

1. Add the crates.io API token as `CARGO_REGISTRY_TOKEN` in GitHub repo → Settings → Secrets
2. Example workflow step:
   ```yaml
   - name: Publish to crates.io
     run: cargo publish
     env:
       CARGO_REGISTRY_TOKEN: ${{ secrets.CARGO_REGISTRY_TOKEN }}
   ```

> **Note:** `cargo publish` does a full build and runs tests before uploading. Ensure `Cargo.toml` has `version`, `license`, `description`, and `repository` fields — crates.io requires them.

## Troubleshooting

| Issue | Solution |
|-------|----------|
| npm 403 Forbidden | Verify trusted publisher is configured on npmjs.com with correct repo/workflow |
| npm ENEEDAUTH / 404 | Ensure `NODE_AUTH_TOKEN` is NOT set (it overrides OIDC); ensure npm >= 11.5.1 |
| npm provenance error | Ensure `id-token: write` permission is set and `repository` field exists in `package.json` |
| PyPI auth failure | Verify trusted publisher is configured with correct workflow name and environment |
| TestPyPI upload fails | Create `testpypi` environment in GitHub; configure trusted publisher on test.pypi.org |
| Version conflict | The version already exists on the registry; bump the version number |

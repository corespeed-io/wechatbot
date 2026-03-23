#!/usr/bin/env bash
# WeChatBot Echo Bot — Cross-platform install script
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/corespeed-io/wechatbot/main/install.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/corespeed-io/wechatbot/main/install.sh | bash -s -- --version v0.1.0
#   curl -fsSL https://raw.githubusercontent.com/corespeed-io/wechatbot/main/install.sh | bash -s -- --dir /usr/local/bin

set -euo pipefail

REPO="corespeed-io/wechatbot"
BINARY_NAME="wechatbot-echo-bot"
INSTALL_DIR="${HOME}/.local/bin"
VERSION=""

# ── Parse arguments ──────────────────────────────────────────────────

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version) VERSION="$2"; shift 2 ;;
    --dir)     INSTALL_DIR="$2"; shift 2 ;;
    --help)
      echo "Usage: install.sh [--version vX.Y.Z] [--dir /path/to/bin]"
      exit 0
      ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

# ── Detect platform ─────────────────────────────────────────────────

detect_platform() {
  local os arch

  case "$(uname -s)" in
    Linux*)  os="linux" ;;
    Darwin*) os="darwin" ;;
    MINGW*|MSYS*|CYGWIN*) os="windows" ;;
    *)
      echo "Error: unsupported OS: $(uname -s)"
      exit 1
      ;;
  esac

  case "$(uname -m)" in
    x86_64|amd64)  arch="amd64" ;;
    aarch64|arm64) arch="arm64" ;;
    *)
      echo "Error: unsupported architecture: $(uname -m)"
      exit 1
      ;;
  esac

  echo "${os}-${arch}"
}

# ── Resolve latest version ──────────────────────────────────────────

resolve_version() {
  if [[ -n "$VERSION" ]]; then
    echo "$VERSION"
    return
  fi

  local latest
  latest=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" 2>/dev/null \
    | grep '"tag_name"' | sed -E 's/.*"tag_name": *"([^"]+)".*/\1/')

  if [[ -z "$latest" ]]; then
    echo "Error: could not determine latest version. Use --version to specify." >&2
    exit 1
  fi

  echo "$latest"
}

# ── Main ─────────────────────────────────────────────────────────────

main() {
  local platform version url target_file ext=""

  platform=$(detect_platform)
  version=$(resolve_version)

  echo "📦 Installing ${BINARY_NAME} ${version} for ${platform}..."

  if [[ "$platform" == *windows* ]]; then
    ext=".exe"
  fi

  url="https://github.com/${REPO}/releases/download/${version}/${BINARY_NAME}-${platform}${ext}"

  echo "⬇  Downloading from: ${url}"

  mkdir -p "${INSTALL_DIR}"
  target_file="${INSTALL_DIR}/${BINARY_NAME}${ext}"

  if command -v curl &>/dev/null; then
    curl -fsSL -o "${target_file}" "${url}"
  elif command -v wget &>/dev/null; then
    wget -qO "${target_file}" "${url}"
  else
    echo "Error: curl or wget is required"
    exit 1
  fi

  chmod +x "${target_file}"

  echo ""
  echo "✅ Installed to: ${target_file}"
  echo ""

  # Check if install dir is in PATH
  if ! echo ":$PATH:" | grep -q ":${INSTALL_DIR}:"; then
    echo "⚠  ${INSTALL_DIR} is not in your PATH. Add it:"
    echo ""
    echo "   export PATH=\"${INSTALL_DIR}:\$PATH\""
    echo ""
    echo "   Or add to your shell profile (~/.bashrc, ~/.zshrc, etc.)"
  fi

  echo "🚀 Run: ${BINARY_NAME}"
}

main

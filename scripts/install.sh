#!/usr/bin/env bash
# Install lumen under the user directory. Does not use sudo or write outside HOME.
# macOS and Linux, bash 3.2 or newer.
set -euo pipefail

usage() {
  cat <<'EOF'
usage: scripts/install.sh [--prefix DIR] [--bin-dir DIR] [--path | --no-path] [--rc FILE]
       scripts/install.sh --uninstall [--prefix DIR] [--bin-dir DIR]

Installs lumen into ~/.local/share/lumen (or $XDG_DATA_HOME/lumen when that
directory is under HOME) and links the command at ~/.local/bin/lumen.
An existing install is replaced. Config (~/.config/lumen) and cache
(~/.cache/lumen) are left in place, including on uninstall.

--path     add ~/.local/bin to the shell rc (zsh: ~/.zshrc, bash: ~/.bashrc)
--no-path  do not change a shell rc
           with neither flag, a terminal asks first; otherwise the rc is not changed
EOF
}

ACTION="install"
PATH_ACTION="ask"
SAW_PATH=0
SAW_NO_PATH=0
PREFIX=""
BIN_DIR=""
RC_FILE=""

while [ $# -gt 0 ]; do
  case "$1" in
    --uninstall) ACTION="uninstall"; shift ;;
    --path) PATH_ACTION="write"; SAW_PATH=1; shift ;;
    --no-path) PATH_ACTION="skip"; SAW_NO_PATH=1; shift ;;
    --prefix)
      if [ $# -lt 2 ]; then echo "install: --prefix needs a directory" >&2; exit 2; fi
      PREFIX="$2"
      shift 2
      ;;
    --bin-dir)
      if [ $# -lt 2 ]; then echo "install: --bin-dir needs a directory" >&2; exit 2; fi
      BIN_DIR="$2"
      shift 2
      ;;
    --rc)
      if [ $# -lt 2 ]; then echo "install: --rc needs a file" >&2; exit 2; fi
      RC_FILE="$2"
      shift 2
      ;;
    -h|--help) usage; exit 0 ;;
    *) echo "install: unknown argument $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [ "$SAW_PATH" -eq 1 ] && [ "$SAW_NO_PATH" -eq 1 ]; then
  echo "install: choose one of --path or --no-path" >&2
  exit 2
fi

if [ -z "${HOME:-}" ]; then
  echo "install: HOME is required" >&2
  exit 1
fi

under_home() {
  case "$1" in
    "$HOME"|"$HOME"/*) return 0 ;;
    *) return 1 ;;
  esac
}

need_node() {
  if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
    echo "install: Node.js 20 or newer and npm are required" >&2
    exit 1
  fi
  if ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)'; then
    echo "install: Node.js 20 or newer is required" >&2
    exit 1
  fi
}

resolve_path() {
  node -e 'const path=require("node:path"); process.stdout.write(path.resolve(process.argv[1]))' "$1"
}

need_node

if [ -n "${XDG_DATA_HOME:-}" ]; then
  XDG_DATA_RESOLVED="$(resolve_path "$XDG_DATA_HOME")"
else
  XDG_DATA_RESOLVED=""
fi

if [ -z "$PREFIX" ]; then
  if [ -n "$XDG_DATA_RESOLVED" ] && under_home "$XDG_DATA_RESOLVED"; then
    PREFIX="$XDG_DATA_RESOLVED/lumen"
  else
    if [ -n "$XDG_DATA_RESOLVED" ]; then
      echo "XDG_DATA_HOME is outside HOME; using $HOME/.local/share/lumen"
    fi
    PREFIX="$HOME/.local/share/lumen"
  fi
fi
if [ -z "$BIN_DIR" ]; then
  BIN_DIR="$HOME/.local/bin"
fi

PREFIX="$(resolve_path "$PREFIX")"
BIN_DIR="$(resolve_path "$BIN_DIR")"

for dir in "$PREFIX" "$BIN_DIR"; do
  if ! under_home "$dir"; then
    echo "install: refuses to write outside HOME: $dir" >&2
    exit 1
  fi
done

if [ -n "${XDG_CONFIG_HOME:-}" ]; then
  CONFIG_DIR="$(resolve_path "$XDG_CONFIG_HOME")/lumen"
else
  CONFIG_DIR="$HOME/.config/lumen"
fi
if [ -n "${XDG_CACHE_HOME:-}" ]; then
  CACHE_DIR="$(resolve_path "$XDG_CACHE_HOME")/lumen"
else
  CACHE_DIR="$HOME/.cache/lumen"
fi

SOURCE="$(cd "$(dirname "$0")/.." && pwd)"

if [ "$BIN_DIR" = "$HOME/.local/bin" ]; then
  BIN_EXPORT='$HOME/.local/bin'
else
  BIN_EXPORT="$BIN_DIR"
fi

on_path() {
  case ":${PATH:-}:" in
    *":$BIN_DIR:"*) return 0 ;;
    *) return 1 ;;
  esac
}

rc_file() {
  if [ -n "$RC_FILE" ]; then
    resolve_path "$RC_FILE"
    return
  fi
  case "${SHELL:-}" in
    */zsh) printf '%s' "$HOME/.zshrc" ;;
    */bash) printf '%s' "$HOME/.bashrc" ;;
    *) return 1 ;;
  esac
}

path_hint() {
  echo "PATH does not include $BIN_DIR"
  echo "export PATH=\"$BIN_EXPORT:\$PATH\""
}

write_rc() {
  local rc
  if ! rc="$(rc_file)"; then
    echo "install: pass --rc <file> for this shell" >&2
    exit 1
  fi
  if ! under_home "$rc"; then
    echo "install: refuses to write outside HOME: $rc" >&2
    exit 1
  fi
  mkdir -p "$(dirname "$rc")"
  if [ -f "$rc" ] && grep -F "$BIN_EXPORT" "$rc" >/dev/null 2>&1; then
    echo "PATH entry already in $rc"
    return
  fi
  printf '\n# lumen user bin\nexport PATH="%s:$PATH"\n' "$BIN_EXPORT" >> "$rc"
  echo "added $BIN_DIR to $rc"
}

ensure_path() {
  if on_path; then
    echo "PATH already includes $BIN_DIR"
    return
  fi
  case "$PATH_ACTION" in
    skip) path_hint ;;
    write) write_rc ;;
    ask)
      if [ -t 0 ]; then
        local rc_label reply
        rc_label="$(rc_file 2>/dev/null || true)"
        if [ -z "$rc_label" ]; then
          path_hint
          echo "pass --rc <file> --path to choose a shell rc"
          return
        fi
        printf 'Add %s to PATH in %s? [y/N] ' "$BIN_DIR" "$rc_label"
        read -r reply
        case "$reply" in
          y|Y|yes|YES) write_rc ;;
          *) echo "left PATH unchanged"; path_hint ;;
        esac
      else
        path_hint
        echo "re-run with --path to update the shell rc"
      fi
      ;;
  esac
}

install_tree() {
  if [ ! -f "$SOURCE/dist/cli.js" ] || { [ -f "$SOURCE/src/cli.ts" ] && [ "$SOURCE/src/cli.ts" -nt "$SOURCE/dist/cli.js" ]; }; then
    echo "building $SOURCE"
    (
      cd "$SOURCE"
      if [ ! -f node_modules/typescript/package.json ]; then
        env -u npm_config_prefix -u NPM_CONFIG_PREFIX npm install --no-audit --no-fund
      fi
      npm run build
    )
  fi
  rm -rf "$PREFIX"
  mkdir -p "$PREFIX" "$BIN_DIR"
  cp "$SOURCE/package.json" "$SOURCE/package-lock.json" "$SOURCE/LICENSE" "$SOURCE/README.md" "$PREFIX/"
  cp -R "$SOURCE/dist" "$SOURCE/schemas" "$SOURCE/skills" "$SOURCE/scripts" "$PREFIX/"
  chmod +x "$PREFIX/dist/cli.js"
  (
    cd "$PREFIX"
    env -u npm_config_prefix -u NPM_CONFIG_PREFIX -u npm_config_global -u NPM_CONFIG_GLOBAL \
      npm ci --prefix "$PREFIX" --omit=dev --ignore-scripts --no-audit --no-fund
  )
  ln -sfn "$PREFIX/dist/cli.js" "$BIN_DIR/lumen"
  echo "installed $PREFIX"
  echo "command $BIN_DIR/lumen"
  echo "config dir $CONFIG_DIR"
  echo "cache dir $CACHE_DIR"
  ensure_path
}

uninstall_tree() {
  local bin="$BIN_DIR/lumen"
  if [ -L "$bin" ] && [ "$(readlink "$bin")" = "$PREFIX/dist/cli.js" ]; then
    rm -f "$bin"
    echo "removed $bin"
  elif [ -e "$bin" ] || [ -L "$bin" ]; then
    echo "left $bin in place"
  fi
  if [ -d "$PREFIX" ]; then
    rm -rf "$PREFIX"
    echo "uninstalled $PREFIX"
  else
    echo "nothing to uninstall at $PREFIX"
  fi
  echo "left config and cache in place"
}

if [ "$ACTION" = "uninstall" ]; then
  uninstall_tree
else
  install_tree
fi

#!/bin/sh
# crew installer — downloads the latest release binary for this machine.
#   curl -fsSL https://raw.githubusercontent.com/pinkynrg/crew/main/install.sh | sh
# Installs to /usr/local/bin (falls back to ~/.local/bin without write access).
set -eu

REPO="pinkynrg/crew"
OS=$(uname -s | tr '[:upper:]' '[:lower:]')   # darwin | linux
ARCH=$(uname -m)
case "$ARCH" in
  x86_64) ARCH=amd64 ;;
  aarch64 | arm64) ARCH=arm64 ;;
  *) echo "crew: unsupported architecture: $ARCH" >&2; exit 1 ;;
esac
case "$OS" in darwin | linux) ;; *) echo "crew: unsupported OS: $OS (POSIX only)" >&2; exit 1 ;; esac

API="https://api.github.com/repos/$REPO/releases/latest"
URL=$(curl -fsSL "$API" | grep -o "\"browser_download_url\": *\"[^\"]*_${OS}_${ARCH}\.tar\.gz\"" | head -1 | sed 's/.*"\(https[^"]*\)"/\1/')
[ -n "$URL" ] || { echo "crew: no release asset for ${OS}/${ARCH}" >&2; exit 1; }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
curl -fsSL "$URL" | tar -xz -C "$TMP" crew

DEST=/usr/local/bin
[ -w "$DEST" ] || { DEST="$HOME/.local/bin"; mkdir -p "$DEST"; }
install -m 0755 "$TMP/crew" "$DEST/crew"
echo "crew installed to $DEST/crew ($("$DEST/crew" --version))"
case ":$PATH:" in *":$DEST:"*) ;; *) echo "note: add $DEST to your PATH" ;; esac

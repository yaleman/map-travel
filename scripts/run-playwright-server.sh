#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/map-travel-playwright.XXXXXX")
SERVER_PID=""

cleanup() {
	if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
		kill "$SERVER_PID" 2>/dev/null || true
		wait "$SERVER_PID" 2>/dev/null || true
	fi
	rm -rf "$TMP_DIR"
}

trap cleanup EXIT INT TERM

cd "$REPO_ROOT"
pnpm --dir frontend build >/dev/null

cargo run -- \
	--listen-addr 127.0.0.1:9010 \
	--database-url "sqlite:$TMP_DIR/map-travel.sqlite?mode=rwc" \
	--managed-maps-dir "$TMP_DIR/maps" &
SERVER_PID=$!

wait "$SERVER_PID"

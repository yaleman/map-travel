#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH='' && cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH='' && cd -- "$SCRIPT_DIR/.." && pwd)
COMPOSE_PROJECT_NAME="map-travel-playwright-$$"
export COMPOSE_PROJECT_NAME
export MAP_TRAVEL_PORT=9010

cleanup() {
	docker compose down --volumes --remove-orphans >/dev/null 2>&1 || true
}

trap cleanup EXIT INT TERM

cd "$REPO_ROOT"
docker compose up --build app

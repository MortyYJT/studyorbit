#!/usr/bin/env bash
# Use the same verification command locally and in CI.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
exec npm run check

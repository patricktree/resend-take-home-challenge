#!/bin/sh
set -e

cd "$(dirname "$0")"

if [ ! -d .patricktree-stack ] || [ -z "$(ls -A .patricktree-stack)" ]; then
    echo "The .patricktree-stack submodule is missing or empty." >&2
    if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
        # pnpm has already scanned the workspace without the submodule's packages, so this run cannot continue
        git submodule update --init --recursive
        echo "Initialized the submodule. Retry pnpm install." >&2
    else
        echo "Run git submodule update --init --recursive, then retry pnpm install." >&2
    fi
    exit 1
fi

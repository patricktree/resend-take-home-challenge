#!/bin/sh
set -e

cd "$(dirname "$0")"

# Worker types are not committed; generate them so typechecking, lint, and tests work before a build
pnpm run cf-typegen

#!/usr/bin/env bash

set -euo pipefail

npm run gen:types
git diff --exit-code -- src/types/generated.d.ts

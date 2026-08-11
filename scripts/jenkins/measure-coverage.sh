#!/usr/bin/env bash

set -euo pipefail

# The 100% target is intentionally a shadow signal during migration. The
# Jenkinsfile records a failed threshold as an unstable stage without failing
# the authoritative CI status.
npm exec -- vitest run --coverage --coverage.thresholds.100=true

#!/usr/bin/env bash

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VERIFY="${ROOT}/scripts/jenkins/verify-git-context.sh"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT

fail() {
    printf 'FAIL: %s\n' "$*" >&2
    exit 1
}

expect_failure() {
    if "$@" >/dev/null 2>&1; then
        fail "command unexpectedly succeeded: $*"
    fi
}

git init -q "${TMP_DIR}/repo"
cd "${TMP_DIR}/repo"
git config user.name 'Jenkins Tests'
git config user.email 'jenkins-tests@example.invalid'

printf '{"name":"fixture","version":"1.2.3"}\n' > package.json
git add package.json
git commit -qm 'initial'
git branch -M main
base_sha="$(git rev-parse HEAD)"

git switch -qc feature
printf 'feature\n' > feature.txt
git add feature.txt
git commit -qm 'feature'
head_sha="$(git rev-parse HEAD)"

git switch -q main
git merge -q --no-ff --no-edit feature
merge_sha="$(git rev-parse HEAD)"
git update-ref refs/remotes/origin/main "${base_sha}"
git update-ref refs/remotes/origin/pull/7/merge "${merge_sha}"

bash "${VERIFY}" pr refs/remotes/origin/pull/7/merge "${head_sha}" refs/remotes/origin/main
expect_failure bash "${VERIFY}" pr refs/remotes/origin/pull/7/merge "${base_sha}" refs/remotes/origin/main

git switch -q --detach "${head_sha}"
expect_failure bash "${VERIFY}" pr refs/remotes/origin/pull/7/merge "${head_sha}" refs/remotes/origin/main

git update-ref refs/remotes/origin/pull/7/merge "${head_sha}"
expect_failure bash "${VERIFY}" pr refs/remotes/origin/pull/7/merge "${head_sha}" refs/remotes/origin/main

git update-ref refs/remotes/origin/main "${base_sha}"
git switch -q --detach "${base_sha}"
bash "${VERIFY}" main refs/remotes/origin/main "${base_sha}"
expect_failure bash "${VERIFY}" main refs/remotes/origin/main "${head_sha}"

git update-ref refs/remotes/origin/main "${head_sha}"
expect_failure bash "${VERIFY}" main refs/remotes/origin/main "${head_sha}"
expect_failure bash "${VERIFY}" unexpected refs/remotes/origin/main "${head_sha}"

printf 'Git context behavior tests passed.\n'

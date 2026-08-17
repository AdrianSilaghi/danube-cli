#!/usr/bin/env bash

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VERIFY="${ROOT}/scripts/jenkins/verify-release-context.sh"
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

printf '{"name":"@danubedata/cli","version":"1.2.3"}\n' > package.json
git add package.json
git commit -qm 'release 1.2.3'
git branch -M main
release_sha="$(git rev-parse HEAD)"
git tag -a v1.2.3 -m v1.2.3
annotated_tag_sha="$(git rev-parse refs/tags/v1.2.3)"
git tag v1.2.4
git update-ref refs/remotes/origin/main "${release_sha}"
git switch -q --detach "${release_sha}"

bash "${VERIFY}" v1.2.3 "${annotated_tag_sha}" refs/remotes/origin/main package.json
bash "${VERIFY}" v1.2.3 "${release_sha}" refs/remotes/origin/main package.json
expect_failure bash "${VERIFY}" v1.2.4 "${release_sha}" refs/remotes/origin/main package.json
expect_failure bash "${VERIFY}" v1.2.3 0000000000000000000000000000000000000000 refs/remotes/origin/main package.json
expect_failure bash "${VERIFY}" v1.2 refs/remotes/origin/main package.json
expect_failure bash "${VERIFY}" v01.2.3 "${release_sha}" refs/remotes/origin/main package.json
expect_failure bash "${VERIFY}" v1.2.3-01 "${release_sha}" refs/remotes/origin/main package.json

printf '{"name":"@wrong/cli","version":"1.2.3"}\n' > package.json
expect_failure bash "${VERIFY}" v1.2.3 "${release_sha}" refs/remotes/origin/main package.json
git restore package.json

git switch -q --orphan outside-main
printf '{"name":"@danubedata/cli","version":"9.9.9"}\n' > package.json
git add package.json
git commit -qm 'untrusted release'
outside_sha="$(git rev-parse HEAD)"
git tag -a v9.9.9 -m v9.9.9
git switch -q --detach "${outside_sha}"
expect_failure bash "${VERIFY}" v9.9.9 "${outside_sha}" refs/remotes/origin/main package.json

printf 'Release context behavior tests passed.\n'

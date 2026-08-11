#!/usr/bin/env bash

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${ROOT}"

fail() {
    printf 'FAIL: %s\n' "$*" >&2
    exit 1
}

assert_contains() {
    local file="$1"
    local pattern="$2"
    grep -Eq -- "${pattern}" "${file}" || fail "${file} is missing /${pattern}/"
}

assert_not_contains() {
    local file="$1"
    local pattern="$2"
    if grep -Eq -- "${pattern}" "${file}"; then
        fail "${file} unexpectedly contains /${pattern}/"
    fi
}

assert_count() {
    local expected="$1"
    local file="$2"
    local pattern="$3"
    local actual
    actual="$(grep -Ec -- "${pattern}" "${file}" || true)"
    [ "${actual}" -eq "${expected}" ] || \
        fail "${file} contains ${actual}, expected ${expected}, matches for /${pattern}/"
}

assert_before() {
    local file="$1"
    local first_pattern="$2"
    local second_pattern="$3"
    local first_line second_line
    first_line="$(grep -nE -- "${first_pattern}" "${file}" | head -1 | cut -d: -f1 || true)"
    second_line="$(grep -nE -- "${second_pattern}" "${file}" | head -1 | cut -d: -f1 || true)"
    [ -n "${first_line}" ] && [ -n "${second_line}" ] && [ "${first_line}" -lt "${second_line}" ] || \
        fail "${file} does not place /${first_pattern}/ before /${second_pattern}/"
}

for file in \
    .github/CODEOWNERS \
    ci/jenkins/Jenkinsfile.build \
    ci/jenkins/Jenkinsfile.release \
    ci/jenkins/README.md \
    scripts/jenkins/verify-git-context.sh \
    scripts/jenkins/verify-release-context.sh \
    scripts/jenkins/run-tests-and-pack.sh \
    scripts/jenkins/measure-coverage.sh \
    scripts/jenkins/check-types-drift.sh; do
    [ -f "${file}" ] || fail "missing ${file}"
done

for script in scripts/jenkins/*.sh tests/jenkins/*.sh; do
    bash -n "${script}"
done

CI=ci/jenkins/Jenkinsfile.build
RELEASE=ci/jenkins/Jenkinsfile.release

assert_contains "${CI}" 'agent.*host-build'
assert_contains "${CI}" 'skipDefaultCheckout\(true\)'
assert_contains "${CI}" "JOB_NAME == 'danube-cli-pr/build'"
assert_contains "${CI}" "JOB_NAME == 'danube-cli-build/main'"
assert_contains "${CI}" "HEAD_REPOSITORY.*AdrianSilaghi/danube-cli"
assert_contains "${CI}" "SOURCE_REPOSITORY.*AdrianSilaghi/danube-cli"
assert_contains "${CI}" 'AUTHOR_ASSOCIATION'
assert_contains "${CI}" "OWNER.*MEMBER.*COLLABORATOR"
assert_contains "${CI}" "CHANGE_TARGET.*main"
assert_contains "${CI}" 'sourceRef = "refs/pull/\$\{changeId\}/merge"'
assert_contains "${CI}" 'refs/pull/.*merge'
assert_not_contains "${CI}" 'refs/pull/.*head|refs/pull/\*'
assert_contains "${CI}" 'git show -s --format=%P HEAD'
assert_contains "${CI}" 'mergeParents.size\(\) != 2'
assert_contains "${CI}" 'headParent.equalsIgnoreCase\(env.EXPECTED_PR_HEAD_SHA\)'
assert_contains "${CI}" 'git merge-base --is-ancestor.*baseParent.*VERIFIED_BASE_REF'
assert_contains "${CI}" 'checkedOutSha.equalsIgnoreCase\(fetchedRefSha\)'
assert_contains "${CI}" 'fetchedRefSha.equalsIgnoreCase\(env.EXPECTED_SOURCE_SHA\)'
assert_contains "${CI}" 'https://github.com/AdrianSilaghi/danube-cli\.git'
assert_contains "${CI}" "node:22[^[:space:]\"']*@sha256:[0-9a-f]{64}"
assert_contains "${CI}" "'ci/jenkins/pr'"
assert_contains "${CI}" "'ci/jenkins/pr-head'"
assert_contains "${CI}" "'ci/jenkins/main'"
assert_contains "${CI}" 'GITHUB_STATUS_SHA = checkedOutSha'
assert_contains "${CI}" 'GITHUB_STATUS_HEAD_SHA.*EXPECTED_PR_HEAD_SHA'
assert_not_contains "${CI}" 'GitHubCommitStatusSetter|ManuallyEnteredRepositorySource|ManuallyEnteredShaSource|ManuallyEnteredCommitContextSource|ManuallyEnteredBackrefSource'
assert_contains "${CI}" 'credentialsId: .danube-cli-github-status-token.'
assert_count 1 "${CI}" 'withCredentials\('
assert_count 1 "${CI}" 'danube-cli-github-status-token'
assert_count 2 "${CI}" 'GITHUB_STATUS_TOKEN'
assert_contains "${CI}" '/usr/bin/curl'
assert_contains "${CI}" '/usr/bin/curl --disable --config -'
assert_not_contains "${CI}" '(^|[[:space:]])curl([[:space:]]|$)|(^|[[:space:]])jq([[:space:]]|$)'
assert_not_contains "${CI}" '--header.*GITHUB_STATUS_TOKEN'
assert_contains "${CI}" 'api\.github\.com/repos/AdrianSilaghi/danube-cli/statuses/'
assert_contains "${CI}" 'Authorization: Bearer %s'
assert_contains "${CI}" '--fail-with-body'
assert_contains "${CI}" 'https://jenkins.*ifasconsult.*ro/job/danube-cli-pr/job/build/\[1-9\]\[0-9\]\*/'
assert_contains "${CI}" 'https://jenkins.*ifasconsult.*ro/job/danube-cli-build/job/main/\[1-9\]\[0-9\]\*/'
assert_contains "${CI}" 'buildUrl ==~ buildUrlPattern'
assert_before "${CI}" 'targetSha ==~ /\[0-9a-fA-F\]\{40\}/' 'withCredentials\('
assert_before "${CI}" 'buildUrl ==~ buildUrlPattern' 'withCredentials\('
assert_before "${CI}" 'set \+x' '/usr/bin/curl'
assert_before "${CI}" 'set \+x' 'set -eu'
assert_before "${CI}" 'set -eu' '/usr/bin/curl'
assert_before "${CI}" '^[[:space:]]+env.GITHUB_STATUS_HEAD_SHA,$' \
    '^[[:space:]]+env.GITHUB_STATUS_SHA,$'
publisher_section="$(awk '
    /^void publishGitHubCommitStatusForSha/ { capture=1 }
    /^void publishGitHubCommitStatus\(/ { exit }
    capture { print }
' "${CI}")"
if printf '%s\n' "${publisher_section}" | grep -Eq 'WORKSPACE|writeFile|readFile|scripts/jenkins|/tmp/'; then
    fail 'GitHub status credential scope depends on workspace-controlled files or executables'
fi
assert_contains "${CI}" 'run-tests-and-pack\.sh'
assert_contains "${CI}" 'measure-coverage\.sh'
assert_contains "${CI}" 'check-types-drift\.sh'
assert_contains "${CI}" "catchError\(buildResult: 'SUCCESS', stageResult: 'UNSTABLE'\)"
assert_contains "${CI}" '^[[:space:]]{8}cleanup \{'
assert_before "${CI}" \
    '^[[:space:]]{12}deleteDir\(\)$' \
    '^[[:space:]]{20}String buildResult = currentBuild\.currentResult$'

assert_contains "${RELEASE}" 'agent.*host-build'
assert_contains "${RELEASE}" 'skipDefaultCheckout\(true\)'
assert_contains "${RELEASE}" "JOB_NAME.*danube-cli-release/npm"
assert_contains "${RELEASE}" 'refs/tags/'
assert_contains "${RELEASE}" 'git merge-base --is-ancestor'
assert_contains "${RELEASE}" 'packageVersion'
assert_contains "${RELEASE}" 'run-tests-and-pack\.sh'
assert_contains "${RELEASE}" 'PUBLISH_TO_NPM.*false'
assert_contains "${RELEASE}" 'Publishing is disabled during the Jenkins migration'
assert_not_contains "${RELEASE}" 'npm publish|withCredentials|danube-cli-npm-publish-token'
assert_contains "${RELEASE}" "node:22[^[:space:]\"']*@sha256:[0-9a-f]{64}"

assert_contains scripts/jenkins/verify-git-context.sh 'git show -s --format=%P'
assert_contains scripts/jenkins/verify-git-context.sh 'git merge-base --is-ancestor'
assert_contains scripts/jenkins/verify-git-context.sh 'refs/remotes/origin/main'
assert_contains scripts/jenkins/verify-release-context.sh 'package\.json'
assert_contains scripts/jenkins/verify-release-context.sh 'git merge-base --is-ancestor'
assert_contains scripts/jenkins/run-tests-and-pack.sh 'npm ci'
assert_contains scripts/jenkins/run-tests-and-pack.sh 'npm run build'
assert_contains scripts/jenkins/run-tests-and-pack.sh 'npm test'
assert_contains scripts/jenkins/run-tests-and-pack.sh 'npm pack --json'
assert_contains scripts/jenkins/run-tests-and-pack.sh 'bin/danube'
assert_contains scripts/jenkins/run-tests-and-pack.sh 'dist/index\.js'
assert_contains scripts/jenkins/measure-coverage.sh 'coverage\.thresholds\.100'
assert_contains scripts/jenkins/check-types-drift.sh 'npm run gen:types'
assert_contains scripts/jenkins/check-types-drift.sh 'git diff --exit-code.*src/types/generated\.d\.ts'

assert_contains ci/jenkins/README.md 'danube-cli-pr/build'
assert_contains ci/jenkins/README.md 'danube-cli-build/main'
assert_contains ci/jenkins/README.md 'danube-cli-release/npm'
assert_contains ci/jenkins/README.md 'protected.*main'
assert_contains ci/jenkins/README.md 'same-repository'
assert_contains ci/jenkins/README.md 'ci/jenkins/pr-head.*never.*required'
assert_contains ci/jenkins/README.md 'dry run'
assert_contains ci/jenkins/README.md 'danube-cli-npm-publish-token'
assert_contains .github/CODEOWNERS '^/ci/jenkins/[[:space:]]+@AdrianSilaghi$'
assert_contains .github/CODEOWNERS '^/scripts/jenkins/[[:space:]]+@AdrianSilaghi$'
assert_contains .github/CODEOWNERS '^/tests/jenkins/[[:space:]]+@AdrianSilaghi$'
assert_contains .github/CODEOWNERS '^/\.github/CODEOWNERS[[:space:]]+@AdrianSilaghi$'
assert_contains ci/jenkins/README.md 'Do not enable.*Jenkins jobs.*until'
assert_contains ci/jenkins/README.md 'main.*direct pushes'
assert_contains ci/jenkins/README.md 'force pushes'
assert_contains ci/jenkins/README.md 'bypass'
assert_contains ci/jenkins/README.md 'require.*ci/jenkins/pr'
assert_contains ci/jenkins/README.md 'CODEOWNER review'

printf 'Jenkins pipeline contract validation passed.\n'

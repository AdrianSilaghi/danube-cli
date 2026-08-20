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
    tests/jenkins/npm-publish-policy.test.sh \
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
assert_contains "${CI}" "'ci/jenkins/pr-merge'"
assert_not_contains "${CI}" "'ci/jenkins/pr-head'"
assert_contains "${CI}" "'ci/jenkins/main'"
assert_contains "${CI}" "GITHUB_STATUS_SHA = env.IS_PULL_REQUEST == 'true' \? env.EXPECTED_PR_HEAD_SHA : checkedOutSha"
assert_contains "${CI}" "GITHUB_STATUS_MERGE_SHA = env.IS_PULL_REQUEST == 'true' \? checkedOutSha : ''"
assert_not_contains "${CI}" 'GitHubCommitStatusSetter|ManuallyEnteredRepositorySource|ManuallyEnteredShaSource|ManuallyEnteredCommitContextSource|ManuallyEnteredBackrefSource'
assert_contains "${CI}" 'credentialsId: .danube-cli-github-status-token.'
assert_count 1 "${CI}" 'withCredentials\('
assert_count 1 "${CI}" 'danube-cli-github-status-token'
assert_count 3 "${CI}" 'GITHUB_STATUS_TOKEN'
assert_contains "${CI}" '/usr/bin/curl'
assert_contains "${CI}" '/usr/bin/curl --disable --config -'
assert_contains "${CI}" '/usr/bin/jq -cn'
assert_not_contains "${CI}" '(^|[[:space:]])curl([[:space:]]|$)|(^|[[:space:]])jq([[:space:]]|$)'
assert_not_contains "${CI}" '--header.*GITHUB_STATUS_TOKEN'
assert_contains "${CI}" 'api\.github\.com/repos/AdrianSilaghi/danube-cli/statuses/'
assert_contains "${CI}" 'Authorization: Bearer %s'
assert_contains "${CI}" '--fail-with-body'
assert_contains "${CI}" 'payload="\$\(/usr/bin/jq -cn'
# This is a literal contract for the trusted Jenkins shell block.
# shellcheck disable=SC2016
assert_contains "${CI}" '--data-binary "\$payload"'
assert_not_contains "${CI}" 'exec[[:space:]]+3<<<|/dev/fd/3'
assert_contains "${CI}" 'https://jenkins.*ifasconsult.*ro/job/danube-cli-pr/job/build/\[1-9\]\[0-9\]\*/'
assert_contains "${CI}" 'https://jenkins.*ifasconsult.*ro/job/danube-cli-build/job/main/\[1-9\]\[0-9\]\*/'
assert_contains "${CI}" 'buildUrl ==~ buildUrlPattern'
assert_before "${CI}" 'targetSha ==~ /\[0-9a-fA-F\]\{40\}/' 'withCredentials\('
assert_before "${CI}" 'buildUrl ==~ buildUrlPattern' 'withCredentials\('
assert_before "${CI}" 'set \+x' '/usr/bin/curl'
assert_before "${CI}" 'set \+x' 'set -eu'
assert_before "${CI}" 'set -eu' '/usr/bin/curl'
assert_contains "${CI}" "env.GITHUB_STATUS_MERGE_SHA,[[:space:]]*'ci/jenkins/pr-merge'"
assert_contains "${CI}" "env.GITHUB_STATUS_SHA,[[:space:]]*'ci/jenkins/pr'"
assert_before "${CI}" "env.GITHUB_STATUS_MERGE_SHA,[[:space:]]*'ci/jenkins/pr-merge'" \
    "env.GITHUB_STATUS_SHA,[[:space:]]*'ci/jenkins/pr'"
assert_contains "${CI}" 'GITHUB_STATUS_MERGE_SHA\.equalsIgnoreCase\(env.GITHUB_STATUS_SHA\)'
assert_contains "${CI}" "env.GITHUB_STATUS_MERGE_SHA,[[:space:]]*'ci/jenkins/pr-merge',[[:space:]]*'FAILURE'"
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
assert_contains "${RELEASE}" "git rev-parse.*VERIFIED_TAG_REF"
assert_contains "${RELEASE}" "git rev-parse.*VERIFIED_TAG_REF.*\^\{commit\}"
assert_contains "${RELEASE}" 'sourceShaMatchesTagRef.*sourceShaMatchesTagCommit'
assert_contains "${RELEASE}" 'checkedOutSha.equalsIgnoreCase\(tagCommitSha\)'
assert_contains "${RELEASE}" 'packageVersion'
assert_contains "${RELEASE}" "<<'TEST_SCRIPT'"
assert_contains "${RELEASE}" '/usr/local/bin/npm ci'
assert_contains "${RELEASE}" '/usr/local/bin/npm run build'
assert_contains "${RELEASE}" '/usr/local/bin/npm test'
assert_not_contains "${RELEASE}" 'scripts/jenkins/run-tests-and-pack\.sh'
assert_contains "${RELEASE}" 'PUBLISH_TO_NPM.*false'
assert_contains "${RELEASE}" "credentialsId: 'danube-cli-npm-publish-token'"
assert_contains "${RELEASE}" 'withCredentials\(\[string\('
assert_contains "${RELEASE}" 'expression \{ !params\.PUBLISH_TO_NPM \}'
assert_contains "${RELEASE}" 'expression \{ params\.PUBLISH_TO_NPM \}'
assert_before "${RELEASE}" 'git merge-base --is-ancestor' 'withCredentials'
assert_before "${RELEASE}" "<<'TEST_SCRIPT'" 'withCredentials'
assert_contains "${RELEASE}" 'disableConcurrentBuilds\(\)'
assert_not_contains "${RELEASE}" "<<'PACKAGE_SCRIPT'"
assert_contains "${RELEASE}" '/usr/local/bin/npm pack --json --ignore-scripts'
assert_contains "${RELEASE}" 'Created exact tested npm release package'
assert_contains "${RELEASE}" "git grep -Eq 'npm\[\[:space:\]\]\+publish'"
assert_contains "${RELEASE}" 'GitHub Actions npm publication is still active on protected main'
assert_before "${RELEASE}" 'GitHub Actions npm publication is still active' 'withCredentials'
assert_contains "${RELEASE}" "archiveArtifacts artifacts: 'danube-cli-release\.tgz', fingerprint: true"
# This is a literal contract for the trusted Jenkins shell block.
# shellcheck disable=SC2016
assert_contains "${RELEASE}" '--volume "\$WORKSPACE:/workspace:ro"'
assert_contains "${RELEASE}" '/usr/local/bin/npm publish'
assert_contains "${RELEASE}" '--access public'
assert_contains "${RELEASE}" '--ignore-scripts'
assert_contains "${RELEASE}" '/usr/local/bin/npm view'
assert_contains "${RELEASE}" 'dist\.integrity'
assert_contains "${RELEASE}" 'local_integrity'
assert_contains "${RELEASE}" 'remote_integrity'
assert_contains "${RELEASE}" 'NPM_RELEASE_STATE'
assert_contains "${RELEASE}" 'NPM_RELEASE_INTEGRITY'
assert_before "${RELEASE}" 'Credential-free npm registry preflight' 'withCredentials'
assert_before "${RELEASE}" 'Tested tarball identity does not match' 'withCredentials'
preflight_stage="$(awk '
    /stage\(.Credential-free npm registry preflight.\)/ { capture=1 }
    capture { print }
    capture && /stage\(.Exact npm package already published.\)/ { exit }
' "${RELEASE}")"
if printf '%s\n' "${preflight_stage}" | grep -Eq '^[[:space:]]*when[[:space:]]*\{'; then
    fail 'credential-free npm registry preflight must run in dry-run and publish modes'
fi
test "$(printf '%s\n' "${preflight_stage}" | grep -Ec '^[[:space:]]+steps[[:space:]]*\{')" -eq 1 ||
    fail 'credential-free npm registry preflight must contain exactly one steps block'
assert_contains "${RELEASE}" 'Unable to establish whether the npm version already exists'
assert_contains "${RELEASE}" 'return 44'
assert_contains "${RELEASE}" 'NPM_CONFIG_USERCONFIG'
assert_contains "${RELEASE}" '_authToken=%s.*NPM_TOKEN'
assert_contains "${RELEASE}" 'trap cleanup EXIT HUP INT TERM'
assert_contains "${RELEASE}" 'set \+x'
assert_not_contains "${RELEASE}" '--env NPM_TOKEN'
assert_contains "${RELEASE}" 'npm_token="\$\{NPM_TOKEN\}"'
assert_contains "${RELEASE}" 'unset NPM_TOKEN'
assert_contains "${RELEASE}" "printf '%s\\\\n'.*npm_token"
assert_contains "${RELEASE}" 'unset npm_token'
assert_contains "${RELEASE}" 'IFS= read -r NPM_TOKEN; source /dev/stdin'
assert_not_contains "${RELEASE}" 'NODE_AUTH_TOKEN|npm config set'
credential_block="$(awk '
    /withCredentials\(\[string\(/ { capture=1 }
    capture { print }
    capture && /^[[:space:]]{16}}$/ { exit }
' "${RELEASE}")"
if printf '%s\n' "${credential_block}" | grep -Eq 'scripts/jenkins|bash[[:space:]]+[^[:space:]]+\.sh'; then
    fail 'npm credential scope executes a workspace-controlled script'
fi
publish_script="$(awk '
    /cat <<.PUBLISH_SCRIPT./ { capture=1; next }
    /^PUBLISH_SCRIPT$/ { exit }
    capture { print }
' "${RELEASE}")"
[ -n "${publish_script}" ] || fail 'trusted npm publish script is missing'
if printf '%s\n' "${publish_script}" | grep -Eq 'scripts/jenkins|WORKSPACE'; then
    fail 'trusted npm publish script depends on workspace-controlled executables'
fi
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
assert_contains ci/jenkins/README.md 'ci/jenkins/pr-merge'
assert_contains ci/jenkins/README.md 'Never require .*ci/jenkins/pr-merge'
assert_contains ci/jenkins/README.md 'strict.*up.to.date|up.to.date.*strict'
assert_contains ci/jenkins/README.md 'dry run'
assert_contains ci/jenkins/README.md 'danube-cli-npm-publish-token'
assert_contains ci/jenkins/README.md 'single publisher|single-publisher'
assert_contains .github/CODEOWNERS '^/ci/jenkins/[[:space:]]+@AdrianSilaghi$'
assert_contains .github/CODEOWNERS '^/scripts/jenkins/[[:space:]]+@AdrianSilaghi$'
assert_contains .github/CODEOWNERS '^/tests/jenkins/[[:space:]]+@AdrianSilaghi$'
assert_contains .github/CODEOWNERS '^/\.github/CODEOWNERS[[:space:]]+@AdrianSilaghi$'
assert_contains ci/jenkins/README.md 'Do not enable.*Jenkins jobs.*until'

# GitHub Actions retains tag publication only after Jenkins owns PR/main CI.
[ -f .github/workflows/ci.yml ] || fail 'tag-release Actions workflow must remain until Jenkins npm publication is proven'
assert_contains .github/workflows/ci.yml "tags:.*'v\*'"
assert_contains .github/workflows/ci.yml "startsWith\(github.ref, 'refs/tags/v'\)"
assert_contains .github/workflows/ci.yml 'npm publish --access public'
assert_contains .github/workflows/ci.yml 'NPM_TOKEN'
assert_not_contains .github/workflows/ci.yml 'pull_request|branches: \[main, master\]|types-drift:'
assert_contains ci/jenkins/README.md 'main.*direct pushes'
assert_contains ci/jenkins/README.md 'force pushes'
assert_contains ci/jenkins/README.md 'bypass'
assert_contains ci/jenkins/README.md 'require.*ci/jenkins/pr'
assert_contains ci/jenkins/README.md 'CODEOWNER review'

printf 'Jenkins pipeline contract validation passed.\n'

#!/usr/bin/env bash

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RELEASE="${ROOT}/ci/jenkins/Jenkinsfile.release"
NODE_IMAGE='node:22-bookworm@sha256:0557ac14e0d45d02ed563067b82856ca5e7aa3437fa28d98d4350ea9c3d9494a'
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT

fail() {
    printf 'FAIL: %s\n' "$*" >&2
    exit 1
}

awk '
    /cat <<.PUBLISH_SCRIPT./ { capture=1; next }
    /^PUBLISH_SCRIPT$/ { exit }
    capture { print }
' "${RELEASE}" >"${TMP_DIR}/publish.sh"
[ -s "${TMP_DIR}/publish.sh" ] || fail 'could not extract trusted publish script'

awk '
    /credentialsId: .danube-cli-npm-publish-token./ { armed=1 }
    armed && /^[[:space:]]+sh .{3}$/ { capture=1; next }
    capture && /^[[:space:]]{20}.{3}$/ { exit }
    capture { sub(/^[[:space:]]{24}/, ""); print }
' "${RELEASE}" >"${TMP_DIR}/credential-wrapper.sh"
[ -s "${TMP_DIR}/credential-wrapper.sh" ] || fail 'could not extract credential wrapper'

mkdir -p "${TMP_DIR}/workspace/package" "${TMP_DIR}/test"
printf '{"name":"@danubedata/cli","version":"9.8.7"}\n' \
    >"${TMP_DIR}/workspace/package/package.json"
COPYFILE_DISABLE=1 tar -czf "${TMP_DIR}/workspace/danube-cli-release.tgz" \
    -C "${TMP_DIR}/workspace" package

cat >"${TMP_DIR}/fake-npm" <<'FAKE_NPM'
#!/usr/bin/env bash
set -euo pipefail

printf '%s\n' "$*" >>/test/calls
[ -f "${NPM_CONFIG_USERCONFIG:?}" ]
[ "$(stat -c '%a' "${NPM_CONFIG_USERCONFIG}")" = 600 ]
grep -Fxq '//registry.npmjs.org/:_authToken=test-token' "${NPM_CONFIG_USERCONFIG}"

integrity() {
    /usr/local/bin/node -e '
        const fs = require("node:fs")
        const crypto = require("node:crypto")
        const value = crypto.createHash("sha512")
            .update(fs.readFileSync("/workspace/danube-cli-release.tgz"))
            .digest("base64")
        process.stdout.write(JSON.stringify(`sha512-${value}`))
    '
}

case "$1:${FAKE_NPM_MODE:?}" in
    view:identical)
        integrity
        ;;
    view:conflict)
        printf '"sha512-conflict"\n'
        ;;
    view:new)
        if [ ! -f /tmp/fake-npm-published ]; then
            printf 'npm error code E404\n' >&2
            exit 1
        fi
        integrity
        ;;
    view:publish-ambiguous)
        if [ ! -f /tmp/fake-npm-published ]; then
            printf 'npm error code E404\n' >&2
            exit 1
        fi
        integrity
        ;;
    view:post-publish-conflict)
        if [ ! -f /tmp/fake-npm-published ]; then
            printf 'npm error code E404\n' >&2
            exit 1
        fi
        printf '"sha512-conflict"\n'
        ;;
    view:outage)
        printf 'npm error code E500\n' >&2
        exit 1
        ;;
    publish:new)
        touch /tmp/fake-npm-published
        ;;
    publish:publish-ambiguous)
        touch /tmp/fake-npm-published
        exit 1
        ;;
    publish:post-publish-conflict)
        touch /tmp/fake-npm-published
        ;;
    *)
        exit 2
        ;;
esac
FAKE_NPM
chmod 755 "${TMP_DIR}/fake-npm"
cat >"${TMP_DIR}/fake-sleep" <<'FAKE_SLEEP'
#!/usr/bin/env bash
exit 0
FAKE_SLEEP
chmod 755 "${TMP_DIR}/fake-sleep"

mkdir -p "${TMP_DIR}/fake-bin"
cat >"${TMP_DIR}/fake-bin/docker" <<'FAKE_DOCKER'
#!/usr/bin/env bash
set -euo pipefail
[ "${NPM_TOKEN+x}" != x ] || exit 3
case " $* " in
    *npm_testtoken1234567890*) exit 4 ;;
esac
IFS= read -r token
[ "${token}" = npm_testtoken1234567890 ] || exit 5
cat >/dev/null
printf 'stdin credential transport passed\n' >"${WRAPPER_RESULT_FILE:?}"
FAKE_DOCKER
chmod 755 "${TMP_DIR}/fake-bin/docker"

if PATH="${TMP_DIR}/fake-bin:${PATH}" \
    NPM_TOKEN=invalid \
    NODE_IMAGE=test-image \
    WORKSPACE="${TMP_DIR}/workspace" \
    RELEASE_TAG=v9.8.7 \
    NPM_RELEASE_INTEGRITY=sha512-test \
    WRAPPER_RESULT_FILE="${TMP_DIR}/test/wrapper-result" \
    bash "${TMP_DIR}/credential-wrapper.sh" >/dev/null 2>&1; then
    fail 'credential wrapper accepted a malformed npm token'
fi
[ ! -e "${TMP_DIR}/test/wrapper-result" ] || \
    fail 'malformed npm token reached Docker transport'

PATH="${TMP_DIR}/fake-bin:${PATH}" \
    NPM_TOKEN=npm_testtoken1234567890 \
    NODE_IMAGE=test-image \
    WORKSPACE="${TMP_DIR}/workspace" \
    RELEASE_TAG=v9.8.7 \
    NPM_RELEASE_INTEGRITY=sha512-test \
    WRAPPER_RESULT_FILE="${TMP_DIR}/test/wrapper-result" \
    bash "${TMP_DIR}/credential-wrapper.sh"
grep -Fxq 'stdin credential transport passed' "${TMP_DIR}/test/wrapper-result" || \
    fail 'credential wrapper did not transport the token exclusively over stdin'

expected_integrity="$(
    docker run --rm \
        --read-only \
        --cap-drop ALL \
        --security-opt no-new-privileges \
        --volume "${TMP_DIR}/workspace:/workspace:ro" \
        "${NODE_IMAGE}" \
        /usr/local/bin/node -e '
            const fs = require("node:fs")
            const crypto = require("node:crypto")
            const digest = crypto.createHash("sha512")
                .update(fs.readFileSync("/workspace/danube-cli-release.tgz"))
                .digest("base64")
            process.stdout.write(`sha512-${digest}`)
        '
)"
[[ "${expected_integrity}" =~ ^sha512-[A-Za-z0-9+/]+={0,2}$ ]] || \
    fail 'could not calculate expected package integrity'

run_policy() {
    local mode="$1"
    : >"${TMP_DIR}/test/calls"
    docker run --rm --interactive \
        --read-only \
        --cap-drop ALL \
        --security-opt no-new-privileges \
        --tmpfs /tmp:rw,exec,nosuid,nodev,size=64m \
        --env HOME=/tmp \
        --env RELEASE_TAG=v9.8.7 \
        --env "NPM_RELEASE_INTEGRITY=${expected_integrity}" \
        --env "FAKE_NPM_MODE=${mode}" \
        --volume "${TMP_DIR}/workspace:/workspace:ro" \
        --volume "${TMP_DIR}/test:/test" \
        --volume "${TMP_DIR}/fake-npm:/usr/local/bin/npm:ro" \
        --volume "${TMP_DIR}/fake-sleep:/usr/bin/sleep:ro" \
        "${NODE_IMAGE}" \
        /bin/bash -ceu 'set -o pipefail; IFS= read -r NPM_TOKEN; source /dev/stdin' \
        < <(printf 'test-token\n'; cat "${TMP_DIR}/publish.sh")
}

run_policy identical
if grep -q '^publish ' "${TMP_DIR}/test/calls"; then
    fail 'identical existing version was republished'
fi

if run_policy conflict >/dev/null 2>&1; then
    fail 'conflicting existing version was accepted'
fi
if grep -q '^publish ' "${TMP_DIR}/test/calls"; then
    fail 'conflicting existing version reached npm publish'
fi

run_policy new
grep -q '^publish --access public --ignore-scripts --registry=https://registry.npmjs.org/ /workspace/danube-cli-release.tgz$' \
    "${TMP_DIR}/test/calls" || fail 'new version did not publish the exact tested tarball'

run_policy publish-ambiguous
grep -q '^publish ' "${TMP_DIR}/test/calls" || \
    fail 'ambiguous publication did not reach npm publish'

if run_policy outage >/dev/null 2>&1; then
    fail 'registry outage was accepted as an unpublished version'
fi
if grep -q '^publish ' "${TMP_DIR}/test/calls"; then
    fail 'registry outage reached npm publish'
fi

if run_policy post-publish-conflict >/dev/null 2>&1; then
    fail 'post-publication integrity conflict was accepted'
fi

printf 'npm publish policy behavior tests passed.\n'

#!/usr/bin/env bash

set -euo pipefail

fail() {
    printf 'Release context verification failed: %s\n' "$*" >&2
    exit 1
}

normalize_sha() {
    printf '%s' "$1" | tr '[:upper:]' '[:lower:]'
}

[ "$#" -eq 4 ] || \
    fail 'usage: verify-release-context.sh <tag> <expected-sha> <trusted-main-ref> <package.json>'

tag_name="$1"
expected_sha="$2"
trusted_main_ref="$3"
package_file="$4"
numeric_identifier='(0|[1-9][0-9]*)'
alphanumeric_identifier='([0-9]*[A-Za-z-][0-9A-Za-z-]*)'
prerelease_identifier="(${numeric_identifier}|${alphanumeric_identifier})"
semver_regex="^v${numeric_identifier}\\.${numeric_identifier}\\.${numeric_identifier}(-${prerelease_identifier}(\\.${prerelease_identifier})*)?(\\+[0-9A-Za-z-]+(\\.[0-9A-Za-z-]+)*)?$"

[[ "${tag_name}" =~ ${semver_regex} ]] || fail "tag ${tag_name} is not exact SemVer"
[[ "${expected_sha}" =~ ^[0-9a-fA-F]{40}$ ]] || fail 'expected SHA is not a full commit SHA'
[ "${trusted_main_ref}" = 'refs/remotes/origin/main' ] || \
    fail "unexpected trusted main ref ${trusted_main_ref}"
[ -f "${package_file}" ] || fail "missing ${package_file}"

tag_sha="$(git rev-parse --verify "refs/tags/${tag_name}^{commit}")"
head_sha="$(git rev-parse --verify 'HEAD^{commit}')"
main_sha="$(git rev-parse --verify "${trusted_main_ref}^{commit}")"
[ "$(normalize_sha "${tag_sha}")" = "$(normalize_sha "${expected_sha}")" ] || \
    fail "tag commit ${tag_sha} does not match expected ${expected_sha}"
[ "$(normalize_sha "${head_sha}")" = "$(normalize_sha "${tag_sha}")" ] || \
    fail "HEAD ${head_sha} does not match tag commit ${tag_sha}"
git merge-base --is-ancestor "${tag_sha}" "${main_sha}" || \
    fail "tag ${tag_name} is not reachable from trusted main"

package_version="$(node -e '
    const fs = require("node:fs")
    const file = process.argv[1]
    const value = JSON.parse(fs.readFileSync(file, "utf8")).version
    if (typeof value !== "string") process.exit(2)
    process.stdout.write(value)
' "${package_file}")" || fail "cannot read a string version from ${package_file}"
[ "v${package_version}" = "${tag_name}" ] || \
    fail "package version ${package_version} does not match tag ${tag_name}"

printf '%s\n' "${tag_sha}"

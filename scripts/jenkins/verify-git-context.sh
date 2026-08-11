#!/usr/bin/env bash

set -euo pipefail

fail() {
    printf 'Git context verification failed: %s\n' "$*" >&2
    exit 1
}

require_sha() {
    local name="$1"
    local value="$2"
    [[ "${value}" =~ ^[0-9a-fA-F]{40}$ ]] || fail "${name} is not a full commit SHA"
}

normalize_sha() {
    printf '%s' "$1" | tr '[:upper:]' '[:lower:]'
}

[ "$#" -ge 2 ] || fail 'usage: verify-git-context.sh <pr|main> <remote-ref> [expected-head-or-source-sha] [trusted-base-ref]'

mode="$1"
remote_ref="$2"
expected_sha="${3:-}"
checked_out_sha="$(git rev-parse --verify 'HEAD^{commit}')"
fetched_sha="$(git rev-parse --verify "${remote_ref}^{commit}")"

require_sha HEAD "${checked_out_sha}"
require_sha fetched-ref "${fetched_sha}"
[ "$(normalize_sha "${checked_out_sha}")" = "$(normalize_sha "${fetched_sha}")" ] || \
    fail "HEAD ${checked_out_sha} does not match ${remote_ref} at ${fetched_sha}"

case "${mode}" in
    pr)
        trusted_base_ref="${4:-}"
        [[ "${remote_ref}" =~ ^refs/remotes/origin/pull/[1-9][0-9]*/merge$ ]] || \
            fail "unexpected pull request merge ref ${remote_ref}"
        [ "${trusted_base_ref}" = 'refs/remotes/origin/main' ] || \
            fail "unexpected trusted base ref ${trusted_base_ref:-unset}"
        require_sha expected-head "${expected_sha}"

        read -r -a merge_parents <<<"$(git show -s --format=%P "${checked_out_sha}")"
        [ "${#merge_parents[@]}" -eq 2 ] || \
            fail "pull request merge ref must have exactly two parents"
        base_parent="${merge_parents[0]}"
        head_parent="${merge_parents[1]}"
        [ "$(normalize_sha "${head_parent}")" = "$(normalize_sha "${expected_sha}")" ] || \
            fail "merge head parent ${head_parent} does not match expected ${expected_sha}"
        git rev-parse --verify "${trusted_base_ref}^{commit}" >/dev/null
        git merge-base --is-ancestor "${base_parent}" "${trusted_base_ref}" || \
            fail "merge base parent ${base_parent} is not trusted main history"
        ;;
    main)
        [ "${remote_ref}" = 'refs/remotes/origin/main' ] || \
            fail "unexpected main ref ${remote_ref}"
        require_sha expected-source "${expected_sha}"
        [ "$(normalize_sha "${fetched_sha}")" = "$(normalize_sha "${expected_sha}")" ] || \
            fail "main tip ${fetched_sha} does not match expected ${expected_sha}"
        ;;
    *)
        fail "unsupported verification mode ${mode}"
        ;;
esac

printf '%s\n' "${checked_out_sha}"

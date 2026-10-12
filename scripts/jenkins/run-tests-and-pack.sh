#!/usr/bin/env bash

set -euo pipefail

pack_json="$(mktemp)"
pack_file=''
cleanup() {
    rm -f "${pack_json}"
    if [ -n "${pack_file}" ]; then
        rm -f -- "${pack_file}"
    fi
}
trap cleanup EXIT

npm ci
npm run build
npm test
npm pack --json --ignore-scripts >"${pack_json}"

pack_file="$(node -e '
    const fs = require("node:fs")
    const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
    if (!Array.isArray(manifest) || manifest.length !== 1) process.exit(2)
    const filename = manifest[0]?.filename
    if (typeof filename !== "string" || !/^[^/]+\.tgz$/.test(filename)) process.exit(3)
    process.stdout.write(filename)
' "${pack_json}")"

[ -s "${pack_file}" ] || {
    printf 'npm pack did not create %s\n' "${pack_file}" >&2
    exit 1
}

archive_entries="$(tar -tzf "${pack_file}")"
for required_entry in package/package.json package/bin/danube package/dist/index.js; do
    grep -Fxq "${required_entry}" <<<"${archive_entries}" || {
        printf 'npm package is missing %s\n' "${required_entry}" >&2
        exit 1
    }
done

printf 'Validated npm package %s\n' "${pack_file}"

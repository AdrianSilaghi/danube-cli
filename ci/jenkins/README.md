# Jenkins migration contract

The Jenkins controller defines these pipeline jobs from the protected `main`
branch of `AdrianSilaghi/danube-cli`:

- `danube-cli-pr/build` uses `ci/jenkins/Jenkinsfile.build`.
- `danube-cli-build/main` uses `ci/jenkins/Jenkinsfile.build`.
- `danube-cli-release/npm` uses `ci/jenkins/Jenkinsfile.release`.

## Activation prerequisite

Do not enable these Jenkins jobs until all of these safeguards exist:

- GitHub `main` rules block direct pushes and force pushes.
- Administrator and ruleset bypass is disabled.
- Branch protection rules require the authoritative `ci/jenkins/pr` status and
  use strict up-to-date checking against `main`.
- Changes to Jenkins-owned paths require CODEOWNER review.

These are cutover prerequisites; this repository does not claim that the
GitHub rules are already configured.

PR webhooks must pass `SOURCE_REF`, `SOURCE_SHA`, `CHANGE_ID`,
`CHANGE_TARGET`, `SOURCE_REPOSITORY`, `HEAD_REPOSITORY`, and
`AUTHOR_ASSOCIATION`. The job and Jenkinsfile both accept only collaborator,
same-repository PRs where both repository fields are exactly
`AdrianSilaghi/danube-cli`. `SOURCE_REF` is either empty (and derived from the
validated change id) or the synthetic
`refs/pull/<id>/merge` ref and `SOURCE_SHA` is its expected second parent.

Jenkins tests the verified synthetic merge commit, publishes
`ci/jenkins/pr-merge` there for visibility, and publishes the authoritative
`ci/jenkins/pr` status on its verified second-parent head commit. Branch
protection must use strict up-to-date checking so a green head cannot remain
mergeable after `main` advances. Never require `ci/jenkins/pr-merge`. Main
builds publish `ci/jenkins/main` only after the checkout matches both the
fetched `main` tip and the webhook SHA.

Status publication is fail-closed: if the merge visibility status cannot be
published, Jenkins marks the required head status failed and aborts the build.

Jenkins now owns pull-request and `main` CI. The remaining GitHub Actions
workflow is tag-release-only and continues to test and publish npm releases
until Jenkins npm publication is separately enabled and proven.

The release pipeline accepts `SOURCE_REF=refs/tags/v<semver>` only when the tag
commit is reachable from protected `main` and `package.json` has the same
version. It runs tests and a credential-free `npm pack` dry run. Publishing is
deliberately disabled during this phase even when `PUBLISH_TO_NPM=true`.

A later cutover may add the folder-scoped
`danube-cli-npm-publish-token` credential and bind it only after all validation
and dry-run stages. Until that separately reviewed change, the release job must
not expose an npm credential or execute `npm publish`.

# Releasing Cuppet

The release has four parts:

1. The `cuppet` npm CLI package.
2. Four platform runtime npm packages containing OpenCode and `tst-daemon`.
3. Downloadable GitHub Release assets.
4. Runtime configuration for the Sydney API, relay, and Cuppet-code host.

The release workflow builds and publishes the first three. Human-owned accounts,
certificates, DNS, and production secrets are deliberately not stored in this
repository.

## What the workflow does

[`release.yml`](../.github/workflows/release.yml) is started manually with an
existing tag such as `v0.2.0-alpha.1`. The tag must equal `v` plus the root
`package.json` version.

Each platform job uses Node 22, Bun 1.3.14, and Rust 1.88 to:

- build the TypeScript packages;
- build the target Rust runtime;
- build the pinned OpenCode derivative;
- run the test suite;
- sign and notarize macOS binaries;
- create a checked runtime package under `artifacts/`.

The publish job then:

- verifies all four runtime manifests and checksums;
- creates and smoke-installs the `cuppet-<version>.tgz` npm bundle;
- publishes the four `@cuppet/runtime-*` packages and `cuppet`;
- creates a GitHub Release containing the four runtime archives, the npm
  tarball, and `SHA256SUMS`.

## Human setup required once

### npm

Create or verify the npm organization `cuppet`. The publishing identity must
be allowed to publish:

- `cuppet`;
- `@cuppet/runtime-darwin-arm64`;
- `@cuppet/runtime-darwin-x64`;
- `@cuppet/runtime-linux-arm64-gnu`;
- `@cuppet/runtime-linux-x64-gnu`.

Create an npm automation token and add it as `NPM_TOKEN` in a GitHub
Environment named exactly `npm`. The workflow passes that secret to
`scripts/publish-release.mjs`.

### macOS signing

The current matrix publishes signed and notarized macOS packages. Add these
GitHub secrets before running a release:

```text
APPLE_CERTIFICATE_P12
APPLE_CERTIFICATE_PASSWORD
APPLE_SIGN_IDENTITY
APPLE_ID
APPLE_TEAM_ID
APPLE_APP_PASSWORD
```

### GitHub permissions

The workflow needs package publishing and release creation permissions. Those
are declared as `id-token: write` and `contents: write` in the workflow.

## Release steps

1. Update the root, CLI, and four runtime package versions together.
2. Regenerate `package-lock.json` if the version update changes it.
3. Run the normal CI checks and commit the version.
4. Create and push the matching tag:

   ```sh
   git tag v0.2.0-alpha.1
   git push origin v0.2.0-alpha.1
   ```

5. Open GitHub Actions, select `release`, choose **Run workflow**, and enter
   the exact tag.
6. Wait for all four platform jobs and the publish job to finish.
7. Install the published package on a clean Node 22 machine:

   ```sh
   npm install --global cuppet@0.2.0-alpha.1
   cuppet --version
   cuppet --doctor
   ```

npm versions are immutable. If a version has been partially published, bump
the version before trying again.

## Runtime configuration

These values are not npm package contents:

| Variable | Where it lives | Purpose |
| --- | --- | --- |
| `REMOTE_TOKEN_SECRET` | Sydney API environment | Signs five-minute mobile tokens |
| `REMOTE_RELAY_URL` | Sydney API environment | Relay address returned to mobile |
| `CUPPET_REMOTE_TOKEN_SECRET` | Cuppet-code host environment | Verifies Sydney tokens locally |
| `CUPPET_RELAY_URL` | Cuppet-code host environment | Relay address dialed by the host |
| `CUPPET_RELAY_HOST_SECRET` | Cuppet-code host environment | Authenticates the host to an authenticated relay |

`REMOTE_TOKEN_SECRET` and `CUPPET_REMOTE_TOKEN_SECRET` must have the same value.
The relay admin token and host secret are separate secrets. Provider API keys
remain on the Cuppet-code machine and are never added to CI, npm, Sydney, or
the phone.

For local Docker Compose, put the backend values in
`sydney-backend/.env`. Compose passes `.env` to both containers, but only the
API uses the remote token settings. The worker does not need them.

## Local package check

Before a release, the same npm bundle check used by CI can be run locally:

```sh
npm ci
npm run package:cli
```

The generated tarball is written under `artifacts/npm/`. It must contain the
compiled CLI and `relay-app/`, and it must install and answer `cuppet --version`
without requiring optional platform runtimes.

`npm run install:global` is a source-checkout helper. It is not the normal
end-user installation path; published users should use `npm install -g cuppet`.

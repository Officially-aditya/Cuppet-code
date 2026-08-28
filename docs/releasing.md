# Releasing Cuppet

The release has four parts:

1. The `cuppet` npm CLI package.
2. Four platform runtime npm packages containing OpenCode and `tst-daemon`.
3. Scoped runtime package mirrors in GitHub Packages.
4. Downloadable GitHub Release assets.
5. Runtime configuration for the Sydney API, relay, and Cuppet-code host.

The release workflow builds and publishes the first three. Human-owned accounts,
certificates, DNS, and production secrets are deliberately not stored in this
repository.

## What the workflow does

[`release.yml`](../.github/workflows/release.yml) starts automatically when a
`v*` tag is pushed. It can also be started manually with an existing tag such as
`v0.2.0-alpha.2`. The tag must equal `v` plus the root `package.json` version.

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
- publishes the four `@cuppet-code/runtime-*` packages and `cuppet`;
- creates a GitHub Release containing the four runtime archives, the npm
  tarball, and `SHA256SUMS`.

The GitHub Packages job is a separate mirror path. It publishes every runtime
artifact that finished successfully, so Linux runtime packages can be mirrored
even while a macOS signing job is waiting for its Apple secrets. It never
publishes the unscoped `cuppet` CLI because GitHub Packages only supports scoped
npm package names.

## Human setup required once

### npm

Create or verify the npm organization `cuppet-code`. The publishing identity must
be allowed to publish:

- `cuppet`;
- `@cuppet-code/runtime-darwin-arm64`;
- `@cuppet-code/runtime-darwin-x64`;
- `@cuppet-code/runtime-linux-arm64-gnu`;
- `@cuppet-code/runtime-linux-x64-gnu`.

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

### GitHub Packages

The runtime package names already use the `@cuppet-code` scope, and their
`repository` metadata links them to this repository. The workflow uses the
built-in `GITHUB_TOKEN`, with `packages: write`; no second registry token is
needed when the repository has access to the `cuppet-code` GitHub organization.

GitHub Packages creates new npm packages as private by default. After the first
mirror run, open each package's settings and choose its intended visibility.
Making a package public is irreversible, and GitHub's npm registry generally
still requires authentication when installing packages, even when they are
public. For that reason, public end-user installation remains:

```sh
npm install --global cuppet@0.2.0-alpha.2
```

If the `cuppet-code` namespace is not a GitHub organization that can accept the
workflow token, create a classic GitHub token with `write:packages` and add it
as a repository secret named `GH_PACKAGES_TOKEN`. The workflow uses that secret
automatically when present.

## Release steps

1. Update the root, CLI, and four runtime package versions together.
2. Regenerate `package-lock.json` if the version update changes it.
3. Run the normal CI checks and commit the version.
4. Create and push the matching tag:

   ```sh
   git tag v0.2.0-alpha.2
   git push origin v0.2.0-alpha.2
   ```

5. Pushing the tag starts the `release` workflow automatically. If you use
   **Run workflow** instead, enter the exact tag.
6. Wait for the platform jobs, the npm publish job, the GitHub Packages mirror,
   and the GitHub Release creation to finish.
7. Install the published package on a clean Node 22 machine:

   ```sh
   npm install --global cuppet@0.2.0-alpha.2
   cuppet --version
   cuppet --doctor
   ```

npm versions are immutable. If a version has been partially published, bump
the version before trying again.

## Runtime configuration

These values are not npm package contents:

| Variable | Where it lives | Purpose |
| --- | --- | --- |
| `REMOTE_TOKEN_PRIVATE_KEY` | Sydney API environment | Base64 PKCS#8 Ed25519 private key that signs five-minute mobile tokens |
| `REMOTE_RELAY_URL` | Sydney API environment | Relay address returned to mobile |
| `REMOTE_RELAY_ADMIN_TOKEN` | Sydney API environment | Backend-only token for relay host management |
| `CUPPET_REMOTE_TOKEN_PUBLIC_KEY` | Optional Cuppet-code host override | Base64 Ed25519 public key; normal enrollment supplies and stores it automatically |
| `CUPPET_RELAY_URL` | Cuppet-code host environment | Optional relay override; Sydney can supply it |
| `CUPPET_RELAY_HOST_SECRET` | Cuppet-code host environment | Optional legacy/manual override |
| `CUPPET_TOKEN` | Cuppet-code host environment | Authenticates automatic host enrollment |

`REMOTE_TOKEN_PRIVATE_KEY` remains only on Sydney. When remote control starts,
Cuppet-code enrolls through the authenticated Sydney endpoint, receives and
persists the matching public verification key, and generates a unique host
secret for relay registration. Users do not need to configure a token secret or
hardcode `CUPPET_RELAY_HOST_SECRET`.
Provider API keys remain on the Cuppet-code machine and are never added to CI,
npm, Sydney, or the phone.

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

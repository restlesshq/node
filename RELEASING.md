# Releasing

Releases publish from GitHub Actions when a version tag is pushed. Nobody publishes from a laptop.

1. Open a PR that bumps the version: `npm version <patch|minor|major> --no-git-tag-version`, which changes `package.json` and `package-lock.json`. The SDK reads its version from `package.json` at build time, so nothing else needs editing. Merge it.
2. Tag the merge commit on `main` and push the tag:

   ```sh
   git checkout main && git pull --ff-only
   git tag v$(node -p "require('./package.json').version")
   git push origin --tags
   ```

3. The `Publish` workflow checks that the tag matches `package.json` and is on `main`, then typechecks, builds, runs the tests and the conformance vectors, and publishes. Each version gets npm provenance linking it to that commit and workflow run.

A tag that doesn't match `package.json`, or points at a commit that isn't on `main`, fails before anything is built.

## Choosing the version

A release that adopts a new minor spec version (`spec/CONTRACT.md`) is a minor bump, even when no option or method changes; bug fixes are a patch.

## One-time setup

Publishing uses npm trusted publishing, so there is no token to store or rotate. On npmjs.com, in the `@restlessai/sdk` package settings, add a trusted publisher for GitHub Actions with organization `restlesshq`, repository `node` and workflow `publish.yml`. Once a release has gone through it, you can also set publishing access to require two-factor authentication and disallow tokens, which leaves this workflow as the only way to publish.

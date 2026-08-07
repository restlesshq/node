/**
 * Version of `spec/CONTRACT.md` this SDK implements, and the conformance
 * level it claims (CONTRACT.md META-001). Sent on every upload as
 * `X-Restless-Spec-Version` (META-002) so the ingest can attribute an
 * off-contract payload to a specific SDK and spec version.
 *
 * Hardcoded rather than parsed from `CONTRACT.md`: the contract is a
 * dev-time artifact and is not in the published tarball, so a runtime read
 * would work in this repo and fail everywhere else. Bump it in the same
 * change that bumps the version at the top of `CONTRACT.md`.
 *
 * Not to be confused with `__SDK_VERSION__` (the npm package version, baked
 * in at build time from package.json and shipped as the HAR `creator`).
 */
export const SPEC_VERSION = "1.0.0";

/** Conformance level this SDK claims. L2 = core plus sections 8-13. */
export const CONFORMANCE_LEVEL = "L2";

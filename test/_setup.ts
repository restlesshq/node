// Vitest global setup. Runs once before any test file.
//
// The SDK no-ops uploads when it detects a test runner (VITEST=true in our
// case). We want our OWN tests to actually exercise the upload path — so we
// flip the explicit override on, which re-enables uploads regardless of
// test-run detection.
process.env.RESTLESS_SETUP_MODE = "1";

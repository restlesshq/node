/**
 * Conformance case DEFINITIONS: inputs only, no expected values.
 *
 * Expected values are computed by running these inputs through the Node
 * implementation (see `test/spec.vectors.test.ts`) and written to
 * `spec/vectors/*.json`. That is what makes "Node is the source of truth"
 * mechanical rather than aspirational: nobody hand-writes an expectation,
 * so the vectors cannot claim something the reference implementation does
 * not actually do.
 *
 * Ports do NOT read this file. They read the generated JSON.
 *
 * Adding a case here and running `npm run spec:vectors` extends the
 * contract's test surface for every SDK at once.
 */

export interface CaseDef {
  /** Stable, human-readable case id. Unique within its file. */
  id: string;
  /** The requirement this case pins. See spec/CONTRACT.md. */
  requirement: string;
  /** Driver operation name. See spec/driver/PROTOCOL.md. */
  op: string;
  /** Operation input, passed through to the driver verbatim. */
  input: Record<string, unknown>;
  /**
   * How the harness compares actual to expected.
   *   "exact" (default) - deep structural equality
   *   "json"  - both sides are JSON *strings*; parse before comparing, so
   *             an implementation whose encoder orders keys differently is
   *             not failed for that alone
   */
  compare?: "exact" | "json";
  /** Why this case exists, when that is not obvious from the input. */
  note?: string;
}

// ---------------------------------------------------------------------------
// mask
// ---------------------------------------------------------------------------

export const MASK_CASES: CaseDef[] = [
  { id: "mask/ascii", requirement: "MASK-001", op: "mask", input: { apiKey: "rdme_abc123wxyz" } },
  { id: "mask/short", requirement: "MASK-006", op: "mask", input: { apiKey: "ab" },
    note: "Fewer than 4 code points: the tail is the whole key." },
  { id: "mask/exactly-four", requirement: "MASK-006", op: "mask", input: { apiKey: "abcd" } },
  { id: "mask/utf8-hashing", requirement: "MASK-004", op: "mask", input: { apiKey: "clé-café-secrète" },
    note: "Pins that the digest is over UTF-8 bytes, not UTF-16 or Latin-1." },
  { id: "mask/astral-tail", requirement: "MASK-006", op: "mask", input: { apiKey: "key-with-emoji-🙂🚀" },
    note: "The single highest-value case in this file. A UTF-16 slice(-4) splits the rocket's surrogate pair and yields a different, ill-formed tail. Code-point slicing gives the last four real characters." },
  { id: "mask/combining-marks", requirement: "MASK-006", op: "mask", input: { apiKey: "secret-ȩ́" },
    note: "Combining marks are separate code points and count individually. We do NOT normalize (NFC would change the digest)." },
  { id: "mask/cjk", requirement: "MASK-004", op: "mask", input: { apiKey: "鍵-秘密-値-一二三四" } },
  { id: "mask/base64-padding", requirement: "MASK-003", op: "mask", input: { apiKey: "a" },
    note: "SHA-512 is 64 bytes, so standard base64 always emits exactly 88 chars ending in '=='. Catches a port that used base64url or stripped padding." },
  { id: "mask/empty", requirement: "MASK-010", op: "mask", input: { apiKey: "" } },
  { id: "mask/null", requirement: "MASK-010", op: "mask", input: { apiKey: null } },
  { id: "mask/placeholder-api-key-here", requirement: "MASK-011", op: "mask", input: { apiKey: "API_KEY_HERE" } },
  { id: "mask/placeholder-your-api-key", requirement: "MASK-011", op: "mask", input: { apiKey: "YOUR_API_KEY" } },
  { id: "mask/placeholder-your-key", requirement: "MASK-011", op: "mask", input: { apiKey: "YOUR_KEY" } },
  { id: "mask/placeholder-replace-me", requirement: "MASK-011", op: "mask", input: { apiKey: "REPLACE_ME" } },
  { id: "mask/placeholder-case-sensitive", requirement: "MASK-011", op: "mask", input: { apiKey: "api_key_here" },
    note: "Placeholders match exactly. A lowercase variant is a real key." },
  { id: "mask/idempotent", requirement: "MASK-012", op: "mask",
    input: { apiKey: "sha512-3q2+7w==?wxyz" } },
  { id: "mask/redacted-passthrough-long", requirement: "MASK-013", op: "mask", input: { apiKey: "<REDACTED:24:u234>" } },
  { id: "mask/redacted-passthrough-short", requirement: "MASK-013", op: "mask", input: { apiKey: "<REDACTED:7>" } },
];

// ---------------------------------------------------------------------------
// redact
// ---------------------------------------------------------------------------

export const REDACT_CASES: CaseDef[] = [
  // --- sentinel ---
  { id: "redactValue/long", requirement: "REDACT-001", op: "redactValue", input: { value: "sk_1234567890abcdef" } },
  { id: "redactValue/boundary-7", requirement: "REDACT-001", op: "redactValue", input: { value: "1234567" },
    note: "One below the tail threshold: no tail." },
  { id: "redactValue/boundary-8", requirement: "REDACT-001", op: "redactValue", input: { value: "12345678" },
    note: "Exactly at the threshold: tail appears." },
  { id: "redactValue/empty", requirement: "REDACT-001", op: "redactValue", input: { value: "" } },
  { id: "redactValue/astral", requirement: "REDACT-002", op: "redactValue", input: { value: "🙂🙂🙂🙂🙂🙂🙂🙂" },
    note: "8 code points, 16 UTF-16 code units, 32 UTF-8 bytes. The sentinel must say 8. Catches the most common porting mistake in this file." },
  { id: "redactValue/mixed-width", requirement: "REDACT-002", op: "redactValue", input: { value: "abc-日本語-🚀-xyz" } },
  { id: "redactValue/astral-tail-split", requirement: "REDACT-002", op: "redactValue", input: { value: "0123456789🚀" },
    note: "A UTF-16 slice(-4) ends mid-surrogate here and produces an ill-formed tail." },

  // --- headers ---
  { id: "redactHeaders/defaults", requirement: "REDACT-011", op: "redactHeaders",
    input: { headers: { authorization: "Bearer abcdef0123456789", cookie: "sid=xyz9999", "content-type": "application/json", host: "example.com" } } },
  { id: "redactHeaders/case-insensitive", requirement: "REDACT-010", op: "redactHeaders",
    input: { headers: { Authorization: "Bearer xxxxxxxxxxxx", "X-API-KEY": "sk_abcdef0123" } } },
  { id: "redactHeaders/scheme-preserved-bearer", requirement: "REDACT-016", op: "redactHeaders",
    input: { headers: { authorization: "Bearer abcdef0123456789" } } },
  { id: "redactHeaders/scheme-preserved-basic", requirement: "REDACT-016", op: "redactHeaders",
    input: { headers: { authorization: "Basic dXNlcjpwYXNzd29yZA==" } } },
  { id: "redactHeaders/scheme-multi-space", requirement: "REDACT-016", op: "redactHeaders",
    input: { headers: { authorization: "Bearer    abcdef0123456789" } },
    note: "Split on the first whitespace RUN; the run itself is preserved verbatim." },
  { id: "redactHeaders/scheme-with-cr-in-credential", requirement: "REDACT-016", op: "redactHeaders",
    input: { headers: { authorization: "Bearer abc\rdef0123456789" } },
    note: "Found by differential fuzz. The old /^(\\S+)(\\s+)(\\S.*)$/ did not match here because JS '.' excludes CR, so Node redacted the whole value while Python (re.DOTALL) preserved the scheme. The explicit scan makes both preserve it." },
  { id: "redactHeaders/scheme-with-astral-credential", requirement: "REDACT-016", op: "redactHeaders",
    input: { headers: { authorization: "Bearer abcdef012345\u{1F680}" } },
    note: "Scheme split walks code points, so the sentinel length counts the rocket once." },
  { id: "redactHeaders/leading-whitespace", requirement: "REDACT-016", op: "redactHeaders",
    input: { headers: { authorization: "   Bearer abcdef0123" } },
    note: "Value starts with whitespace: there is no scheme to preserve, so redact whole." },
  { id: "redactHeaders/scheme-only-trailing-space", requirement: "REDACT-016", op: "redactHeaders",
    input: { headers: { authorization: "Bearer   " } },
    note: "Whitespace but no credential after it: redact whole." },
  { id: "redactHeaders/no-scheme", requirement: "REDACT-017", op: "redactHeaders",
    input: { headers: { authorization: "eyJhbGciOiJIUzI1NiJ9.payload.sig" } },
    note: "A bare JWT has no space, so the whole value is the secret." },
  { id: "redactHeaders/proxy-authorization", requirement: "REDACT-016", op: "redactHeaders",
    input: { headers: { "proxy-authorization": "Digest abcdef0123456789" } } },
  { id: "redactHeaders/x-api-key-whole", requirement: "REDACT-018", op: "redactHeaders",
    input: { headers: { "x-api-key": "Bearer looks-like-a-scheme-but-is-not" } },
    note: "Only authorization / proxy-authorization get scheme treatment. Everything else is redacted whole even if it looks schemed." },
  { id: "redactHeaders/set-cookie", requirement: "REDACT-011", op: "redactHeaders",
    input: { headers: { "set-cookie": "sid=abcdef; HttpOnly" } } },
  { id: "redactHeaders/unicode-fold-kelvin", requirement: "REDACT-010", op: "redactHeaders",
    input: { headers: { "x-api-\u212Aey": "supersecretvalue" } },
    note: "SECURITY. U+212A KELVIN SIGN full-lowercases to 'k', so this IS x-api-key and MUST be redacted. An ASCII-only fold leaves it unmatched and ships the secret. Every port initially got this backwards and leaked the value, which is why this case exists." },
  { id: "redactHeaders/unicode-fold-longs", requirement: "REDACT-010", op: "redactHeaders",
    input: { headers: { "\u017Fet-cookie": "sid=abcdefgh" } },
    note: "U+017F LATIN SMALL LETTER LONG S is already lowercase, so full lowercasing does NOT turn it into 's'. This one must NOT be redacted - the rule is fold, not fuzzy-match." },
  { id: "redactHeaders/extra-denylist", requirement: "REDACT-015", op: "redactHeaders",
    input: { headers: { "x-custom-secret": "verylongsecretvalue" }, extra: ["x-custom-secret"] } },
  { id: "redactHeaders/extra-normalized", requirement: "REDACT-010", op: "redactHeaders",
    input: { headers: { "X_Custom_Secret": "verylongsecretvalue" }, extra: ["x-custom-secret"] },
    note: "Extension entries normalize the same way defaults do." },
  { id: "redactHeaders/defaults-not-removable", requirement: "REDACT-014", op: "redactHeaders",
    input: { headers: { authorization: "Bearer abcdef0123456789" }, extra: ["unrelated"] } },

  // --- url ---
  { id: "redactUrl/basic", requirement: "REDACT-025", op: "redactUrl",
    input: { url: "https://api.example/v1/foo?bar=ok&api_key=sk_abcdef123&token=tk_9876543210" } },
  { id: "redactUrl/clean", requirement: "REDACT-025", op: "redactUrl",
    input: { url: "https://api.example/v1/foo?bar=ok" } },
  { id: "redactUrl/not-a-url", requirement: "REDACT-026", op: "redactUrl", input: { url: "not a url" } },
  { id: "redactUrl/no-normalization", requirement: "REDACT-025", op: "redactUrl",
    input: { url: "https://api.example:443/v1/foo?a=1&password=hunter2hunter2" },
    note: "The default port SURVIVES. Nothing outside the matched values may change, so there is no URL round trip to normalize it away - which is also the only reason a Python or Go port can match us without reimplementing WHATWG." },
  { id: "redactUrl/plus-in-query", requirement: "REDACT-029", op: "redactUrl",
    input: { url: "https://api.example/s?q=a+b&secret=abcdefghij" },
    note: "'+' decodes to a space when reading a value, and untouched params keep their bytes exactly." },
  { id: "redactUrl/repeated-param", requirement: "REDACT-027", op: "redactUrl",
    input: { url: "https://api.example/s?token=aaaaaaaaaa&token=bbbbbbbbbb" },
    note: "Both params survive and are redacted independently. The old URL round trip collapsed them into one, silently dropping the second value, and re-redacted the first sentinel to <REDACTED:18:aaa>>." },
  { id: "redactUrl/empty-value", requirement: "REDACT-025", op: "redactUrl",
    input: { url: "https://api.example/s?token=" } },
  { id: "redactUrl/valueless-param", requirement: "REDACT-025", op: "redactUrl",
    input: { url: "https://api.example/s?token&a=1" },
    note: "A pair with no '=' is not a key/value pair and is left alone." },
  { id: "redactUrl/fragment-preserved", requirement: "REDACT-025", op: "redactUrl",
    input: { url: "https://api.example/s?token=abcdefghij#section-2" } },
  { id: "redactUrl/encoded-key", requirement: "REDACT-029", op: "redactUrl",
    input: { url: "https://api.example/s?api%5Fkey=abcdefghij" },
    note: "The key is percent-decoded before the denylist test, so an encoded underscore still matches." },
  { id: "redactUrl/encoded-value", requirement: "REDACT-029", op: "redactUrl",
    input: { url: "https://api.example/s?token=a%20b%2Fc%C3%A9" },
    note: "The sentinel length is of the DECODED value (6 code points), not the encoded text." },
  { id: "redactUrl/sentinel-encoding", requirement: "REDACT-028", op: "redactUrl",
    input: { url: "https://api.example/s?token=abcdef~-._x" },
    note: "Pins the encode set: unreserved chars in the tail stay literal, everything else is uppercase percent-hex." },
  { id: "redactUrl/astral-value", requirement: "REDACT-029", op: "redactUrl",
    input: { url: "https://api.example/s?password=\u{1F680}+L" },
    note: "Found by differential fuzz. Node's percentDecode indexed UTF-16 code units, so it split the rocket's surrogate pair and turned one emoji into two U+FFFD - reporting length 5 where Python reported 4. Decoding walks code points now." },
  { id: "redactUrl/invalid-percent-escape", requirement: "PRIM-006", op: "redactUrl",
    input: { url: "https://api.example/s?token=FUY$%D\u2009k0" },
    note: "Found by differential fuzz. '%D' followed by U+2009 is not two hex digits, so the '%' is literal. Python's int(s,16) strips Unicode whitespace and decoded it as a byte; the digits must be validated explicitly." },
  { id: "redactUrl/no-query", requirement: "REDACT-025", op: "redactUrl",
    input: { url: "https://api.example/v1/foo" } },

  // --- body ---
  { id: "redactBody/basic", requirement: "REDACT-022", op: "redactBody", compare: "json",
    input: { body: '{"username":"jane","password":"hunter2hunter2","cc_number":"4111111111111111"}', contentType: "application/json" } },
  { id: "redactBody/name-normalization", requirement: "REDACT-010", op: "redactBody", compare: "json",
    input: { body: '{"apiKey":"abcdefghijk","api_key":"abcdefghijk","API-Key":"abcdefghijk","APIKEY":"abcdefghijk"}', contentType: "application/json" } },
  { id: "redactBody/nested-and-arrays", requirement: "REDACT-022", op: "redactBody", compare: "json",
    input: { body: '{"user":{"name":"jane","password":"hunter2hunter2"},"auths":[{"token":"tk_abcdef123"}]}', contentType: "application/json" } },
  { id: "redactBody/non-string-secret", requirement: "REDACT-004", op: "redactBody", compare: "json",
    input: { body: '{"password":12345,"token":null,"secret":{"a":1}}', contentType: "application/json" } },
  { id: "redactBody/passthrough-no-secrets", requirement: "REDACT-020", op: "redactBody",
    input: { body: '{ "a" : 1.0, "b" : [ 1, 2 ] }', contentType: "application/json" },
    note: "No denylisted key anywhere, so the ORIGINAL string comes back byte for byte: whitespace intact, 1.0 still 1.0. Compared exactly, not JSON-normalized." },
  { id: "redactBody/passthrough-preserves-int64", requirement: "REDACT-020", op: "redactBody",
    input: { body: '{"id":9007199254740993,"big":123456789012345678901234567890}', contentType: "application/json" },
    note: "The bug this rule fixes. A parse/serialize round trip in JS turns 9007199254740993 into ...992. Passthrough keeps it exact." },
  { id: "redactBody/passthrough-preserves-key-order", requirement: "REDACT-020", op: "redactBody",
    input: { body: '{"z":1,"a":2,"m":3}', contentType: "application/json" },
    note: "Also removes the Go encoding/json key-sorting divergence for every body with nothing to redact." },
  { id: "redactBody/reserialize-when-secret-present", requirement: "REDACT-022", op: "redactBody", compare: "json",
    input: { body: '{ "id" : 42 , "password" : "hunter2hunter2" }', contentType: "application/json" },
    note: "Once something must be rewritten, re-serialization is unavoidable: compact separators, key order preserved." },
  { id: "redactBody/unicode-not-escaped", requirement: "PRIM-032", op: "redactBody", compare: "json",
    input: { body: '{"name":"café 日本","token":"abcdefghij"}', contentType: "application/json" } },
  { id: "redactBody/non-json-content-type", requirement: "REDACT-023", op: "redactBody",
    input: { body: '{"password":"hunter2hunter2"}', contentType: "text/plain" },
    note: "Content type gates redaction entirely. A JSON-shaped body under text/plain is untouched." },
  { id: "redactBody/content-type-with-charset", requirement: "REDACT-023", op: "redactBody", compare: "json",
    input: { body: '{"password":"hunter2hunter2"}', contentType: "application/json; charset=utf-8" } },
  { id: "redactBody/unparseable", requirement: "REDACT-024", op: "redactBody",
    input: { body: "{not json", contentType: "application/json" } },
  { id: "redactBody/empty", requirement: "REDACT-024", op: "redactBody",
    input: { body: "", contentType: "application/json" } },
  { id: "redactBody/scalar-root", requirement: "REDACT-020", op: "redactBody",
    input: { body: '"just a string"', contentType: "application/json" } },
  { id: "redactBody/array-root-with-secret", requirement: "REDACT-021", op: "redactBody", compare: "json",
    input: { body: '[{"token":"abcdefghij"},{"ok":1}]', contentType: "application/json" },
    note: "The denied-key walk descends through arrays at the root." },
  { id: "redactBody/deeply-nested-secret", requirement: "REDACT-021", op: "redactBody", compare: "json",
    input: { body: '{"a":{"b":{"c":{"d":{"password":"hunter2hunter2"}}}}}', contentType: "application/json" } },
  { id: "redactBody/unicode-fold-kelvin", requirement: "REDACT-010", op: "redactBody", compare: "json",
    input: { body: '{"to\u212Aen":"supersecretvalue"}', contentType: "application/json" },
    note: "SECURITY. The same KELVIN SIGN bypass in a body key. The reference redacts it; every port that implemented the withdrawn ASCII fold leaked the value." },
  { id: "redactBody/lone-surrogate", requirement: "PRIM-034", op: "redactBody",
    input: { body: '{"a":"\ud83d","token":"abcdefghij"}', contentType: "application/json" },
    note: "Found by differential fuzz. A lone surrogate has no UTF-8 encoding, so it must be re-emitted as a \\uXXXX escape. Python's ensure_ascii=False wrote the raw character and produced a string that could not be encoded at all." },
  { id: "redactBody/extra-denylist", requirement: "REDACT-015", op: "redactBody", compare: "json",
    input: { body: '{"mySecretField":"verylongsecret123"}', contentType: "application/json", extra: ["mySecretField"] } },

  // --- truncation ---
  { id: "truncateBody/under-limit", requirement: "REDACT-030", op: "truncateBody", input: { body: "short", maxBytes: 100 } },
  { id: "truncateBody/exactly-at-limit", requirement: "REDACT-030", op: "truncateBody", input: { body: "0123456789", maxBytes: 10 },
    note: "<= the limit passes through untouched." },
  { id: "truncateBody/one-over", requirement: "REDACT-030", op: "truncateBody", input: { body: "0123456789A", maxBytes: 10 } },
  { id: "truncateBody/multibyte-boundary", requirement: "REDACT-031", op: "truncateBody",
    input: { body: "aé日🚀aé日🚀aé日🚀", maxBytes: 12 },
    note: "The cut lands mid-character. Backing off must yield a well-formed prefix, never a broken sequence or a lone surrogate." },
  { id: "truncateBody/cut-inside-emoji", requirement: "REDACT-031", op: "truncateBody",
    input: { body: "🚀🚀🚀🚀", maxBytes: 6 },
    note: "6 bytes is one and a half rockets. The kept prefix must be one rocket." },
  { id: "truncateBody/original-length-is-bytes", requirement: "REDACT-032", op: "truncateBody",
    input: { body: "日本語日本語日本語日本語", maxBytes: 9 },
    note: "The reported original length is UTF-8 bytes (36), not characters (12)." },
  { id: "truncateBody/empty", requirement: "REDACT-030", op: "truncateBody", input: { body: "", maxBytes: 10 } },
  { id: "truncateBody/null", requirement: "REDACT-030", op: "truncateBody", input: { body: null, maxBytes: 10 } },
];

// ---------------------------------------------------------------------------
// fingerprint
// ---------------------------------------------------------------------------

export const FINGERPRINT_CASES: CaseDef[] = [
  // --- 404 ladder ---
  { id: "fp/404-parameterized", requirement: "FP-013", op: "fingerprint",
    input: { status: 404, method: "GET", route: "/car/{id}" } },
  { id: "fp/404-concrete-id-is-parameterized", requirement: "FP-014", op: "fingerprint",
    input: { status: 404, method: "GET", route: "/car/123" },
    note: "Normalization runs BEFORE the parameter test, so a concrete id counts." },
  { id: "fp/404-collapses-across-routes", requirement: "FP-013", op: "fingerprint",
    input: { status: 404, method: "DELETE", route: "/user/{id}/posts/{postId}" } },
  { id: "fp/404-paramless-route", requirement: "FP-013", op: "fingerprint",
    input: { status: 404, method: "GET", route: "/users" } },
  { id: "fp/404-no-route", requirement: "FP-014", op: "fingerprint",
    input: { status: 404, method: "GET" } },
  { id: "fp/404-header-code-does-not-win", requirement: "FP-012", op: "fingerprint",
    input: { status: 404, method: "GET", route: "/car/{id}", responseHeaders: { "x-restless-error-code": "not_found" } },
    note: "404 is intercepted before the header strategy. A generic not_found must not re-collapse the two buckets." },
  { id: "fp/404-body-code-does-not-win", requirement: "FP-012", op: "fingerprint",
    input: { status: 404, method: "GET", route: "/users", responseBody: { code: "not_found" } } },

  // --- header ---
  { id: "fp/header-code", requirement: "FP-010", op: "fingerprint",
    input: { status: 400, method: "GET", route: "/car/{id}", responseHeaders: { "x-restless-error-code": "invalid_param" } } },
  { id: "fp/header-case-insensitive", requirement: "FP-017", op: "fingerprint",
    input: { status: 400, responseHeaders: { "X-Restless-Error-Code": "invalid_param" } } },
  { id: "fp/header-rejects-sentence", requirement: "FP-015", op: "fingerprint",
    input: { status: 400, method: "POST", route: "/pay", responseHeaders: { "x-restless-error-code": "Your card was declined." } },
    note: "Not identifier-shaped, so it is not a code and the ladder continues." },
  { id: "fp/header-rejects-leading-digit", requirement: "FP-015", op: "fingerprint",
    input: { status: 400, method: "POST", route: "/pay", responseHeaders: { "x-restless-error-code": "4xx_bad" } } },
  { id: "fp/header-rejects-too-long", requirement: "FP-015", op: "fingerprint",
    input: { status: 400, method: "POST", route: "/pay", responseHeaders: { "x-restless-error-code": "a".repeat(65) } } },
  { id: "fp/header-accepts-64", requirement: "FP-015", op: "fingerprint",
    input: { status: 400, responseHeaders: { "x-restless-error-code": "a".repeat(64) } } },

  // --- body code ---
  { id: "fp/body-code", requirement: "FP-016", op: "fingerprint",
    input: { status: 402, method: "POST", route: "/pay", responseBody: { code: "card_declined" } } },
  { id: "fp/body-error_code", requirement: "FP-016", op: "fingerprint",
    input: { status: 402, responseBody: { error_code: "card_declined" } } },
  { id: "fp/body-errorCode", requirement: "FP-016", op: "fingerprint",
    input: { status: 402, responseBody: { errorCode: "card_declined" } } },
  { id: "fp/body-type", requirement: "FP-016", op: "fingerprint",
    input: { status: 402, responseBody: { type: "card_error" } } },
  { id: "fp/body-nested-error-code", requirement: "FP-016", op: "fingerprint",
    input: { status: 402, responseBody: { error: { code: "card_declined" } } } },
  { id: "fp/body-nested-error-type", requirement: "FP-016", op: "fingerprint",
    input: { status: 402, responseBody: { error: { type: "card_error" } } } },
  { id: "fp/body-code-precedence", requirement: "FP-016", op: "fingerprint",
    input: { status: 402, responseBody: { type: "b", code: "a" } },
    note: "Field order is fixed: code before error_code before errorCode before type." },
  { id: "fp/body-code-exact-case", requirement: "FP-016", op: "fingerprint",
    input: { status: 402, method: "POST", route: "/pay", responseBody: { Code: "card_declined" } },
    note: "Code field names are matched case-SENSITIVELY. Unlike redaction keys, there is no normalization here." },
  { id: "fp/header-beats-body", requirement: "FP-010", op: "fingerprint",
    input: { status: 402, responseHeaders: { "x-restless-error-code": "from_header" }, responseBody: { code: "from_body" } } },

  // --- stack ---
  { id: "fp/stack-basic", requirement: "FP-040", op: "fingerprint",
    input: { status: 500, method: "GET", route: "/users", stackTrace: "Error: boom\n    at findById (/Users/dev/proj/src/db/users.js:12:34)\n    at handler (/Users/dev/proj/src/routes/users.js:5:1)" } },
  { id: "fp/stack-path-machine-independent", requirement: "FP-042", op: "fingerprint",
    input: { status: 500, method: "GET", route: "/users", stackTrace: "Error: boom\n    at findById (/srv/app/src/db/users.js:99:1)" },
    note: "Same key as fp/stack-basic, which is the whole point of FP-042: a different absolute prefix must not change the fingerprint. Was broken until FP-042 switched from first-match to last-match." },
  { id: "fp/stack-skips-vendor", requirement: "FP-043", op: "fingerprint",
    input: { status: 500, stackTrace: "Error: boom\n    at wrap (/proj/node_modules/express/lib/router.js:1:1)\n    at emit (node:internal/events:100:1)\n    at real (/proj/src/db/users.js:12:34)" } },
  { id: "fp/stack-anonymous-frame", requirement: "FP-045", op: "fingerprint",
    input: { status: 500, stackTrace: "Error: boom\n    at /proj/src/db/users.js:12:34" } },
  { id: "fp/stack-no-known-dir", requirement: "FP-042", op: "fingerprint",
    input: { status: 500, stackTrace: "Error: boom\n    at go (/opt/weird/place/thing.js:3:1)" },
    note: "No src/lib/app/api/routes/controllers/handlers segment, so fall back to the last two path components." },
  { id: "fp/stack-array-form", requirement: "FP-040", op: "fingerprint",
    input: { status: 500, stackTrace: ["Error: boom", "    at findById (/proj/src/db/users.js:12:34)"] } },
  { id: "fp/stack-not-used-for-4xx", requirement: "FP-010", op: "fingerprint",
    input: { status: 400, method: "GET", route: "/users", stackTrace: "Error: boom\n    at findById (/proj/src/db/users.js:12:34)" },
    note: "The stack strategy is 5xx only." },

  // --- message ---
  { id: "fp/message-basic", requirement: "FP-010", op: "fingerprint",
    input: { status: 400, method: "POST", route: "/users", responseBody: { message: "Cannot read property of undefined" } } },
  { id: "fp/message-strips-ids", requirement: "FP-021", op: "fingerprint",
    input: { status: 400, method: "POST", route: "/users", responseBody: { message: "User user_abc123 not found in workspace 42" } } },
  { id: "fp/message-nested", requirement: "FP-018", op: "fingerprint",
    input: { status: 400, method: "POST", route: "/users", responseBody: { error: { message: "Something broke badly here" } } } },
  { id: "fp/message-error-as-string", requirement: "FP-018", op: "fingerprint",
    input: { status: 400, method: "POST", route: "/users", responseBody: { error: "Something broke badly here" } } },
  { id: "fp/message-body-as-string", requirement: "FP-018", op: "fingerprint",
    input: { status: 400, method: "POST", route: "/users", responseBody: "Something broke badly here" } },
  { id: "fp/message-empty-falls-through", requirement: "FP-022", op: "fingerprint",
    input: { status: 400, method: "POST", route: "/users", responseBody: { message: "42 1 7" } },
    note: "Everything normalizes away, so the message strategy does not fire and we land on route-only." },

  // --- route-only ---
  { id: "fp/route-only", requirement: "FP-010", op: "fingerprint",
    input: { status: 503, method: "GET", route: "/health" } },
  { id: "fp/route-only-no-method", requirement: "FP-011", op: "fingerprint",
    input: { status: 503, route: "/health" },
    note: "Absent method defaults to GET." },
  { id: "fp/route-only-no-route", requirement: "FP-032", op: "fingerprint",
    input: { status: 503, method: "GET" } },

  // --- FP-047: the transitional previous key ---
  { id: "fp/stack-carries-previous-key", requirement: "FP-047", op: "fingerprint",
    input: { status: 500, method: "POST", route: "/pets", responseBody: { message: "Something came apart" },
             stackTrace: "Error: boom\n    at findById (/proj/src/db/users.js:12:34)" },
    note: "The stack strategy displaces the message strategy, so it reports what the key WOULD have been. Without this, turning the stack strategy on silently orphans any Agent Recovery message already attached to the old key." },
  { id: "fp/no-previous-key-without-stack", requirement: "FP-047", op: "fingerprint",
    input: { status: 500, method: "POST", route: "/pets", responseBody: { message: "Something came apart" } },
    note: "Nothing was displaced, so there is no previous key to report." },

  // --- normalizeRoute ---
  { id: "route/numeric", requirement: "FP-030", op: "normalizeRoute", input: { route: "/users/123" } },
  { id: "route/uuid", requirement: "FP-030", op: "normalizeRoute", input: { route: "/users/550e8400-e29b-41d4-a716-446655440000" } },
  { id: "route/uuid-uppercase", requirement: "FP-030", op: "normalizeRoute", input: { route: "/users/550E8400-E29B-41D4-A716-446655440000" } },
  { id: "route/long-hex", requirement: "FP-030", op: "normalizeRoute", input: { route: "/blobs/deadbeefdeadbeef" } },
  { id: "route/short-hex-untouched", requirement: "FP-030", op: "normalizeRoute", input: { route: "/blobs/deadbeefdeadbee" },
    note: "15 hex chars is one below the 16 threshold, so it stays." },
  { id: "route/multiple-segments", requirement: "FP-031", op: "normalizeRoute", input: { route: "/users/1/posts/2/comments/3" } },
  { id: "route/already-templated", requirement: "FP-030", op: "normalizeRoute", input: { route: "/users/{id}" } },
  { id: "route/already-colon", requirement: "FP-030", op: "normalizeRoute", input: { route: "/users/:id" } },
  { id: "route/trailing-slash", requirement: "FP-031", op: "normalizeRoute", input: { route: "/users/123/" } },
  { id: "route/index-zero-exempt", requirement: "FP-031", op: "normalizeRoute", input: { route: "123" },
    note: "The text before the first slash is never normalized. Preserved deliberately so stored fingerprints stay stable." },
  { id: "route/index-zero-exempt-with-tail", requirement: "FP-031", op: "normalizeRoute", input: { route: "123/456" } },
  { id: "route/empty", requirement: "FP-032", op: "normalizeRoute", input: { route: "" } },
  { id: "route/null", requirement: "FP-032", op: "normalizeRoute", input: { route: null } },
  { id: "route/double-slash", requirement: "FP-031", op: "normalizeRoute", input: { route: "//users//123" } },
  { id: "route/zero", requirement: "FP-030", op: "normalizeRoute", input: { route: "/users/0" } },
  { id: "route/leading-zeros", requirement: "FP-030", op: "normalizeRoute", input: { route: "/users/007" } },
  { id: "route/segment-with-trailing-newline", requirement: "PRIM-005", op: "normalizeRoute",
    input: { route: "/users/5\n" },
    note: "Found by differential fuzz. Python's `$` also matches before a trailing newline, so ^[0-9]+$ accepted \"5\\n\" and normalized it to :id while JS left it alone. Anchored patterns must match the WHOLE string (re.fullmatch)." },
  { id: "route/not-quite-uuid", requirement: "FP-030", op: "normalizeRoute", input: { route: "/users/550e8400-e29b-41d4-a716-44665544000" },
    note: "One char short of a UUID, and only 35 chars so not long-hex either. Stays." },

  // --- projectRelative ---
  // FP-042 is shared by every SDK even though frame PARSING is not
  // (FP-044/FP-046), so it gets a dialect-free op of its own. Without this,
  // path normalization would go unverified in any language whose stack
  // traces do not look like v8's.
  { id: "path/src", requirement: "FP-042", op: "projectRelative", input: { file: "/Users/dev/proj/src/db/users.js" } },
  { id: "path/src-other-machine", requirement: "FP-042", op: "projectRelative", input: { file: "/srv/app/src/db/users.js" },
    note: "Must equal path/src. A first-match rule returns app/src/db/users.js here, because the deploy root IS the first project dir." },
  { id: "path/docker-root", requirement: "FP-042", op: "projectRelative", input: { file: "/app/src/db/users.js" },
    note: "Docker WORKDIR /app, the most common containerized layout there is, and the one a first-match rule breaks hardest." },
  { id: "path/lib", requirement: "FP-042", op: "projectRelative", input: { file: "/opt/x/lib/thing.py" } },
  { id: "path/routes", requirement: "FP-042", op: "projectRelative", input: { file: "/a/b/routes/users.rb" } },
  { id: "path/controllers", requirement: "FP-042", op: "projectRelative", input: { file: "/a/controllers/x.php" } },
  { id: "path/handlers", requirement: "FP-042", op: "projectRelative", input: { file: "/a/handlers/x.go" } },
  { id: "path/api", requirement: "FP-042", op: "projectRelative", input: { file: "/a/api/x.js" } },
  { id: "path/app", requirement: "FP-042", op: "projectRelative", input: { file: "/a/app/x.js" } },
  { id: "path/no-known-dir", requirement: "FP-042", op: "projectRelative", input: { file: "/opt/weird/place/thing.js" },
    note: "Falls back to the last two path components." },
  { id: "path/leftmost-wins", requirement: "FP-042", op: "projectRelative", input: { file: "/a/src/b/src/c.js" },
    note: "The LAST project-dir match wins. Collapsing further than a first-match rule is the accepted trade for machine independence." },
  { id: "path/bare-filename", requirement: "FP-042", op: "projectRelative", input: { file: "thing.js" } },
  { id: "path/single-segment", requirement: "FP-042", op: "projectRelative", input: { file: "/thing.js" } },

  // --- normalizeMessage ---
  { id: "msg/basic", requirement: "FP-020", op: "normalizeMessage", input: { message: "Cannot read property of undefined" } },
  { id: "msg/lowercases", requirement: "PRIM-020", op: "normalizeMessage", input: { message: "CANNOT READ PROPERTY" } },
  { id: "msg/strips-url", requirement: "FP-020", op: "normalizeMessage", input: { message: "failed calling https://api.example.com/v1/x?a=1 twice" } },
  { id: "msg/strips-email", requirement: "FP-020", op: "normalizeMessage", input: { message: "no account for jane.doe@example.com found" } },
  { id: "msg/strips-quoted", requirement: "FP-020", op: "normalizeMessage", input: { message: "column 'user_name' does not exist" } },
  { id: "msg/strips-double-quoted", requirement: "FP-020", op: "normalizeMessage", input: { message: 'column "user_name" does not exist' } },
  { id: "msg/strips-digit-words", requirement: "FP-021", op: "normalizeMessage", input: { message: "token sk_live_4242 rejected for user abc123" } },
  { id: "msg/digit-word-not-just-digit", requirement: "FP-021", op: "normalizeMessage", input: { message: "prefix abc123 suffix" },
    note: "The whole word goes, not just the digits. Otherwise 'abc' would survive and still influence the key." },
  { id: "msg/hyphenated-digit-word", requirement: "FP-021", op: "normalizeMessage", input: { message: "request id abc-123-def failed" } },
  { id: "msg/underscore-is-word-char", requirement: "PRIM-001", op: "normalizeMessage", input: { message: "user_123_name missing" } },
  { id: "msg/drops-short-tokens", requirement: "FP-020", op: "normalizeMessage", input: { message: "a bb c ddd e ffff" },
    note: "Tokens of length 1 are dropped." },
  { id: "msg/caps-at-six", requirement: "FP-020", op: "normalizeMessage", input: { message: "one two three four five six seven eight nine" } },
  { id: "msg/empty", requirement: "FP-022", op: "normalizeMessage", input: { message: "" } },
  { id: "msg/all-stripped", requirement: "FP-022", op: "normalizeMessage", input: { message: "42 7 1" } },
  { id: "msg/nbsp-whitespace", requirement: "PRIM-002", op: "normalizeMessage", input: { message: "failed to connect" },
    note: "NBSP is in WS. A port using ASCII-only \\s would treat it as punctuation instead, and while both routes happen to yield a space here, the class must still be right." },
  { id: "msg/unicode-word-chars-stripped", requirement: "PRIM-001", op: "normalizeMessage", input: { message: "erreur café serveur" },
    note: "WORD is ASCII-only. Python's default Unicode-aware \\w would keep the é and produce a different key." },
  { id: "msg/cjk-stripped", requirement: "PRIM-001", op: "normalizeMessage", input: { message: "接続 failed 完全に" } },
  { id: "msg/turkish-dotted-i", requirement: "PRIM-020", op: "normalizeMessage", input: { message: "İSTANBUL connection failed" },
    note: "Locale-independent lowercase. A Turkish-locale mapping would differ." },
  { id: "msg/final-sigma", requirement: "PRIM-021", op: "normalizeMessage",
    input: { message: "ΑΣ failed" },
    note: "DOES NOT DISCRIMINATE - kept as executable documentation. Greek is not in WORD, so step 6 strips both sigma forms to a space before either reaches a token. A Go driver without Final_Sigma passes this. See the PRIM-021 note." },
  { id: "msg/medial-sigma", requirement: "PRIM-021", op: "normalizeMessage",
    input: { message: "ΑΣΑ failed" },
    note: "Companion to msg/final-sigma, and equally non-discriminating. Both exist so that if a future change ever puts lowercased non-ASCII on the wire, these cases start failing loudly instead of silently diverging." },
  { id: "msg/eszett", requirement: "PRIM-020", op: "normalizeMessage", input: { message: "STRASSE ausfall" },
    note: "Simple lowercase, not full case folding: casefold would map ß to ss and change tokenization." },
  { id: "msg/emoji", requirement: "FP-020", op: "normalizeMessage", input: { message: "deploy 🚀 failed badly" } },
  { id: "msg/punctuation-collapse", requirement: "FP-020", op: "normalizeMessage", input: { message: "one...two,,,three!!!four" } },
  { id: "msg/hyphen-preserved", requirement: "FP-020", op: "normalizeMessage", input: { message: "not-found while resolving" },
    note: "Hyphen is neither WORD nor punctuation-to-strip; it survives inside a token." },
];

// ---------------------------------------------------------------------------
// request ids
// ---------------------------------------------------------------------------

export const REQUEST_ID_CASES: CaseDef[] = [
  { id: "reqid/format-with-prefix", requirement: "REQID-004", op: "formatRequestId",
    input: { rawId: "9f18a0e2-1c3d-4b5a-8e7f-0a1b2c3d4e5f", prefix: "TST" } },
  { id: "reqid/format-without-prefix", requirement: "REQID-004", op: "formatRequestId",
    input: { rawId: "9f18a0e2-1c3d-4b5a-8e7f-0a1b2c3d4e5f" } },
  { id: "reqid/strip", requirement: "REQID-005", op: "stripRequestIdPrefix",
    input: { requestId: "TST-9f18a0e2-1c3d-4b5a-8e7f-0a1b2c3d4e5f" } },
  { id: "reqid/strip-noop", requirement: "REQID-005", op: "stripRequestIdPrefix",
    input: { requestId: "9f18a0e2-1c3d-4b5a-8e7f-0a1b2c3d4e5f" } },
  { id: "reqid/strip-rejects-non-uuid-tail", requirement: "REQID-005", op: "stripRequestIdPrefix",
    input: { requestId: "TST-not-a-uuid" },
    note: "Group 1 must itself be a valid UUID, otherwise the input is returned untouched." },
  { id: "reqid/strip-rejects-long-prefix", requirement: "REQID-005", op: "stripRequestIdPrefix",
    input: { requestId: "TOOLONGP-9f18a0e2-1c3d-4b5a-8e7f-0a1b2c3d4e5f" },
    note: "Prefixes are 1 to 7 alphanumerics." },

  { id: "reqid/headers-fresh", requirement: "REQID-010", op: "requestIdHeaders",
    input: { ourId: "9f18a0e2-1c3d-4b5a-8e7f-0a1b2c3d4e5f", incomingHeaders: {}, hasApiKey: true } },
  { id: "reqid/headers-incoming-chain", requirement: "REQID-010", op: "requestIdHeaders",
    input: { ourId: "9f18a0e2-1c3d-4b5a-8e7f-0a1b2c3d4e5f", incomingHeaders: { "x-request-id": "upstream-value" }, hasApiKey: true },
    note: "An existing chain is never clobbered; we fall back to our own header name." },
  { id: "reqid/headers-with-prefix", requirement: "REQID-004", op: "requestIdHeaders",
    input: { ourId: "9f18a0e2-1c3d-4b5a-8e7f-0a1b2c3d4e5f", incomingHeaders: {}, prefix: "TST", hasApiKey: true } },
  { id: "reqid/headers-missing-key", requirement: "REQID-011", op: "requestIdHeaders",
    input: { ourId: "9f18a0e2-1c3d-4b5a-8e7f-0a1b2c3d4e5f", incomingHeaders: {}, hasApiKey: false } },
];

// ---------------------------------------------------------------------------
// recovery slug
// ---------------------------------------------------------------------------

export const RECOVERY_SLUG_CASES: CaseDef[] = [
  { id: "slug/basic", requirement: "INJECT-005", op: "recoverySlug", input: { method: "GET", path: "/car/{id}" } },
  { id: "slug/colon-style", requirement: "INJECT-005", op: "recoverySlug", input: { method: "GET", path: "/car/:id" } },
  { id: "slug/nested", requirement: "INJECT-005", op: "recoverySlug", input: { method: "DELETE", path: "/user/{id}/posts/{postId}" } },
  { id: "slug/root", requirement: "INJECT-005", op: "recoverySlug", input: { method: "GET", path: "/" } },
  { id: "slug/no-path", requirement: "INJECT-005", op: "recoverySlug", input: { method: "GET" } },
  { id: "slug/no-method", requirement: "INJECT-005", op: "recoverySlug", input: { path: "/car/{id}" } },
  { id: "slug/neither", requirement: "INJECT-005", op: "recoverySlug", input: {} },
  { id: "slug/strips-exotic-chars", requirement: "INJECT-005", op: "recoverySlug", input: { method: "POST", path: "/café/{id}.json" } },
  { id: "slug/collapses-dashes", requirement: "INJECT-005", op: "recoverySlug", input: { method: "GET", path: "///a///b///" } },
  { id: "slug/uppercase-method", requirement: "INJECT-005", op: "recoverySlug", input: { method: "PATCH", path: "/x" } },
];

// ---------------------------------------------------------------------------
// HAR
// ---------------------------------------------------------------------------

const HAR_BASE = {
  requestId: "9f18a0e2-1c3d-4b5a-8e7f-0a1b2c3d4e5f",
  startedAt: "2026-01-01T00:00:00.000Z",
  duration: 42,
};

export const HAR_CASES: CaseDef[] = [
  { id: "har/basic", requirement: "HAR-001", op: "harEntry",
    input: { captured: { ...HAR_BASE,
      request: { method: "POST", url: "http://host/p?q=1", headers: { "content-type": "application/json" }, body: '{"a":1}' },
      response: { status: 201, headers: { "content-type": "application/json" }, body: '{"ok":true}' } } } },
  { id: "har/no-bodies", requirement: "HAR-011", op: "harEntry",
    input: { captured: { ...HAR_BASE, duration: 0,
      request: { method: "GET", url: "http://host/", headers: {} },
      response: { status: 204, headers: {} } } },
    note: "bodySize is -1 on both sides when nothing was captured; content.size is 0." },
  { id: "har/empty-string-body", requirement: "HAR-011", op: "harEntry",
    input: { captured: { ...HAR_BASE,
      request: { method: "POST", url: "http://host/", headers: {}, body: "" },
      response: { status: 200, headers: {}, body: "" } } },
    note: "An empty body is not an absent body: sizes are 0, not -1." },
  { id: "har/multibyte-sizes", requirement: "HAR-010", op: "harEntry",
    input: { captured: { ...HAR_BASE,
      request: { method: "POST", url: "http://host/", headers: { "content-type": "application/json" }, body: '{"m":"日本語🚀"}' },
      response: { status: 200, headers: { "content-type": "application/json" }, body: '{"m":"café"}' } } },
    note: "Sizes are UTF-8 BYTES. The request body is 12 characters but 22 bytes." },
  { id: "har/no-response-content-type", requirement: "HAR-007", op: "harEntry",
    input: { captured: { ...HAR_BASE,
      request: { method: "GET", url: "http://host/", headers: {} },
      response: { status: 200, headers: {}, body: "raw" } } },
    note: "mimeType falls back to application/octet-stream." },
  { id: "har/query-string", requirement: "HAR-005", op: "harEntry",
    input: { captured: { ...HAR_BASE,
      request: { method: "GET", url: "http://host/p?a=1&b=two&a=3&empty=", headers: {} },
      response: { status: 200, headers: {} } } },
    note: "Repeated keys are preserved in order; values are percent-decoded." },
  { id: "har/relative-url", requirement: "HAR-005", op: "harEntry",
    input: { captured: { ...HAR_BASE,
      request: { method: "GET", url: "/p?a=1", headers: {} },
      response: { status: 200, headers: {} } } },
    note: "Query parsing must tolerate a relative URL." },
  { id: "har/route-pattern-carried", requirement: "HAR-001", op: "harEntry",
    input: { captured: { ...HAR_BASE, routePattern: "/car/{id}",
      request: { method: "GET", url: "http://host/car/7", headers: {} },
      response: { status: 200, headers: {} } } } },
];

export const ALL_FILES: Array<{ file: string; cases: CaseDef[] }> = [
  { file: "mask.json", cases: MASK_CASES },
  { file: "redact.json", cases: REDACT_CASES },
  { file: "fingerprint.json", cases: FINGERPRINT_CASES },
  { file: "request-id.json", cases: REQUEST_ID_CASES },
  { file: "recovery-slug.json", cases: RECOVERY_SLUG_CASES },
  { file: "har.json", cases: HAR_CASES },
];

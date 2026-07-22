#!/usr/bin/env node
/**
 * End-to-end check for the withRestless single-config integration.
 *
 * Usage (from this directory, after `npm install` here and `npm run build`
 * at the repo root):
 *
 *     node e2e.mjs              # Turbopack build (Next 16 default)
 *     node e2e.mjs --webpack    # webpack build
 *
 * Builds the fixture app, boots a mock ingress + `next start`, curls the
 * routes, and asserts: wrapped routes stamp x-request-id and upload HAR
 * entries attributed to the owner from restless.config.ts; error routes get
 * the debug injection; static and edge routes stay untouched.
 */
import { spawn, execSync } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const useWebpack = process.argv.includes("--webpack");
const APP_PORT = 4310 + (useWebpack ? 1 : 0);

const failures = [];
function check(label, cond, detail = "") {
  if (cond) console.log(`  ok  ${label}`);
  else {
    console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
    failures.push(label);
  }
}

// --- mock ingress -----------------------------------------------------------
const received = [];
const ingress = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    try {
      received.push(...JSON.parse(body));
    } catch {
      /* ignore */
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ingested: 1 }));
  });
});
await new Promise((r) => ingress.listen(0, "127.0.0.1", r));
const ingressUrl = `http://127.0.0.1:${ingress.address().port}`;

const env = {
  ...process.env,
  RESTLESS_KEY: "rdme_e2e_fixture",
  RESTLESS_BASE_URL: ingressUrl,
  NODE_ENV: "production",
};

// --- build ------------------------------------------------------------------
console.log(`building (${useWebpack ? "webpack" : "turbopack"})...`);
execSync(`npx next build${useWebpack ? " --webpack" : ""}`, {
  cwd: dir,
  env,
  stdio: "inherit",
});

// --- start ------------------------------------------------------------------
const server = spawn("npx", ["next", "start", "-p", String(APP_PORT)], {
  cwd: dir,
  env,
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout.on("data", (c) => (serverLog += c));
server.stderr.on("data", (c) => (serverLog += c));

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      await fetch(`http://127.0.0.1:${APP_PORT}/`);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error(`next start never came up:\n${serverLog}`);
}

try {
  await waitForServer();
  const base = `http://127.0.0.1:${APP_PORT}`;

  // Wrapped GET: headers stamped, body intact.
  const hello = await fetch(`${base}/api/hello`, {
    headers: { "x-api-key": "user-key-1234", "x-workspace": "ws_42" },
  });
  check("GET /api/hello 200", hello.status === 200);
  check(
    "GET /api/hello has x-request-id",
    /^[0-9a-f-]{36}$/.test(hello.headers.get("x-request-id") || ""),
    `got ${hello.headers.get("x-request-id")}`,
  );
  const helloBody = await hello.json();
  check(
    "GET /api/hello body intact",
    helloBody.ok === true && helloBody.path === "/api/hello",
    JSON.stringify(helloBody),
  );

  // Wrapped POST: request body flows to the handler and into the capture.
  const post = await fetch(`${base}/api/hello`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-workspace": "ws_42" },
    body: JSON.stringify({ hi: "there" }),
  });
  check("POST /api/hello 201", post.status === 201);
  check(
    "POST /api/hello echoed body",
    (await post.json()).echoed?.hi === "there",
  );

  // Error route: debug injection.
  const missing = await fetch(`${base}/api/missing`);
  check("GET /api/missing 404", missing.status === 404);
  check(
    "404 has x-log-url",
    (missing.headers.get("x-log-url") || "").includes("/logs/"),
  );
  const missingBody = await missing.json();
  check(
    "404 body has debug block",
    typeof missingBody.debug?.log === "string" &&
      typeof missingBody.debug?.recovery === "string",
    JSON.stringify(missingBody),
  );
  check("404 original body intact", missingBody.error === "no such widget");

  // Static route: prerendered, no injected headers.
  const stat = await fetch(`${base}/api/static`);
  check("GET /api/static 200", stat.status === 200);
  check(
    "static route has NO x-request-id (build-phase guard)",
    stat.headers.get("x-request-id") === null &&
      stat.headers.get("x-restless-id") === null,
  );
  check("static body intact", (await stat.json()).static === true);

  // Edge route: skipped by the loader, serves fine, uncaptured.
  const edge = await fetch(`${base}/api/edge`);
  check("GET /api/edge 200", edge.status === 200);
  check(
    "edge route has NO x-request-id (loader skip)",
    edge.headers.get("x-request-id") === null,
  );

  // Uploads: localhost ingress flushes immediately; allow a beat.
  await new Promise((r) => setTimeout(r, 1500));
  const urls = received.map(
    (e) => `${e.request.log.entries[0].request.method} ${new URL(e.request.log.entries[0].request.url).pathname}`,
  );
  check(
    "ingress got GET /api/hello",
    urls.includes("GET /api/hello"),
    urls.join(", "),
  );
  check("ingress got POST /api/hello", urls.includes("POST /api/hello"));
  check("ingress got GET /api/missing", urls.includes("GET /api/missing"));
  check(
    "ingress did NOT get static or edge",
    !urls.some((u) => u.includes("/api/static") || u.includes("/api/edge")),
    urls.join(", "),
  );
  const helloEntry = received.find(
    (e) => e.request.log.entries[0].request.method === "GET" &&
      e.request.log.entries[0].request.url.includes("/api/hello"),
  );
  check(
    "owner attributed from restless.config setup",
    helloEntry?.group?.id === "ws_42",
    JSON.stringify(helloEntry?.group),
  );
  check(
    "end-user api key masked, not plaintext",
    typeof helloEntry?.apiKey === "string" &&
      helloEntry.apiKey.startsWith("sha512-") &&
      !JSON.stringify(helloEntry).includes("user-key-1234"),
    helloEntry?.apiKey,
  );
  const missingEntry = received.find((e) =>
    e.request.log.entries[0].request.url.includes("/api/missing"),
  );
  check(
    "404 capture has an error fingerprint",
    typeof missingEntry?.errorFingerprint?.key === "string",
    JSON.stringify(missingEntry?.errorFingerprint),
  );
} finally {
  server.kill("SIGTERM");
  ingress.close();
}

console.log(
  failures.length
    ? `\n${failures.length} FAILED (${useWebpack ? "webpack" : "turbopack"})`
    : `\nall checks passed (${useWebpack ? "webpack" : "turbopack"})`,
);
process.exit(failures.length ? 1 : 0);

// Shared driver plumbing: spawn a conformance driver as a subprocess and
// speak the JSON Lines protocol in spec/driver/PROTOCOL.md to it.
//
// Used by run-vectors.mjs and fuzz.mjs. Deliberately dependency-free so a
// port's CI can run it with nothing but Node installed.

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export class Driver {
  #proc;
  #pending = new Map();
  #nextId = 0;
  #exited = null;

  /**
   * @param {string[]} argv command + args, e.g. ["python", "-m", "restless._conformance"]
   * @param {{cwd?: string}} [opts]
   */
  constructor(argv, opts = {}) {
    const [cmd, ...args] = argv;
    this.command = argv.join(" ");
    this.#proc = spawn(cmd, args, {
      cwd: opts.cwd,
      stdio: ["pipe", "pipe", "inherit"],
    });

    this.#proc.on("error", (err) => {
      this.#failAll(new Error(`could not start driver \`${this.command}\`: ${err.message}`));
    });
    this.#proc.on("exit", (code, signal) => {
      this.#exited = { code, signal };
      this.#failAll(
        new Error(
          `driver \`${this.command}\` exited (code=${code} signal=${signal}) with ${this.#pending.size} request(s) in flight`,
        ),
      );
    });

    createInterface({ input: this.#proc.stdout, terminal: false }).on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let msg;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        // A driver writing non-JSON to stdout is a protocol violation, but
        // the most common cause is a stray print() during development, so
        // say so clearly instead of hanging.
        process.stderr.write(
          `[harness] non-JSON on stdout from \`${this.command}\`: ${trimmed.slice(0, 200)}\n`,
        );
        return;
      }
      const key = String(msg.id);
      const resolve = this.#pending.get(key);
      if (!resolve) return;
      this.#pending.delete(key);
      resolve(msg);
    });
  }

  #failAll(err) {
    for (const [, resolve] of this.#pending) resolve({ error: err.message, __transport: true });
    this.#pending.clear();
  }

  /**
   * Send one op. Resolves to `{result}` or `{error}` - never rejects, so a
   * driver that dies mid-run produces a readable report instead of an
   * unhandled rejection.
   */
  send(op, input) {
    if (this.#exited) {
      return Promise.resolve({
        error: `driver already exited (code=${this.#exited.code})`,
        __transport: true,
      });
    }
    const id = String(this.#nextId++);
    return new Promise((resolve) => {
      this.#pending.set(id, resolve);
      this.#proc.stdin.write(JSON.stringify({ id, op, input }) + "\n");
    });
  }

  async close() {
    if (this.#exited) return;
    this.#proc.stdin.end();
    await new Promise((r) => {
      if (this.#exited) return r();
      this.#proc.on("exit", r);
      setTimeout(() => {
        this.#proc.kill();
        r();
      }, 5000);
    });
  }
}

/**
 * Split argv on a `--` separator: everything after it is the driver
 * command. Falls back to a named flag (`--ref`, `--test`) holding a single
 * shell-ish string.
 */
export function parseDriverArg(argv, flag) {
  if (flag) {
    const i = argv.indexOf(flag);
    if (i !== -1 && argv[i + 1]) return argv[i + 1].split(/\s+/).filter(Boolean);
    return null;
  }
  const i = argv.indexOf("--");
  if (i !== -1) return argv.slice(i + 1);
  return null;
}

/** Structural deep-equal. Objects compare key-insensitive to order. */
export function deepEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object") return Number.isNaN(a) && Number.isNaN(b);
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
}

/**
 * Compare per the case's `compare` mode.
 *
 * "json" exists for redaction outputs that had to be re-serialized: both
 * sides are JSON *strings*, and an implementation whose encoder differs in
 * key order should not be failed for that alone (CONTRACT.md PRIM-031 asks
 * for insertion order, but Go needs an order-preserving type to comply and
 * a port may land that later).
 */
export function compareResult(mode, actual, expected) {
  if (mode !== "json") return deepEqual(actual, expected);
  if (typeof actual !== "string" || typeof expected !== "string") {
    return deepEqual(actual, expected);
  }
  try {
    return deepEqual(JSON.parse(actual), JSON.parse(expected));
  } catch {
    return actual === expected;
  }
}

/**
 * Node conformance driver. See spec/driver/PROTOCOL.md.
 *
 * Dev-only: never published, never imported by customer code. Built with
 * `npm run spec:driver` into `spec/driver/.build/` (gitignored).
 *
 * The body is deliberately trivial - a JSON Lines loop around
 * `spec/ops.ts`, the same operation table the vector generator uses. A
 * driver that reimplemented anything would be testing itself instead of
 * the SDK.
 */

import { createInterface } from "node:readline";
import { runOp } from "../ops.js";

const rl = createInterface({ input: process.stdin, terminal: false });

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let id: unknown = null;
  try {
    const req = JSON.parse(trimmed) as {
      id: unknown;
      op: string;
      input?: Record<string, unknown>;
    };
    id = req.id;
    const result = runOp(req.op, req.input ?? {});
    process.stdout.write(JSON.stringify({ id, result }) + "\n");
  } catch (err) {
    process.stdout.write(
      JSON.stringify({
        id,
        error: err instanceof Error ? err.message : String(err),
      }) + "\n",
    );
  }
});

rl.on("close", () => process.exit(0));

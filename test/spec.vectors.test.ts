import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ALL_FILES, type CaseDef } from "../spec/cases.js";
import { runOp } from "../spec/ops.js";
import { SPEC_VERSION } from "../src/lib/version.js";

/**
 * Generates `spec/vectors/*.json` from the Node implementation, or asserts
 * that the committed vectors still match it.
 *
 *   npm run spec:vectors   -> UPDATE_VECTORS=1, rewrites the files
 *   npm test               -> asserts, failing with the specific case
 *
 * This IS the drift guard. A behaviour change in `src/lib/` that nobody
 * intended shows up as a failing case here with a readable before/after,
 * rather than as a silent divergence discovered months later when a port
 * disagrees with the ingest. When the change IS intended, regenerate,
 * review the diff as the contract change it is, and bump the spec version
 * (CONTRACT.md CHANGE-001).
 */

/** The version the generator stamps into every vector file. */
const SPEC_VERSION_IN_VECTORS = "1.0.0";
const HERE = dirname(fileURLToPath(import.meta.url));
const VECTOR_DIR = join(HERE, "..", "spec", "vectors");
const UPDATE = process.env.UPDATE_VECTORS === "1";

interface Vector {
  id: string;
  requirement: string;
  op: string;
  input: unknown;
  expected: unknown;
  compare?: "exact" | "json";
  note?: string;
}

function build(cases: CaseDef[]): Vector[] {
  return cases.map((c) => {
    const v: Vector = {
      id: c.id,
      requirement: c.requirement,
      op: c.op,
      input: c.input,
      expected: runOp(c.op, c.input),
    };
    if (c.compare) v.compare = c.compare;
    if (c.note) v.note = c.note;
    return v;
  });
}

function serialize(cases: Vector[]): string {
  return (
    JSON.stringify(
      {
        $generated:
          "GENERATED FILE - do not edit by hand. Inputs live in spec/cases.ts; run `npm run spec:vectors` to regenerate.",
        $contract: "spec/CONTRACT.md",
        specVersion: SPEC_VERSION_IN_VECTORS,
        cases,
      },
      null,
      2,
    ) + "\n"
  );
}

describe("spec vectors", () => {
  if (UPDATE && !existsSync(VECTOR_DIR)) mkdirSync(VECTOR_DIR, { recursive: true });

  for (const { file, cases } of ALL_FILES) {
    const path = join(VECTOR_DIR, file);

    it(`${file} matches the reference implementation`, () => {
      const generated = serialize(build(cases));

      if (UPDATE) {
        writeFileSync(path, generated);
        return;
      }

      expect(
        existsSync(path),
        `${file} is missing - run \`npm run spec:vectors\``,
      ).toBe(true);

      const committed = readFileSync(path, "utf8");
      if (committed === generated) return;

      // Same content, different formatting is still a failure (the file is
      // generated), but a per-case diff is far more useful than a whole-file
      // one, so surface the first case that actually disagrees.
      const a = JSON.parse(committed).cases as Vector[];
      const b = JSON.parse(generated).cases as Vector[];
      const byId = new Map(a.map((c) => [c.id, c]));
      for (const actual of b) {
        const expectedCase = byId.get(actual.id);
        expect(
          expectedCase,
          `${file}: case "${actual.id}" is new - run \`npm run spec:vectors\``,
        ).toBeDefined();
        expect(
          actual.expected,
          `${file}: case "${actual.id}" (${actual.requirement}) changed. ` +
            `If intentional this is a CONTRACT change: regenerate with ` +
            `\`npm run spec:vectors\`, review the diff, bump the spec version.`,
        ).toEqual(expectedCase!.expected);
      }
      const generatedIds = new Set(b.map((c) => c.id));
      const removed = a.filter((c) => !generatedIds.has(c.id)).map((c) => c.id);
      expect(removed, `${file}: cases removed - run \`npm run spec:vectors\``).toEqual([]);

      // Contents agree case-by-case, so the difference is ordering or
      // formatting. Still regenerate: the file is a build artifact.
      expect(committed, `${file}: formatting drift - run \`npm run spec:vectors\``).toBe(
        generated,
      );
    });
  }

  it("every case id is unique across all vector files", () => {
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const { cases } of ALL_FILES) {
      for (const c of cases) {
        if (seen.has(c.id)) dupes.push(c.id);
        seen.add(c.id);
      }
    }
    expect(dupes).toEqual([]);
  });

  it("every case names a requirement that exists in CONTRACT.md", () => {
    const contract = readFileSync(join(HERE, "..", "spec", "CONTRACT.md"), "utf8");
    const missing: string[] = [];
    for (const { cases } of ALL_FILES) {
      for (const c of cases) {
        if (!contract.includes(`**${c.requirement}**`)) {
          missing.push(`${c.id} -> ${c.requirement}`);
        }
      }
    }
    expect(
      missing,
      "these cases reference requirement IDs that are not defined in the contract",
    ).toEqual([]);
  });
});

describe("spec version", () => {
  it("src/lib/version.ts agrees with CONTRACT.md and the vectors", () => {
    // These three drifted apart once already during development: the
    // contract and vectors moved while the constant the SDK actually PUTS ON
    // THE WIRE did not, so every upload would have misreported which contract
    // it implements. That is precisely the attribution META-002 exists to give
    // the ingest, so a stale constant is worse than none.
    const contract = readFileSync(join(HERE, "..", "spec", "CONTRACT.md"), "utf8");
    const declared = contract.match(/\*\*Spec version:\*\*\s*(\S+)/)?.[1];
    expect(declared, "CONTRACT.md has no parseable **Spec version:** line").toBeDefined();
    expect(SPEC_VERSION, "src/lib/version.ts is out of step with CONTRACT.md").toBe(declared);
    expect(SPEC_VERSION, "the generator writes a different version into the vectors").toBe(
      SPEC_VERSION_IN_VECTORS,
    );
  });
});

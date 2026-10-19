import { describe, it, expect } from "vitest";
import {
  normalizeSampling,
  resolveMode,
  decide,
  samplingHash,
  canonicalSampling,
} from "../src/lib/sampling.js";

// The observable behaviour is pinned by spec/vectors/sampling.json. These
// cover what the vectors deliberately leave out: the debug warnings, which
// are not contract surface, and never raising on hostile input.

describe("normalizeSampling warnings", () => {
  it("names every key and mode it rejected, and the source it came from", () => {
    const { warnings } = normalizeSampling(
      { routes: { "/no-method": "off" } },
      { default: "sometimes", routes: { "GET /a": 2 } },
    );
    expect(warnings).toHaveLength(3);
    expect(warnings[0]).toMatch(/settings.*"\/no-method"/);
    expect(warnings[1]).toMatch(/default \(code\).*"sometimes".*"on"/);
    expect(warnings[2]).toMatch(/"GET \/a".*code.*2/);
  });

  it("is silent for a valid config", () => {
    const { warnings } = normalizeSampling(undefined, {
      default: 0.5,
      routes: { "GET /health": "off", "* /pets/:id": "errors" },
    });
    expect(warnings).toEqual([]);
  });
});

describe("never raises (SAMPLE-003, SAMPLE-012, SAMPLE-014)", () => {
  const hostile: unknown[] = [
    0,
    "off",
    true,
    [],
    [["GET /a", "off"]],
    { default: {} },
    { routes: [] },
    { routes: { "GET /a": { nested: true } } },
    { routes: { "GET /a": Number.NaN, "GET /b": Infinity } },
    Object.create(null),
  ];

  for (const input of hostile) {
    it(`degrades ${JSON.stringify(input) ?? String(input)} to sending everything`, () => {
      const { config } = normalizeSampling(input, input);
      expect(() => samplingHash(config)).not.toThrow();
      const mode = resolveMode(config, "GET", "/a");
      expect(decide(mode, 200, 0.99)).toBe("full");
    });
  }
});

describe("rate tokens (SAMPLE-002, SAMPLE-040)", () => {
  // The token is re-derived from the quantized float, which must give back
  // exactly the integer k it came from for every reachable rate.
  it("round-trips every k in 0..9999", () => {
    for (let k = 0; k < 10000; k++) {
      const { config } = normalizeSampling(undefined, { default: k / 10000 });
      const line = `default\t0.${String(k).padStart(4, "0")}\n`;
      expect(canonicalSampling(config)).toBe(line);
    }
  });
});

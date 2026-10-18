// Real approval cards, sanitized, with the tier and card text they must get.
// The approval review loop (docs/approval-review/RUNBOOK.md) adds a line for
// every card it fixes, so a later change can't quietly undo the fix.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { classify } from "../src/classify.js";
import { describeFields } from "../src/describe.js";

interface CorpusCase {
  id: string;
  source: string;
  tool: string;
  input: Record<string, unknown>;
  tier: string;
  fields: Record<string, string>;
}

const file = fileURLToPath(new URL("./fixtures/approval-corpus.jsonl", import.meta.url));
const cases: CorpusCase[] = readFileSync(file, "utf8")
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l));

describe("approval corpus", () => {
  it("has unique ids", () => {
    assert.equal(new Set(cases.map((c) => c.id)).size, cases.length);
  });

  for (const c of cases) {
    it(`${c.id}: tier`, () => {
      assert.equal(classify(c.tool, c.input), c.tier);
    });
    it(`${c.id}: card`, () => {
      assert.deepEqual(describeFields(c.tool, c.input), c.fields);
    });
  }
});

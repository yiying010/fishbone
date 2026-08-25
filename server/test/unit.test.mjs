import assert from "node:assert/strict";
import test from "node:test";

import { normalizeMemberId, normalizeRoomCode } from "../../build/rooms/store.js";
import { assertSnapshot, clampRound, readItems, readSources, readVotes } from "../../build/domain/snapshot.js";

const NUL = String.fromCharCode(0);

test("room codes are normalized, not rejected, for the ways students type them", () => {
  assert.equal(normalizeRoomCode("  FISH-042  ", 64), "FISH-042");
  assert.equal(normalizeRoomCode("FISH   042", 64), "FISH 042");
  assert.throws(() => normalizeRoomCode("   ", 64), /must not be empty/);
  assert.throws(() => normalizeRoomCode("x".repeat(65), 64), /at most 64/);
  assert.throws(() => normalizeRoomCode(`FISH${NUL}042`, 64), /control characters/);
  assert.throws(() => normalizeRoomCode(42, 64), /must be a string/);
  // These survive encodeURIComponent but not the proxy in front of the service,
  // and would surface as an unexplained 404 rather than a usable message.
  for (const bad of ["A/B", "A\\B", "A%B", "A?B", "A#B"]) {
    assert.throws(() => normalizeRoomCode(bad, 64), /must not contain/, `${bad} should be rejected`);
  }
});

test("member ids are required and bounded", () => {
  assert.equal(normalizeMemberId(" u-1 "), "u-1");
  assert.throws(() => normalizeMemberId(""), /must not be empty/);
  assert.throws(() => normalizeMemberId("u".repeat(129)), /at most 128/);
});

test("a payload that is not a room snapshot is refused", () => {
  assert.throws(() => assertSnapshot(null, 1000), /must be a JSON object/);
  assert.throws(() => assertSnapshot([], 1000), /must be a JSON object/);
  assert.throws(() => assertSnapshot({}, 1000), /missing the sources array/);
  assert.throws(() => assertSnapshot({ sources: [], pad: "x".repeat(2000) }, 1000), /limit is 1000/);
});

test("U+0000 is stripped so a pasted NUL cannot wedge a room on a jsonb error", () => {
  const cleaned = assertSnapshot(
    { sources: [{ id: "u1", name: `小安${NUL}` }], distresses: [{ id: "d1", text: `a${NUL}b` }] },
    100_000,
  );
  assert.equal(cleaned.sources[0].name, "小安");
  assert.equal(cleaned.distresses[0].text, "ab");
  assert.ok(!JSON.stringify(cleaned).includes("\\u0000"));
});

test("sources become members, keeping the system rows flagged", () => {
  const sources = readSources({
    sources: [
      { id: "u1", name: "小安", color: "#276EF1", system: false, joined: true },
      { id: "group", name: "小組提出", color: "#46515f", system: true, joined: true },
      { name: "no id is dropped" },
    ],
  });
  assert.deepEqual(sources.map((s) => s.id), ["u1", "group"]);
  assert.equal(sources[0].system, false);
  assert.equal(sources[1].system, true);
});

test("card attribution prefers createdBy and keeps the rest as payload", () => {
  const items = readItems(
    { causes: [{ id: "c1", text: "太晚睡", source: "u9", createdBy: "u1", status: "待確認", aiGuess: "原因" }] },
    "causes",
  );
  assert.equal(items[0].author, "u1");
  assert.equal(items[0].status, "待確認");
  assert.deepEqual(items[0].payload, { aiGuess: "原因" });
});

test("round numbers are clamped so one payload cannot abort every later write", () => {
  assert.equal(clampRound(3, 1), 3);
  assert.equal(clampRound(0, 7), 7);
  assert.equal(clampRound(-5, 7), 7);
  assert.equal(clampRound("nonsense", 7), 7);
  // Beyond int range: would otherwise abort the votes insert, and with it the
  // transaction that carries the room's revision bump.
  assert.equal(clampRound(1e10, 1), 1_000_000);
});

test("both ballot shapes are read, and a stale round is kept as its own round", () => {
  const votes = readVotes(
    {
      groupingRound: 3,
      groupingVotes: {
        u1: { value: "gp-1", round: 3 },
        u2: { value: "gp-2", round: 2 },
        u3: "gp-1",
        u4: { value: "", round: 3 },
      },
    },
    "groupingVotes",
    "groupingRound",
  );
  assert.deepEqual(
    votes.sort((a, b) => a.memberId.localeCompare(b.memberId)),
    [
      { memberId: "u1", value: "gp-1", round: 3 },
      { memberId: "u2", value: "gp-2", round: 2 },
      // a bare value belongs to the map's current round
      { memberId: "u3", value: "gp-1", round: 3 },
    ],
  );
});

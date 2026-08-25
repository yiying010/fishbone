import assert from "node:assert/strict";
import test from "node:test";

import { normalizeMemberId } from "../../build/rooms/store.js";
import {
  DEFAULT_CODE_LENGTH,
  MIN_CODE_LENGTH,
  formatRoomCode,
  generateRoomCode,
  normalizeAdminRoomCode,
  normalizeRoomCode,
} from "../../build/rooms/codes.js";
import { RateLimiter } from "../../build/rate-limit.js";
import { assertSnapshot, clampRound, readItems, readSources, readVotes } from "../../build/domain/snapshot.js";

const NUL = String.fromCharCode(0);

test("generated codes are drawn from an alphabet with nothing to misread", () => {
  const code = generateRoomCode();
  assert.equal(code.length, DEFAULT_CODE_LENGTH);
  // Crockford Base32, lower case: no i, l, o or u.
  assert.match(code, /^[0-9abcdefghjkmnpqrstvwxyz]+$/);
  assert.doesNotMatch(code, /[ilou]/);

  // Not a uniqueness proof, but a generator stuck on one value would show here.
  const many = new Set(Array.from({ length: 500 }, () => generateRoomCode()));
  assert.equal(many.size, 500);

  assert.throws(() => generateRoomCode(MIN_CODE_LENGTH - 1), RangeError);
});

test("a code is accepted however a student types it", () => {
  const code = "k7m2x9qpwd";
  assert.equal(normalizeRoomCode(code), code);
  assert.equal(normalizeRoomCode("K7M2X-9QPWD"), code);
  assert.equal(normalizeRoomCode(" k7m2x - 9qpwd "), code);
  assert.equal(formatRoomCode(code), "k7m2x-9qpwd");

  // Crockford's aliases: the characters that are not in the alphabet are
  // exactly the ones people misread, and they map back onto what they meant.
  assert.equal(normalizeRoomCode("O123456789"), "0123456789");
  assert.equal(normalizeRoomCode("Il23456789"), "1123456789");

  // Anything that cannot be a code is refused before it reaches the database.
  assert.throws(() => normalizeRoomCode("六年三班"), /unusable character/);
  assert.throws(() => normalizeRoomCode("fish01"), /between 8 and 24/);
  assert.throws(() => normalizeRoomCode(""), /between 8 and 24/);
  assert.throws(() => normalizeRoomCode(`k7m2x${NUL}9qpwd`), /unusable character/);
  assert.throws(() => normalizeRoomCode("a/b/c/d/e/f"), /unusable character/);
  assert.throws(() => normalizeRoomCode(42), /must be a string/);
});

test("admin lookups still resolve codes that predate this scheme", () => {
  // Those rooms cannot be joined any more; being able to export them before
  // the retention sweep removes them is the point.
  assert.equal(normalizeAdminRoomCode("FISH-042"), "FISH-042");
  assert.equal(normalizeAdminRoomCode(" 六年三班 "), "六年三班");
  assert.equal(normalizeAdminRoomCode("k7m2x9qpwd"), "k7m2x9qpwd");
  assert.throws(() => normalizeAdminRoomCode(""), /between 1 and 128/);
  assert.throws(() => normalizeAdminRoomCode(`a${NUL}b`), /control characters/);
  assert.throws(() => normalizeAdminRoomCode(42), /must be a string/);
});

test("the rate limiter refills over time and keeps addresses apart", () => {
  const limiter = new RateLimiter({ capacity: 3, refillPeriodMs: 60_000 });
  const start = 1_000_000;

  assert.deepEqual(
    [0, 1, 2, 3].map((n) => limiter.take("a", start + n).allowed),
    [true, true, true, false],
  );
  // A second address has its own budget: one school NAT must not be able to
  // spend another site's allowance, and vice versa.
  assert.equal(limiter.take("b", start).allowed, true);

  // Empty means empty, and the 429 has to say when to come back.
  const refused = limiter.take("a", start);
  assert.equal(refused.allowed, false);
  assert.ok(refused.retryAfterSeconds >= 1);

  // One third of the period restores one token.
  assert.equal(limiter.take("a", start + 20_000).allowed, true);
  assert.equal(limiter.take("a", start + 20_000).allowed, false);

  // peek reports without spending.
  const before = limiter.peek("b", start).remaining;
  limiter.peek("b", start);
  assert.equal(limiter.peek("b", start).remaining, before);
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

test("ids that reach a primary key are capped, and a long one does not wedge the room", () => {
  // A btree index row tops out near 2704 bytes, but a 3 KB id fits easily
  // inside the 1 MB snapshot budget. Uncapped, the projection insert fails,
  // the whole write transaction rolls back, the revision never advances, and
  // the device retries the same payload forever. Truncating keeps one
  // malformed payload from locking a student out of syncing their work.
  const huge = "x".repeat(3000);

  const [source] = readSources({ sources: [{ id: huge, name: huge }] });
  assert.equal(source.id.length, 200);
  assert.equal(source.name.length, 200);

  const [item] = readItems({ distresses: [{ id: huge, text: "keep the text", createdBy: huge }] }, "distresses");
  assert.equal(item.id.length, 200);
  assert.equal(item.author.length, 200);
  // Only key columns are capped: card text is an unindexed column and the
  // student's actual writing must survive intact.
  assert.equal(item.text, "keep the text");

  const [vote] = readVotes({ problemVotes: { [huge]: huge } }, "problemVotes", null);
  assert.equal(vote.memberId.length, 200);
  assert.equal(vote.value.length, 200);
});

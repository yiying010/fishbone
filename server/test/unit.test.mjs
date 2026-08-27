import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";

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
import {
  AiProviderError,
  AiRateLimitError,
  AiRequestError,
  AiReviewService,
  OpenAiReviewClient,
  extractAiInput,
} from "../../build/ai/review.js";
import { registerRoomRoutes } from "../../build/routes/rooms.js";

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

test("snapshot identifiers and colors cannot become executable DOM attributes", () => {
  assert.throws(
    () => assertSnapshot({ sources: [{ id: "u1\" onclick=alert(1)", name: "x" }] }, 100_000),
    /letters, digits, _ or -/,
  );
  assert.throws(
    () => assertSnapshot({ sources: [{ id: "u1", color: "red\" onmouseenter=alert(1)" }] }, 100_000),
    /#RRGGBB/,
  );
  assert.throws(
    () => assertSnapshot({ sources: [{ id: "u1" }], groupingVotes: { "u1\" onclick=alert(1)": "p1" } }, 100_000),
    /letters, digits, _ or -/,
  );
});

test("a field name that carries both an id list and an object list is checked as each", () => {
  // `causes` is cause cards at the top level and cause ids on a method card.
  const accepted = assertSnapshot({
    sources: [{ id: "u1", name: "小安" }],
    causes: [{ id: "c1", text: "沒有記錄習慣", createdBy: "u1" }],
    methods: [{ id: "m1", text: "設提醒", causes: ["c1"] }],
  }, 100_000);
  assert.equal(accepted.causes[0].id, "c1");
  assert.throws(
    () => assertSnapshot({
      sources: [{ id: "u1" }],
      methods: [{ id: "m1", causes: ["c1' onclick=alert(1)"] }],
    }, 100_000),
    /letters, digits, _ or -/,
  );
  assert.throws(
    () => assertSnapshot({ sources: [{ id: "u1" }], causes: [{ id: "c1\" onclick=alert(1)" }] }, 100_000),
    /letters, digits, _ or -/,
  );
});

test("excessive snapshot nesting is refused before serialization can exhaust the stack", () => {
  const snapshot = { sources: [] };
  let cursor = snapshot;
  for (let depth = 0; depth < 65; depth += 1) {
    cursor.nested = {};
    cursor = cursor.nested;
  }
  assert.throws(() => assertSnapshot(snapshot, 100_000), /nested too deeply/);
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

test("AI inputs are selected from authoritative state and omit identity fields", () => {
  const snapshot = {
    sources: [{ id: "u1", name: "學生真名", joined: true }],
    selected: "小組作業常常無法準時完成",
    problem: "小組作業常常無法準時完成。",
    problemDetails: [{ id: "pd1", text: "同時有很多報告", createdBy: "u1" }],
    causes: [
      { id: "c1", text: "沒有先整理截止日期", createdBy: "u1", status: "已確認為原因", catId: "cat1" },
      { id: "c2", text: "先列出所有期限", createdBy: "u2", status: "待確認" },
    ],
    cats: [{ id: "cat1", name: "期限整理" }],
    goal: "建立清楚的作業安排，減少遲交。",
    goalIdeas: [{ id: "g1", text: "希望先知道哪些作業快到期", createdBy: "u1", priority: ["c1"] }],
    methods: [
      { id: "m1", text: "每天放學後整理作業期限", createdBy: "u1", status: "正式方法", causes: ["c1"], effect: "讓小組提早知道到期順序", big: "期限管理" },
    ],
    feasible: "m1",
    feasibleReason: "每天都能做到",
    unique: "m1",
    uniqueReason: "把期限集中整理",
    reflections: [{ id: "r1", text: "魚骨圖讓我看見沒有整理期限是重要原因", createdBy: "u1" }],
  };

  const step5 = extractAiInput("step5_problem", undefined, snapshot, "u1", 12_000);
  assert.deepEqual(step5.content, {
    selected_problem: snapshot.selected,
    clarifications: ["同時有很多報告"],
  });

  const step8 = extractAiInput("step8_cause", "c1", snapshot, "u1", 12_000);
  assert.deepEqual(step8.content, {
    confirmed_problem: snapshot.problem,
    cause_card: "沒有先整理截止日期",
  });
  assert.throws(
    () => extractAiInput("step8_cause", "c2", snapshot, "u1", 12_000),
    (error) => error instanceof AiRequestError && error.code === "ai_item_forbidden",
  );

  const step11 = extractAiInput("step11_goal", undefined, snapshot, "u1", 12_000);
  assert.deepEqual(step11.content.priority_causes, ["沒有先整理截止日期"]);

  const step14 = extractAiInput("step14_method", "m1", snapshot, "u1", 12_000);
  assert.deepEqual(step14.content.linked_causes, ["沒有先整理截止日期"]);
  assert.equal(step14.content.confirmed_goal, snapshot.goal);

  const step19 = extractAiInput("step19_reflection", undefined, snapshot, "u1", 12_000);
  const serialized = JSON.stringify(step19);
  assert.doesNotMatch(serialized, /學生真名|"u1"|"createdBy"|"sources"/);
  assert.deepEqual(step19.content.reflections, [
    { label: "Reflection 1", text: "魚骨圖讓我看見沒有整理期限是重要原因" },
  ]);
});

test("card ownership falls back to source when createdBy is not a string", () => {
  const snapshot = {
    sources: [],
    problem: "作業遲交",
    // A tampered or legacy card can carry a non-string createdBy; ownership
    // must still resolve through `source`, same as readItems() does.
    causes: [{ id: "c1", text: "忘記期限", createdBy: 12345, source: "u1" }],
  };
  const step8 = extractAiInput("step8_cause", "c1", snapshot, "u1", 12_000);
  assert.equal(step8.content.cause_card, "忘記期限");
});

test("step19 drops a stale feasible/unique method reference instead of leaking its id", () => {
  const snapshot = {
    sources: [],
    problem: "作業遲交",
    goal: "準時完成",
    causes: [],
    methods: [{ id: "m1", text: "設提醒", createdBy: "u1", status: "正式方法", causes: [], effect: "提早提醒" }],
    // References a method that no longer exists in the confirmed-methods list.
    feasible: "m-removed",
    unique: "m-removed",
    reflections: [{ id: "r1", text: "反思", createdBy: "u1" }],
  };
  const step19 = extractAiInput("step19_reflection", undefined, snapshot, "u1", 12_000);
  assert.equal(step19.content.feasible_selection, "");
  assert.equal(step19.content.original_selection, "");
  assert.doesNotMatch(JSON.stringify(step19), /m-removed/);
});

test("a card owned by the group is reviewable, matching the client's own edit rule", () => {
  // actor() answers "group" until the student joins a room, so anything written
  // while working alone carries createdBy "group". canEditCard() offers every
  // action on such a card; refusing the review of it would be a 403 the student
  // has no way to resolve.
  const snapshot = {
    sources: [],
    problem: "作業遲交",
    causes: [
      { id: "c1", text: "加入前寫下的原因", createdBy: "group" },
      { id: "c2", text: "沒有作者的原因" },
      { id: "c3", text: "別人的原因", createdBy: "u2" },
    ],
  };
  assert.equal(extractAiInput("step8_cause", "c1", snapshot, "u1", 12_000).content.cause_card, "加入前寫下的原因");
  assert.equal(extractAiInput("step8_cause", "c2", snapshot, "u1", 12_000).content.cause_card, "沒有作者的原因");
  // A card that names another member is still off limits.
  assert.throws(
    () => extractAiInput("step8_cause", "c3", snapshot, "u1", 12_000),
    (error) => error instanceof AiRequestError && error.code === "ai_item_forbidden",
  );
});

test("an oversized step19 input is shortened rather than refused outright", () => {
  const reflections = Array.from({ length: 12 }, (_, index) => ({
    id: `r${index}`,
    text: "反思".repeat(900),
    createdBy: "u1",
  }));
  const snapshot = {
    sources: [],
    problem: "作業遲交",
    goal: "準時完成",
    causes: [],
    methods: [],
    reflections,
  };
  const step19 = extractAiInput("step19_reflection", undefined, snapshot, "u1", 12_000);
  assert.equal(step19.content.texts_shortened, true);
  assert.equal(step19.content.reflections.length, 12, "every reflection is kept, only shortened");
  assert.ok(JSON.stringify(step19.content).length <= 12_000);
  // Below the smallest cap it is still a refusal rather than an empty summary.
  assert.throws(
    () => extractAiInput("step19_reflection", undefined, snapshot, "u1", 300),
    (error) => error instanceof AiRequestError && error.code === "ai_input_too_large",
  );
  // A room that fits is left alone and is not marked as shortened.
  const small = extractAiInput("step19_reflection", undefined, {
    ...snapshot,
    reflections: [{ id: "r1", text: "短反思", createdBy: "u1" }],
  }, "u1", 12_000);
  assert.equal(small.content.texts_shortened, undefined);
});

test("OpenAI review uses strict structured output without storage or provider tools", async () => {
  let sent;
  const client = new OpenAiReviewClient({
    apiKey: "test-key-never-logged",
    model: "test-model",
    timeoutMs: 5_000,
    maxOutputTokens: 500,
    fetchFn: async (_url, init) => {
      sent = JSON.parse(init.body);
      return new Response(JSON.stringify({
        id: "resp_test",
        model: "test-model",
        output: [{ content: [{ type: "output_text", text: JSON.stringify({
          classification: "cause",
          reason: "這段內容正在說明問題發生的原因。",
          clarification_question: null,
        }) }] }],
        usage: { input_tokens: 20, output_tokens: 12 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  const response = await client.generate({
    task: "step8_cause",
    content: { confirmed_problem: "作業遲交", cause_card: "忘記期限" },
  });
  assert.equal(response.value.classification, "cause");
  assert.equal(sent.store, false);
  assert.equal(sent.text.format.type, "json_schema");
  assert.equal(sent.text.format.strict, true);
  assert.equal(sent.tools, undefined);
  assert.equal(sent.previous_response_id, undefined);
});

test("invalid provider output is rejected and duplicate AI inputs share one call", async () => {
  const invalid = new OpenAiReviewClient({
    apiKey: "test-key",
    model: "test-model",
    timeoutMs: 5_000,
    maxOutputTokens: 500,
    fetchFn: async () => new Response(JSON.stringify({ output: [{ content: [{ type: "output_text", text: "{}" }] }] }), { status: 200 }),
  });
  await assert.rejects(
    invalid.generate({ task: "step8_cause", content: { confirmed_problem: "問題", cause_card: "原因" } }),
    (error) => error instanceof AiProviderError && error.kind === "invalid_output",
  );

  // String(["cause"]) is "cause", so an enum checked after coercion admits an
  // array and then hands it back as the result. The contract promises a string.
  const coerced = new OpenAiReviewClient({
    apiKey: "test-key",
    model: "test-model",
    timeoutMs: 5_000,
    maxOutputTokens: 500,
    fetchFn: async () => new Response(JSON.stringify({
      output: [{ content: [{ type: "output_text", text: JSON.stringify({
        classification: ["cause"],
        reason: "理由",
        clarification_question: null,
      }) }] }],
    }), { status: 200 }),
  });
  await assert.rejects(
    coerced.generate({ task: "step8_cause", content: { confirmed_problem: "問題", cause_card: "原因" } }),
    (error) => error instanceof AiProviderError && error.kind === "invalid_output",
  );

  // A run that hit max_output_tokens answers 200 with truncated text. Reporting
  // that as malformed output points the operator at the wrong thing.
  const truncated = new OpenAiReviewClient({
    apiKey: "test-key",
    model: "test-model",
    timeoutMs: 5_000,
    maxOutputTokens: 500,
    fetchFn: async () => new Response(JSON.stringify({
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      output: [{ content: [{ type: "output_text", text: '{"classification":"cau' }] }],
    }), { status: 200 }),
  });
  await assert.rejects(
    truncated.generate({ task: "step8_cause", content: { confirmed_problem: "問題", cause_card: "原因" } }),
    (error) => error instanceof AiProviderError && /max_output_tokens/.test(error.message),
  );

  let calls = 0;
  const fakeClient = {
    async generate() {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return {
        value: { classification: "cause", reason: "理由", clarification_question: null },
        metadata: { providerRequestId: "resp", model: "test", latencyMs: 5, inputTokens: 1, outputTokens: 1 },
      };
    },
  };
  // Two concurrent requests now spend two tokens: the budget is taken before
  // the cache and in-flight lookups, so it bounds requests and not merely
  // provider calls. Coalescing into one provider call is what this asserts.
  const service = new AiReviewService({ client: fakeClient, requestsPerMemberPerMinute: 2 });
  const input = { task: "step8_cause", content: { confirmed_problem: "問題", cause_card: "原因" } };
  const [first, second] = await Promise.all([
    service.review(1, "u1", input),
    service.review(1, "u1", input),
  ]);
  assert.equal(calls, 1);
  assert.equal(first.inputHash, second.inputHash);
});

test("a cached AI answer still costs the caller a request from their own budget", async () => {
  let calls = 0;
  const fakeClient = {
    async generate() {
      calls += 1;
      return {
        value: { classification: "cause", reason: "理由", clarification_question: null },
        metadata: { providerRequestId: "resp", model: "test", latencyMs: 1, inputTokens: 1, outputTokens: 1 },
      };
    },
  };
  const service = new AiReviewService({ client: fakeClient, requestsPerMemberPerMinute: 2 });
  const input = { task: "step8_cause", content: { confirmed_problem: "問題", cause_card: "原因" } };

  await service.review(1, "u1", input);
  // The cache key is room-wide, so without spending a token first, any member
  // could replay a teammate's answer for the whole TTL for free.
  const replay = await service.review(1, "u2", input);
  assert.equal(calls, 1, "the replay is served from cache");
  assert.equal(replay.result.classification, "cause");

  await service.review(1, "u2", input);
  await assert.rejects(
    service.review(1, "u2", input),
    (error) => error instanceof AiRateLimitError,
  );
});

async function aiRouteApp({ member = { memberId: "u1", roomId: 1 }, revision = 7, revisions = [revision], snapshot, review }) {
  const app = Fastify({ logger: false });
  let readCount = 0;
  const store = {
    async authenticate(_code, token) { return token === "valid-token" ? member : null; },
    async read() {
      const current = revisions[Math.min(readCount, revisions.length - 1)];
      readCount += 1;
      return { revision: current, currentStep: 14, snapshot };
    },
    async readRevision() {
      const current = revisions[Math.min(readCount, revisions.length - 1)];
      readCount += 1;
      return current;
    },
  };
  const config = {
    sessionTtlHours: 24,
    aiMaxInputChars: 12_000,
    maxArtifactBytes: 4_194_304,
    bodyLimitBytes: 4_194_304,
    longPollMs: 0,
    adminToken: null,
  };
  registerRoomRoutes(app, {
    config,
    store,
    notifier: { notify() {}, async wait() {} },
    limiters: { requests: null, lookupFailures: null, roomCreates: null },
    aiService: { review },
  });
  await app.ready();
  return app;
}

test("AI HTTP route reuses room authentication and rejects stale revisions before a provider call", async () => {
  let calls = 0;
  const app = await aiRouteApp({
    snapshot: { sources: [], problem: "作業遲交", causes: [{ id: "c1", text: "忘記期限", createdBy: "u1" }] },
    review: async () => { calls += 1; throw new Error("should not be called"); },
  });
  try {
    const missingSession = await app.inject({
      method: "POST",
      url: "/api/rooms/abcdefghjk/ai/review",
      payload: { task: "step8_cause", itemId: "c1", baseRevision: 7 },
    });
    assert.equal(missingSession.statusCode, 404);

    const stale = await app.inject({
      method: "POST",
      url: "/api/rooms/abcdefghjk/ai/review",
      headers: { authorization: "Bearer valid-token" },
      payload: { task: "step8_cause", itemId: "c1", baseRevision: 6 },
    });
    assert.equal(stale.statusCode, 409);
    assert.equal(JSON.parse(stale.body).error, "stale_room_revision");
    assert.equal(calls, 0);
  } finally {
    await app.close();
  }
});

test("AI HTTP route enforces card ownership and returns only the validated result envelope", async () => {
  let calls = 0;
  const baseSnapshot = {
    sources: [],
    problem: "作業遲交",
    causes: [
      { id: "mine", text: "忘記期限", createdBy: "u1" },
      { id: "other", text: "沒有整理清單", createdBy: "u2" },
    ],
  };
  const app = await aiRouteApp({
    snapshot: baseSnapshot,
    review: async () => {
      calls += 1;
      return {
        inputHash: "a".repeat(64),
        promptVersion: "step8-v1",
        result: { classification: "cause", reason: "這是在說明原因。", clarification_question: null },
        metadata: { providerRequestId: "resp", model: "test", latencyMs: 1, inputTokens: 1, outputTokens: 1 },
      };
    },
  });
  try {
    const forbidden = await app.inject({
      method: "POST",
      url: "/api/rooms/abcdefghjk/ai/review",
      headers: { authorization: "Bearer valid-token" },
      payload: { task: "step8_cause", itemId: "other", baseRevision: 7 },
    });
    assert.equal(forbidden.statusCode, 403);
    assert.equal(calls, 0);

    const accepted = await app.inject({
      method: "POST",
      url: "/api/rooms/abcdefghjk/ai/review",
      headers: { authorization: "Bearer valid-token" },
      payload: { task: "step8_cause", itemId: "mine", baseRevision: 7 },
    });
    assert.equal(accepted.statusCode, 200, accepted.body);
    const body = JSON.parse(accepted.body);
    assert.equal(body.task, "step8_cause");
    assert.equal(body.result.classification, "cause");
    assert.equal(body.providerRequestId, undefined);
    assert.equal(accepted.headers["cache-control"], "no-store");
    assert.equal(calls, 1);
  } finally {
    await app.close();
  }
});

test("an AI result is discarded when the room changes during the provider call", async () => {
  let calls = 0;
  const app = await aiRouteApp({
    revisions: [7, 8],
    snapshot: { sources: [], problem: "作業遲交", causes: [{ id: "c1", text: "忘記期限", createdBy: "u1" }] },
    review: async () => {
      calls += 1;
      return {
        inputHash: "b".repeat(64),
        promptVersion: "step8-v1",
        result: { classification: "cause", reason: "理由", clarification_question: null },
        metadata: { providerRequestId: "resp", model: "test", latencyMs: 1, inputTokens: 1, outputTokens: 1 },
      };
    },
  });
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/rooms/abcdefghjk/ai/review",
      headers: { authorization: "Bearer valid-token" },
      payload: { task: "step8_cause", itemId: "c1", baseRevision: 7 },
    });
    assert.equal(response.statusCode, 409);
    assert.equal(JSON.parse(response.body).revision, 8);
    assert.equal(calls, 1);
  } finally {
    await app.close();
  }
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

/**
 * Exercises the real HTTP surface against a real PostgreSQL.
 *
 * TEST_DATABASE_URL must point at a throwaway database: the suite drops and
 * recreates the public schema before it runs.
 */
import assert from "node:assert/strict";
import test from "node:test";

const databaseUrl = process.env.TEST_DATABASE_URL;

if (!databaseUrl) {
  test("integration tests", { skip: "TEST_DATABASE_URL is not set — see README, section Testing" }, () => {});
} else {
  process.env.DATABASE_URL = databaseUrl;
  process.env.DATA_RETENTION_DAYS ??= "3650";
  process.env.ADMIN_TOKEN ??= "integration-test-admin-token-abcdef";
  process.env.LOG_LEVEL ??= "silent";
  process.env.SYNC_LONG_POLL_MS ??= "2000";
  // The suite shares one client address, so the real limits would be spent on
  // the tests themselves. The rate-limit tests below install their own.
  process.env.RATE_LIMIT_LOOKUP_FAILURES_PER_MINUTE ??= "100000";
  process.env.RATE_LIMIT_ROOM_CREATES_PER_HOUR ??= "100000";
  process.env.RATE_LIMIT_REQUESTS_PER_MINUTE ??= "10000000";

  const { buildApp, defaultPublicDir, redactPath } = await import("../../build/app.js");
  const { loadConfig } = await import("../../build/config.js");
  const { createPool } = await import("../../build/db/pool.js");
  const { runMigrations } = await import("../../build/db/migrate.js");
  const { RoomStore } = await import("../../build/rooms/store.js");
  const { startRetentionSweeper } = await import("../../build/retention.js");
  const { RateLimiter } = await import("../../build/rate-limit.js");

  const config = loadConfig(defaultPublicDir());
  const pool = createPool(config);

  await pool.query("drop schema public cascade");
  await pool.query("create schema public");
  await runMigrations(pool, { info: () => {} });

  const app = await buildApp(config, pool);
  await app.ready();

  test.after(async () => {
    await app.close();
    await pool.end();
  });

  const snapshot = (overrides = {}) => ({
    sources: [
      { id: "u1", name: "小安", color: "#276EF1", system: false, joined: true },
      { id: "group", name: "小組提出", color: "#46515f", system: true, joined: true },
    ],
    distresses: [],
    ...overrides,
  });

  const json = (response) => JSON.parse(response.body);

  const post = (url, payload, headers) => app.inject({ method: "POST", url, payload, headers });
  const get = (url, headers) => app.inject({ method: "GET", url, headers });
  const auth = (token) => ({ authorization: `Bearer ${token}` });

  /** Rooms exist only because the server made one. */
  const newRoom = async () => {
    const response = await post("/api/rooms", {});
    assert.equal(response.statusCode, 201, response.body);
    return json(response).room;
  };

  const joinRoom = async (code, memberId, name, step = 2, headers) => {
    const response = await post(`/api/rooms/${code}/join`, { memberId, name, step }, headers);
    assert.equal(response.statusCode, 200, response.body);
    return json(response);
  };

  /** A well-formed code that was never issued. */
  const GHOST = "zzzzzzzzzz";

  test("healthz reports the database it actually queried", async () => {
    const response = await get("/healthz");
    assert.equal(response.statusCode, 200);
    const body = json(response);
    assert.equal(body.status, "ok");
    assert.equal(body.database, "ok");
    assert.ok(typeof body.databaseLatencyMs === "number");
  });

  test("room creation accepts a POST without a request body", async () => {
    const response = await post("/api/rooms");
    assert.equal(response.statusCode, 201, response.body);
    assert.match(json(response).room, /^[0-9abcdefghjkmnpqrstvwxyz]+$/);
  });

  test("room creation accepts an explicitly empty JSON body", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/rooms",
      headers: { "content-type": "application/json", "content-length": "0" },
      payload: "",
    });
    assert.equal(response.statusCode, 201, response.body);
  });

  test("healthz turns non-200 when the schema it depends on is gone", async () => {
    await pool.query("alter table schema_migrations rename to schema_migrations_hidden");
    try {
      const response = await get("/healthz");
      assert.equal(response.statusCode, 503);
      assert.equal(json(response).database, "unreachable");
    } finally {
      await pool.query("alter table schema_migrations_hidden rename to schema_migrations");
    }
    assert.equal((await get("/healthz")).statusCode, 200);
  });

  test("the activity page is served at the container root, with no absolute paths", async () => {
    const response = await get("/");
    assert.equal(response.statusCode, 200);
    assert.match(response.headers["content-type"], /text\/html/);
    assert.match(response.body, /魚骨洞天/);
    // Same file, both ways in.
    assert.equal((await get("/fishbone.html")).statusCode, 200);
  });

  // --- room codes and the enumeration oracle --------------------------------

  test("a created room gets a high-entropy code nobody chose", async () => {
    const first = await newRoom();
    const second = await newRoom();
    assert.notEqual(first, second);
    assert.equal(first.length, config.roomCodeLength);
    // Crockford Base32 in lower case: no i, l, o or u to misread.
    assert.match(first, /^[0-9abcdefghjkmnpqrstvwxyz]+$/);
    // The display form is only cosmetic; the stored code carries no hyphen.
    const created = json(await post("/api/rooms", {}));
    assert.equal(created.displayCode.replace(/-/g, ""), created.room);
  });

  test("joining a code that was never issued does not create it", async () => {
    const before = (await pool.query("select count(*)::int as n from rooms")).rows[0].n;

    const response = await post(`/api/rooms/${GHOST}/join`, { memberId: "u1", name: "小安", step: 2 });
    assert.equal(response.statusCode, 404);
    assert.deepEqual(json(response), { error: "room_not_found" });

    const rows = await pool.query("select count(*)::int as n from rooms where lower(code) = $1", [GHOST]);
    assert.equal(rows.rows[0].n, 0, "a POST to an unknown code must not bring a room into existence");
    assert.equal((await pool.query("select count(*)::int as n from rooms")).rows[0].n, before);
  });

  test("an unauthenticated caller cannot tell an existing room from one that never existed", async () => {
    const real = await newRoom();
    const writer = await joinRoom(real, "u1", "小安");
    await post(`/api/rooms/${real}/state`, {
      step: 2,
      baseRevision: 0,
      snapshot: snapshot({ distresses: [{ id: "d1", text: "私密的困擾", createdBy: "u1" }] }),
    }, auth(writer.token));

    // The room now holds real content. Every way of asking about it without a
    // session must be indistinguishable from asking about a room that is not
    // there, or the 404/200 split is an oracle for which codes are live.
    const probes = [
      () => get(`/api/rooms/${real}/state`),
      () => get(`/api/rooms/${real}/state`, auth("not-a-real-token")),
      () => get(`/api/rooms/${real}/state?since=0&wait=1`),
      () => post(`/api/rooms/${real}/state`, { step: 2, baseRevision: 0, snapshot: snapshot() }),
      () => post(`/api/rooms/${real}/artifacts`, { format: "text", content: "x" }),
    ];
    const ghosts = [
      () => get(`/api/rooms/${GHOST}/state`),
      () => get(`/api/rooms/${GHOST}/state`, auth("not-a-real-token")),
      () => get(`/api/rooms/${GHOST}/state?since=0&wait=1`),
      () => post(`/api/rooms/${GHOST}/state`, { step: 2, baseRevision: 0, snapshot: snapshot() }),
      () => post(`/api/rooms/${GHOST}/artifacts`, { format: "text", content: "x" }),
    ];

    for (let at = 0; at < probes.length; at += 1) {
      const live = await probes[at]();
      const dead = await ghosts[at]();
      assert.equal(live.statusCode, dead.statusCode, `probe ${at}: status differs`);
      assert.equal(live.body, dead.body, `probe ${at}: body differs`);
      assert.equal(live.statusCode, 404);
      assert.deepEqual(json(live), { error: "room_not_found" });
      // Nothing a student wrote may appear in either answer.
      assert.doesNotMatch(live.body, /私密的困擾|小安/);
    }
  });

  test("a session opens exactly one room", async () => {
    const mine = await newRoom();
    const theirs = await newRoom();
    const session = await joinRoom(mine, "u1", "小安");

    assert.equal((await get(`/api/rooms/${mine}/state`, auth(session.token))).statusCode, 200);
    // The same token against a different room is just another failed lookup.
    const crossed = await get(`/api/rooms/${theirs}/state`, auth(session.token));
    assert.equal(crossed.statusCode, 404);
    assert.deepEqual(json(crossed), { error: "room_not_found" });
  });

  test("a public member id cannot be used to take over another session", async () => {
    const code = await newRoom();
    const owner = await joinRoom(code, "u1", "小安");
    const attacker = await joinRoom(code, "u2", "阿凱");

    const takeover = await post(
      `/api/rooms/${code}/join`,
      { memberId: "u1", name: "冒用者", step: 2 },
      auth(attacker.token),
    );
    assert.equal(takeover.statusCode, 409);
    assert.equal(json(takeover).error, "member_id_in_use");
    // The original bearer remains valid after the rejected attempt.
    assert.equal((await get(`/api/rooms/${code}/state`, auth(owner.token))).statusCode, 200);

    // Rejoining with the existing bearer is a safe session rotation.
    const rotated = await joinRoom(code, "u1", "小安", 2, auth(owner.token));
    assert.notEqual(rotated.token, owner.token);
    assert.equal((await get(`/api/rooms/${code}/state`, auth(rotated.token))).statusCode, 200);
  });

  test("server-authoritative member count locks a room without blocking legitimate reconnects", async () => {
    assert.equal((await post("/api/rooms", { expectedMemberCount: 0 })).statusCode, 400);
    assert.equal((await post("/api/rooms", { expectedMemberCount: 13 })).statusCode, 400);
    const created = await post("/api/rooms", { expectedMemberCount: 2 });
    assert.equal(created.statusCode, 201, created.body);
    const room = json(created);
    const code = room.room;
    assert.equal(room.expectedMemberCount, 2);
    assert.equal(room.membersLocked, false);

    const firstResponse = await post(
      `/api/rooms/${code}/join`,
      { memberId: "u1", name: "同名成員", step: 2, expectedMemberCount: 12 },
    );
    assert.equal(firstResponse.statusCode, 200, firstResponse.body);
    const first = json(firstResponse);
    assert.equal(first.expectedMemberCount, 2);
    assert.equal(first.membersLocked, false);

    const second = await joinRoom(code, "u2", "同名成員");
    assert.equal(second.membersLocked, true);
    assert.deepEqual(second.members.map((member) => member.memberId), ["u1", "u2"]);

    const full = await post(`/api/rooms/${code}/join`, { memberId: "u3", name: "同名成員", step: 2 });
    assert.equal(full.statusCode, 409);
    assert.equal(json(full).error, "room_full_or_locked");

    const takeover = await post(
      `/api/rooms/${code}/join`,
      { memberId: "u1", name: "同名成員", step: 2 },
      auth(second.token),
    );
    assert.equal(takeover.statusCode, 409);
    assert.equal(json(takeover).error, "member_id_in_use");

    const reconnectedFirst = await joinRoom(code, "u1", "同名成員", 2, auth(first.token));
    const reconnectedSecond = await joinRoom(code, "u2", "同名成員", 2, auth(second.token));
    assert.equal(reconnectedFirst.membersLocked, true);
    assert.equal(reconnectedSecond.membersLocked, true);
    assert.deepEqual(reconnectedSecond.members.map((member) => member.memberId), ["u1", "u2"]);

    const hydrated = json(await get(`/api/rooms/${code}/state`, auth(reconnectedFirst.token)));
    assert.equal(hydrated.expectedMemberCount, 2);
    assert.equal(hydrated.membersLocked, true);
    assert.deepEqual(hydrated.members.map((member) => member.memberId), ["u1", "u2"]);
  });

  test("one member advancing does not drag another member past an unfinished step", async () => {
    const created = json(await post("/api/rooms", { expectedMemberCount: 2 }));
    const first = await joinRoom(created.room, "u1", "小安", 2);
    const second = await joinRoom(created.room, "u2", "小美", 2);

    const firstWrite = await post(
      `/api/rooms/${created.room}/state`,
      { baseRevision: 0, step: 3, snapshot: snapshot() },
      auth(first.token),
    );
    assert.equal(firstWrite.statusCode, 200, firstWrite.body);
    const revision = json(firstWrite).revision;

    const firstState = json(await get(`/api/rooms/${created.room}/state`, auth(first.token)));
    const secondState = json(await get(`/api/rooms/${created.room}/state`, auth(second.token)));
    assert.equal(firstState.currentStep, 3);
    assert.equal(secondState.currentStep, 2);

    const secondWrite = await post(
      `/api/rooms/${created.room}/state`,
      { baseRevision: revision, step: 3, snapshot: snapshot() },
      auth(second.token),
    );
    assert.equal(secondWrite.statusCode, 200, secondWrite.body);
    assert.equal(json(await get(`/api/rooms/${created.room}/state`, auth(second.token))).currentStep, 3);
  });

  test("member colours are valid for new and pre-colour rooms", async () => {
    const code = await newRoom();
    const first = await joinRoom(code, "u1", "小安");
    await joinRoom(code, "u2", "小美");
    await pool.query(
      `update members set color = ''
        where room_id = (select id from rooms where code = $1) and member_id = 'u1'`,
      [code],
    );

    const state = json(await get(`/api/rooms/${code}/state`, auth(first.token)));
    assert.equal(state.snapshot.sources.length, 2);
    for (const source of state.snapshot.sources) assert.match(source.color, /^#[0-9A-Fa-f]{6}$/);
  });

  test("the release migration frees every session issued before ownership was enforced", async () => {
    // Replays the upgrade rather than trusting the SQL by reading it: a session
    // that predates the ownership rule was handed to a browser with nowhere to
    // keep it, so leaving its digest in place locks that student out on their
    // first refresh.
    const code = await newRoom();
    const session = await joinRoom(code, "u1", "小安");
    const stored = await pool.query(
      "select m.session_token_hash from members m join rooms r on r.id = m.room_id where lower(r.code) = $1 and m.member_id = 'u1'",
      [code.toLowerCase()],
    );
    assert.notEqual(stored.rows[0].session_token_hash, null, "the join must have issued a session");

    await pool.query("delete from schema_migrations where id = $1", ["0003_release_member_sessions"]);
    await runMigrations(pool, { info: () => {} });

    const freed = await pool.query(
      "select m.session_token_hash from members m join rooms r on r.id = m.room_id where lower(r.code) = $1 and m.member_id = 'u1'",
      [code.toLowerCase()],
    );
    assert.equal(freed.rows[0].session_token_hash, null, "the old digest must be gone");
    // The old bearer is spent, and the id is claimable again without one.
    assert.equal((await get(`/api/rooms/${code}/state`, auth(session.token))).statusCode, 404);
    const reclaimed = await joinRoom(code, "u1", "小安");
    assert.equal((await get(`/api/rooms/${code}/state`, auth(reclaimed.token))).statusCode, 200);
  });

  test("a member listed in a snapshot but never joined can still claim that id", async () => {
    const code = await newRoom();
    const writer = await joinRoom(code, "u1", "小安");
    // Projection creates a row for every source in the snapshot, with no session
    // digest. That row must not lock the person it names out of their own id.
    await post(`/api/rooms/${code}/state`, {
      step: 2,
      baseRevision: 0,
      snapshot: snapshot({
        sources: [
          { id: "u1", name: "小安", color: "#276EF1", system: false, joined: true },
          { id: "u9", name: "小悠", color: "#46515f", system: false, joined: false },
        ],
      }),
    }, auth(writer.token));
    const rows = await pool.query(
      "select session_token_hash from members m join rooms r on r.id = m.room_id where lower(r.code) = $1 and m.member_id = 'u9'",
      [code.toLowerCase()],
    );
    assert.equal(rows.rows[0].session_token_hash, null, "the projected row must have no session yet");

    const claimed = await joinRoom(code, "u9", "小悠");
    assert.equal((await get(`/api/rooms/${code}/state`, auth(claimed.token))).statusCode, 200);
    // Having been claimed, it is now protected like any other member id.
    const second = await post(`/api/rooms/${code}/join`, { memberId: "u9", name: "冒用者", step: 2 });
    assert.equal(second.statusCode, 409);
  });

  test("a code is accepted however it is typed", async () => {
    const code = await newRoom();
    const session = await joinRoom(code, "u1", "小安");

    const grouped = `${code.slice(0, 5)}-${code.slice(5)}`;
    const shouted = grouped.toUpperCase();
    // Crockford's aliases: a student reading 0 as O, or 1 as I or l.
    const misread = code.replace(/0/g, "O").replace(/1/g, "l");

    for (const typed of [grouped, shouted, misread, ` ${code} `]) {
      const response = await get(`/api/rooms/${encodeURIComponent(typed)}/state`, auth(session.token));
      assert.equal(response.statusCode, 200, `"${typed}" should reach the room`);
    }

    // A code that is not even the right shape says nothing about which rooms
    // exist, so that one may explain itself.
    const malformed = await get("/api/rooms/short/state", auth(session.token));
    assert.equal(malformed.statusCode, 400);
    assert.equal(json(malformed).error, "bad_room_code");
  });

  // --- rate limiting --------------------------------------------------------

  test("the failed-lookup limiter actually triggers, and spares members already in a room", async () => {
    // Join before the budget is touched, the way a class does.
    const code = await newRoom();
    const session = await joinRoom(code, "u1", "小安");

    const original = app.limiters.lookupFailures;
    app.limiters.lookupFailures = new RateLimiter({ capacity: 3, refillPeriodMs: 60_000 });
    try {
      const statuses = [];
      for (let attempt = 0; attempt < 6; attempt += 1) {
        statuses.push((await post(`/api/rooms/${GHOST}/join`, { memberId: "u1", name: "x", step: 1 })).statusCode);
      }
      assert.deepEqual(statuses, [404, 404, 404, 429, 429, 429], "the budget must run out and stay out");

      const limited = await post(`/api/rooms/${GHOST}/join`, { memberId: "u1", name: "x", step: 1 });
      assert.equal(json(limited).error, "rate_limited");
      assert.ok(Number(limited.headers["retry-after"]) >= 1, "a 429 must say when to come back");
      // Being throttled says nothing about whether the room exists.
      const realWhileLimited = await post(`/api/rooms/${code}/join`, { memberId: "u9", name: "x", step: 1 });
      assert.equal(realWhileLimited.statusCode, 429);

      // A whole class shares one school NAT address. Someone else spending the
      // budget must not eject a student who is already in a room, so a request
      // carrying a valid session never consults it.
      assert.equal((await get(`/api/rooms/${code}/state`, auth(session.token))).statusCode, 200);
      assert.equal(
        (await post(`/api/rooms/${code}/state`, { step: 2, baseRevision: 0, snapshot: snapshot() }, auth(session.token)))
          .statusCode,
        200,
      );
      assert.equal(
        (await post(`/api/rooms/${code}/artifacts`, { format: "text", content: "x" }, auth(session.token))).statusCode,
        201,
      );
    } finally {
      app.limiters.lookupFailures = original;
    }
  });

  test("rate limiting is wired up by the default configuration", () => {
    // The tests below install their own limiters, so without this the suite
    // could pass against a build that never creates any.
    assert.ok(app.limiters.requests instanceof RateLimiter);
    assert.ok(app.limiters.lookupFailures instanceof RateLimiter);
    assert.ok(app.limiters.roomCreates instanceof RateLimiter);
  });

  test("room creation is limited too", async () => {
    const original = app.limiters.roomCreates;
    app.limiters.roomCreates = new RateLimiter({ capacity: 2, refillPeriodMs: 3_600_000 });
    try {
      assert.equal((await post("/api/rooms", {})).statusCode, 201);
      assert.equal((await post("/api/rooms", {})).statusCode, 201);
      const blocked = await post("/api/rooms", {});
      assert.equal(blocked.statusCode, 429);
      assert.equal(json(blocked).error, "rate_limited");
    } finally {
      app.limiters.roomCreates = original;
    }
  });

  test("each client address gets its own budget", async () => {
    const original = app.limiters.lookupFailures;
    app.limiters.lookupFailures = new RateLimiter({ capacity: 1, refillPeriodMs: 60_000 });
    try {
      const probe = (remoteAddress) =>
        app.inject({
          method: "POST",
          url: `/api/rooms/${GHOST}/join`,
          payload: { memberId: "u1", name: "x", step: 1 },
          remoteAddress,
        });
      assert.equal((await probe("203.0.113.10")).statusCode, 404);
      assert.equal((await probe("203.0.113.10")).statusCode, 429);
      // A different address still has its own allowance.
      assert.equal((await probe("203.0.113.11")).statusCode, 404);
    } finally {
      app.limiters.lookupFailures = original;
    }
  });

  // --- logging --------------------------------------------------------------

  test("a room code never reaches a log line", () => {
    assert.equal(redactPath("/api/rooms/k7m2x9qpwd/state?since=3&wait=1&step=7"), "/api/rooms/:code/state");
    assert.equal(redactPath("/api/rooms/k7m2x9qpwd/join"), "/api/rooms/:code/join");
    assert.equal(redactPath("/api/admin/rooms/k7m2x9qpwd/export"), "/api/admin/rooms/:code/export");
    assert.equal(redactPath("/healthz"), "/healthz");
  });

  // --- sync -----------------------------------------------------------------

  test("two devices in one room see each other's cards", async () => {
    const code = await newRoom();
    const a = await joinRoom(code, "u1", "小安");
    const b = await joinRoom(code, "u2", "阿凱");
    assert.equal(a.revision, 0);
    assert.equal(b.revision, 0);

    const writeA = await post(
      `/api/rooms/${code}/state`,
      { step: 2, baseRevision: 0, snapshot: snapshot({ distresses: [{ id: "d1", text: "我常常忘記作業期限", createdBy: "u1" }] }) },
      auth(a.token),
    );
    assert.equal(writeA.statusCode, 200);
    assert.equal(json(writeA).revision, 1);

    const pollB = json(await get(`/api/rooms/${code}/state?since=0`, auth(b.token)));
    assert.equal(pollB.revision, 1);
    assert.deepEqual(pollB.snapshot.distresses.map((d) => d.text), ["我常常忘記作業期限"]);

    const idle = json(await get(`/api/rooms/${code}/state?since=1`, auth(b.token)));
    assert.equal(idle.unchanged, true);
    assert.equal(idle.snapshot, undefined);
  });

  test("a simultaneous write is refused with the other device's snapshot, not silently dropped", async () => {
    const code = await newRoom();
    const a = await joinRoom(code, "u1", "小安");
    const b = await joinRoom(code, "u2", "阿凱");

    const first = await post(
      `/api/rooms/${code}/state`,
      { step: 2, baseRevision: 0, snapshot: snapshot({ distresses: [{ id: "d1", text: "A 的困擾", createdBy: "u1" }] }) },
      auth(a.token),
    );
    assert.equal(first.statusCode, 200);

    const second = await post(
      `/api/rooms/${code}/state`,
      { step: 2, baseRevision: 0, snapshot: snapshot({ distresses: [{ id: "d2", text: "B 的困擾", createdBy: "u2" }] }) },
      auth(b.token),
    );
    assert.equal(second.statusCode, 409);
    const conflict = json(second);
    assert.equal(conflict.status, "conflict");
    assert.deepEqual(conflict.snapshot.distresses.map((d) => d.id), ["d1"]);

    const retry = await post(
      `/api/rooms/${code}/state`,
      {
        step: 2,
        baseRevision: conflict.revision,
        snapshot: snapshot({
          distresses: [
            { id: "d1", text: "A 的困擾", createdBy: "u1" },
            { id: "d2", text: "B 的困擾", createdBy: "u2" },
          ],
        }),
      },
      auth(b.token),
    );
    assert.equal(retry.statusCode, 200);

    const final = json(await get(`/api/rooms/${code}/state?since=0`, auth(a.token)));
    assert.deepEqual(final.snapshot.distresses.map((d) => d.id), ["d1", "d2"]);
  });

  test("the snapshot is projected into queryable rows", async () => {
    const code = await newRoom();
    const session = await joinRoom(code, "u1", "小安", 9);
    await post(
      `/api/rooms/${code}/state`,
      {
        step: 9,
        baseRevision: 0,
        snapshot: snapshot({
          distresses: [{ id: "d1", text: "忘記作業期限", createdBy: "u1" }],
          causes: [{ id: "c1", text: "沒有記錄習慣", createdBy: "u1", status: "已確認為原因" }],
          reflections: [{ id: "r1", text: "魚骨圖讓我看到原因", createdBy: "u1" }],
          groupProposals: [{ id: "gp1", source: "u1", groups: [{ name: "作業", ids: ["d1"] }] }],
          groupingConfirmed: "gp1",
          groupingRound: 2,
          groupingVotes: { u1: { value: "gp1", round: 2 }, u2: { value: "gp1", round: 1 } },
        }),
      },
      auth(session.token),
    );

    const roomId = (await pool.query("select id from rooms where lower(code) = $1", [code])).rows[0].id;

    const subs = await pool.query(
      "select kind, item_id, step, status from submissions where room_id = $1 order by kind",
      [roomId],
    );
    assert.deepEqual(subs.rows.map((r) => [r.kind, r.item_id, r.step]), [
      ["cause", "c1", 7],
      ["distress", "d1", 2],
      ["reflection", "r1", 18],
    ]);
    assert.equal(subs.rows.find((r) => r.kind === "cause").status, "已確認為原因");

    const groupings = await pool.query(
      "select kind, title, is_official, payload from groupings where room_id = $1",
      [roomId],
    );
    assert.equal(groupings.rows.length, 1);
    assert.equal(groupings.rows[0].is_official, true);
    assert.equal(groupings.rows[0].title, "小安");
    assert.deepEqual(groupings.rows[0].payload.groups, [{ name: "作業", ids: ["d1"] }]);

    const rounds = await pool.query(
      "select round from vote_rounds where room_id = $1 and kind = 'grouping' order by round",
      [roomId],
    );
    assert.deepEqual(rounds.rows.map((r) => r.round), [1, 2]);

    const roomRow = await pool.query("select current_step from rooms where id = $1", [roomId]);
    assert.equal(roomRow.rows[0].current_step, 9);
  });

  test("the author recorded is the authenticated member, not whatever the body claims", async () => {
    const code = await newRoom();
    const session = await joinRoom(code, "u1", "小安");
    await post(
      `/api/rooms/${code}/state`,
      {
        // A caller trying to write as somebody else.
        memberId: "someone-else",
        step: 5,
        baseRevision: 0,
        snapshot: snapshot(),
      },
      auth(session.token),
    );

    const roomId = (await pool.query("select id from rooms where lower(code) = $1", [code])).rows[0].id;
    const rows = await pool.query(
      "select member_id, current_step from members where room_id = $1 and current_step > 0",
      [roomId],
    );
    assert.deepEqual(rows.rows.map((r) => r.member_id), ["u1"]);
  });

  test("cards and votes merge monotonically instead of treating absence as deletion", async () => {
    const code = await newRoom();
    const a = await joinRoom(code, "u1", "小安");
    const b = await joinRoom(code, "u2", "阿凱");
    const sources = [
      { id: "u1", name: "小安", color: "#276EF1", system: false, joined: true },
      { id: "u2", name: "阿凱", color: "#5B8C00", system: false, joined: true },
      { id: "group", name: "小組提出", color: "#46515f", system: true, joined: true },
    ];
    const item = (id, text, createdBy, contentVersion) => ({ id, text, createdBy, contentVersion });
    const ballot = (value, round, contentVersion) => ({ value, round, contentVersion });
    const write = async (session, baseRevision, state) => {
      const response = await post(
        `/api/rooms/${code}/state`,
        { step: 3, baseRevision, snapshot: snapshot({ sources, ...state }) },
        auth(session.token),
      );
      assert.equal(response.statusCode, 200, response.body);
      return json(response).revision;
    };

    let revision = await write(a, 0, {
      distresses: [item("d1", "小安的困擾", "u1", 1)],
      groupingRound: 1,
      groupingVotes: { u1: ballot("gp-a", 1, 1) },
    });
    revision = await write(b, revision, {
      distresses: [item("d2", "阿凱的困擾", "u2", 1)],
      groupingRound: 1,
      groupingVotes: { u2: ballot("gp-b", 1, 1) },
    });

    const roomId = (await pool.query("select id from rooms where lower(code) = $1", [code])).rows[0].id;
    const liveCards = async () => (await pool.query(
      "select item_id, body from submissions where room_id = $1 and kind = 'distress' and deleted_at is null order by item_id",
      [roomId],
    )).rows;
    const liveVotes = async () => (await pool.query(
      "select member_id, value from votes where room_id = $1 and kind = 'grouping' and round = 1 and deleted_at is null order by member_id",
      [roomId],
    )).rows;
    assert.deepEqual((await liveCards()).map((row) => row.item_id), ["d1", "d2"]);
    assert.deepEqual((await liveVotes()).map((row) => row.member_id), ["u1", "u2"]);

    revision = await write(a, revision, {
      distresses: [item("d1", "新版內容", "u1", 2)],
      groupingRound: 1,
      groupingVotes: { u1: ballot("gp-new", 1, 2) },
    });
    revision = await write(b, revision, {
      distresses: [item("d1", "同版不得覆蓋", "u1", 2), item("d2", "阿凱的困擾", "u2", 1)],
      groupingRound: 1,
      groupingVotes: { u1: ballot("gp-equal", 1, 2), u2: ballot("gp-b", 1, 1) },
    });
    assert.equal((await liveCards()).find((row) => row.item_id === "d1").body, "新版內容");
    assert.equal((await liveVotes()).find((row) => row.member_id === "u1").value, "gp-new");

    revision = await write(a, revision, {
      distresses: [item("d2", "阿凱的困擾", "u2", 1)],
      deletedDistressIds: ["d1"],
      distressesVersion: 3,
      groupingRound: 1,
      groupingVotes: { u2: ballot("gp-b", 1, 1) },
      voteTombstones: [{ kind: "grouping", round: 1, memberId: "u1", deletedVersion: 3 }],
    });
    assert.deepEqual((await liveCards()).map((row) => row.item_id), ["d2"]);
    assert.deepEqual((await liveVotes()).map((row) => row.member_id), ["u2"]);

    await write(b, revision, {
      distresses: [item("d1", "舊資料不能復活", "u1", 2), item("d2", "阿凱的困擾", "u2", 1)],
      groupingRound: 1,
      groupingVotes: { u1: ballot("gp-revive", 1, 2), u2: ballot("gp-b", 1, 1) },
    });
    assert.deepEqual((await liveCards()).map((row) => row.item_id), ["d2"]);
    assert.deepEqual((await liveVotes()).map((row) => row.member_id), ["u2"]);
  });

  test("authoritative hydrate keeps the highest version shared by grouping vote kinds", async () => {
    const code = await newRoom();
    const session = await joinRoom(code, "u1", "小安");
    const written = await post(
      `/api/rooms/${code}/state`,
      {
        step: 3,
        baseRevision: 0,
        snapshot: snapshot({
          groupingRound: 1,
          groupingVersion: 7,
          groupingVotes: { u1: { value: "gp1", round: 1, contentVersion: 9000 } },
        }),
      },
      auth(session.token),
    );
    assert.equal(written.statusCode, 200, written.body);

    const hydrated = json(await get(`/api/rooms/${code}/state`, auth(session.token)));
    assert.equal(hydrated.snapshot.groupingVersion, 9000);
    assert.equal(hydrated.snapshot.authoritativeVoteVersions.grouping, 9000);
    assert.equal(hydrated.snapshot.authoritativeVoteVersions.groupConfirm, 7);

    const roomId = (await pool.query("select id from rooms where lower(code) = $1", [code])).rows[0].id;
    await pool.query(
      "update rooms set snapshot = jsonb_set(snapshot, '{groupingVersion}', $2::jsonb) where id = $1",
      [roomId, JSON.stringify(1e99)],
    );
    const staleRaw = json(await get(`/api/rooms/${code}/state`, auth(session.token)));
    assert.equal(staleRaw.snapshot.groupingVersion, 9000);
  });

  test("authoritative hydrate keeps a newer group confirmation version", async () => {
    const code = await newRoom();
    const session = await joinRoom(code, "u1", "小安");
    const written = await post(
      `/api/rooms/${code}/state`,
      {
        step: 3,
        baseRevision: 0,
        snapshot: snapshot({
          groupingRound: 1,
          groupingVersion: 7,
          groupConfirmVotes: { u1: { value: "confirmed", contentVersion: 9000 } },
        }),
      },
      auth(session.token),
    );
    assert.equal(written.statusCode, 200, written.body);

    const hydrated = json(await get(`/api/rooms/${code}/state`, auth(session.token)));
    assert.equal(hydrated.snapshot.groupingVersion, 9000);
    assert.equal(hydrated.snapshot.authoritativeVoteVersions.grouping, 7);
    assert.equal(hydrated.snapshot.authoritativeVoteVersions.groupConfirm, 9000);
  });

  test("a deleted card becomes an explicit tombstone", async () => {
    const code = await newRoom();
    const session = await joinRoom(code, "u1", "小安");
    await post(
      `/api/rooms/${code}/state`,
      {
        step: 2,
        baseRevision: 0,
        snapshot: snapshot({
          distresses: [
            { id: "d1", text: "一", createdBy: "u1", contentVersion: 1 },
            { id: "d2", text: "二", createdBy: "u1", contentVersion: 1 },
          ],
        }),
      },
      auth(session.token),
    );
    await post(
      `/api/rooms/${code}/state`,
      {
        step: 2,
        baseRevision: 1,
        snapshot: snapshot({
          distresses: [{ id: "d2", text: "二", createdBy: "u1", contentVersion: 1 }],
          distressesVersion: 2,
          deletedDistressIds: ["d1"],
        }),
      },
      auth(session.token),
    );

    const roomId = (await pool.query("select id from rooms where lower(code) = $1", [code])).rows[0].id;
    const rows = await pool.query("select item_id from submissions where room_id = $1 and deleted_at is null", [roomId]);
    assert.deepEqual(rows.rows.map((r) => r.item_id), ["d2"]);
    assert.equal(
      (await pool.query("select 1 from submissions where room_id = $1 and item_id = 'd1' and deleted_at is not null", [roomId])).rowCount,
      1,
    );
  });

  test("Step 5 supplements and Step 11 ideas keep explicit deletion tombstones", async () => {
    const code = await newRoom();
    const session = await joinRoom(code, "u1", "小安");
    const first = await post(
      `/api/rooms/${code}/state`,
      {
        step: 11,
        baseRevision: 0,
        snapshot: snapshot({
          problemDetails: [{ id: "pd1", text: "需要保留的補充", createdBy: "u1", contentVersion: 10 }],
          problemDetailsVersion: 10,
          goalIdeas: [{ id: "gi1", text: "需要保留的目標想法", createdBy: "u1", contentVersion: 10 }],
          goalIdeasVersion: 10,
        }),
      },
      auth(session.token),
    );
    assert.equal(first.statusCode, 200, first.body);
    const removed = await post(
      `/api/rooms/${code}/state`,
      {
        step: 11,
        baseRevision: json(first).revision,
        snapshot: snapshot({
          problemDetails: [],
          problemDetailsVersion: 11,
          deletedProblemDetailIds: ["pd1"],
          goalIdeas: [],
          goalIdeasVersion: 11,
          deletedGoalIdeaIds: ["gi1"],
        }),
      },
      auth(session.token),
    );
    assert.equal(removed.statusCode, 200, removed.body);
    const hydrated = json(await get(`/api/rooms/${code}/state`, auth(session.token)));
    assert.deepEqual(hydrated.snapshot.problemDetails, []);
    assert.deepEqual(hydrated.snapshot.goalIdeas, []);
    assert.deepEqual(hydrated.snapshot.deletedProblemDetailIds, ["pd1"]);
    assert.deepEqual(hydrated.snapshot.deletedGoalIdeaIds, ["gi1"]);
  });

  test("a member cannot tombstone another member's details or goal ideas", async () => {
    const code = await newRoom();
    const owner = await joinRoom(code, "u1", "小安");
    const other = await joinRoom(code, "u2", "小美");
    const created = await post(
      `/api/rooms/${code}/state`,
      {
        step: 11,
        baseRevision: 0,
        snapshot: snapshot({
          problemDetails: [{ id: "pd1", text: "小安的補充", createdBy: "u1", contentVersion: 10 }],
          problemDetailsVersion: 10,
          goalIdeas: [{ id: "gi1", text: "小安的目標", createdBy: "u1", contentVersion: 10 }],
          goalIdeasVersion: 10,
        }),
      },
      auth(owner.token),
    );
    assert.equal(created.statusCode, 200, created.body);

    const attempted = await post(
      `/api/rooms/${code}/state`,
      {
        step: 11,
        baseRevision: json(created).revision,
        snapshot: snapshot({
          problemDetails: [],
          problemDetailsVersion: 11,
          deletedProblemDetailIds: ["pd1"],
          goalIdeas: [],
          goalIdeasVersion: 11,
          deletedGoalIdeaIds: ["gi1"],
        }),
      },
      auth(other.token),
    );
    assert.equal(attempted.statusCode, 200, attempted.body);

    const hydrated = json(await get(`/api/rooms/${code}/state`, auth(owner.token)));
    assert.deepEqual(hydrated.snapshot.problemDetails.map((item) => item.id), ["pd1"]);
    assert.deepEqual(hydrated.snapshot.goalIdeas.map((item) => item.id), ["gi1"]);
  });

  test("the exported artifact is stored against the room", async () => {
    const code = await newRoom();
    const session = await joinRoom(code, "u1", "小安", 19);
    const created = await post(
      `/api/rooms/${code}/artifacts`,
      { format: "text", filename: "魚骨洞天成果.txt", content: "主要問題：忘記作業期限" },
      auth(session.token),
    );
    assert.equal(created.statusCode, 201);

    assert.equal((await post(`/api/rooms/${code}/artifacts`, { format: "pdf", content: "x" }, auth(session.token))).statusCode, 400);
    assert.equal((await post(`/api/rooms/${code}/artifacts`, { format: "text", content: "" }, auth(session.token))).statusCode, 400);

    const roomId = (await pool.query("select id from rooms where lower(code) = $1", [code])).rows[0].id;
    const rows = await pool.query("select format, content, exported_by from artifacts where room_id = $1", [roomId]);
    assert.equal(rows.rows.length, 1);
    assert.equal(rows.rows[0].format, "text");
    assert.equal(rows.rows[0].exported_by, "u1");
    assert.match(rows.rows[0].content, /忘記作業期限/);
  });

  test("a snapshot with duplicate ids does not wedge the room", async () => {
    const code = await newRoom();
    const session = await joinRoom(code, "u1", "小安");

    const hostile = await post(
      `/api/rooms/${code}/state`,
      {
        step: 2,
        baseRevision: 0,
        snapshot: {
          sources: [
            { id: "u1", name: "小安", joined: true },
            { id: "u1", name: "小安", joined: true },
          ],
          distresses: [
            { id: "d1", text: "第一次", createdBy: "u1" },
            { id: "d1", text: "重複的 id", createdBy: "u1" },
          ],
          groupProposals: [
            { id: "gp1", source: "u1", groups: [] },
            { id: "gp1", source: "u1", groups: [] },
          ],
          groupingRound: 1e10,
          groupingVotes: { u1: { value: "gp1", round: 1e10 } },
        },
      },
      auth(session.token),
    );
    assert.equal(hostile.statusCode, 200);

    const after = await post(
      `/api/rooms/${code}/state`,
      {
        step: 2,
        baseRevision: json(hostile).revision,
        snapshot: snapshot({ distresses: [{ id: "d2", text: "後續照常", createdBy: "u1" }] }),
      },
      auth(session.token),
    );
    assert.equal(after.statusCode, 200);

    const roomId = (await pool.query("select id from rooms where lower(code) = $1", [code])).rows[0].id;
    const rows = await pool.query("select item_id from submissions where room_id = $1", [roomId]);
    assert.deepEqual(rows.rows.map((r) => r.item_id).sort(), ["d1", "d2"]);
  });

  test("the projection never blanks a display name it already has", async () => {
    const code = await newRoom();
    const session = await joinRoom(code, "u1", "小安");
    await post(
      `/api/rooms/${code}/state`,
      { step: 2, baseRevision: 0, snapshot: { sources: [{ id: "u1", joined: true }], distresses: [] } },
      auth(session.token),
    );

    const roomId = (await pool.query("select id from rooms where lower(code) = $1", [code])).rows[0].id;
    const rows = await pool.query("select display_name from members where room_id = $1 and member_id = 'u1'", [roomId]);
    assert.equal(rows.rows[0].display_name, "小安");
  });

  test("a long poll is released as soon as another device writes", async () => {
    const code = await newRoom();
    const session = await joinRoom(code, "u1", "小安");

    const began = Date.now();
    const held = get(`/api/rooms/${code}/state?since=0&wait=1`, auth(session.token));
    setTimeout(() => {
      void post(
        `/api/rooms/${code}/state`,
        { step: 2, baseRevision: 0, snapshot: snapshot({ distresses: [{ id: "d1", text: "晚點才寫", createdBy: "u1" }] }) },
        auth(session.token),
      );
    }, 150);

    const response = json(await held);
    const elapsed = Date.now() - began;
    assert.equal(response.revision, 1);
    assert.deepEqual(response.snapshot.distresses.map((d) => d.id), ["d1"]);
    assert.ok(elapsed < 1500, `long poll took ${elapsed}ms, expected release on write`);
  });

  test("a quiet long poll answers unchanged instead of hanging forever", async () => {
    const code = await newRoom();
    const session = await joinRoom(code, "u1", "小安");
    const began = Date.now();
    const response = json(await get(`/api/rooms/${code}/state?since=0&wait=1`, auth(session.token)));
    const elapsed = Date.now() - began;
    assert.equal(response.unchanged, true);
    assert.ok(elapsed >= 1800 && elapsed < 6000, `hold lasted ${elapsed}ms, expected about 2000ms`);
  });

  test("an expired session is refused, and re-joining issues a new one", async () => {
    const code = await newRoom();
    const session = await joinRoom(code, "u1", "小安");
    assert.equal((await get(`/api/rooms/${code}/state`, auth(session.token))).statusCode, 200);

    await pool.query(
      "update members set session_expires_at = now() - interval '1 minute' where member_id = 'u1'",
    );
    const stale = await get(`/api/rooms/${code}/state`, auth(session.token));
    assert.equal(stale.statusCode, 404);
    assert.deepEqual(json(stale), { error: "room_not_found" });

    // This is how the client tells "session expired" from "room deleted"
    // without the server ever having to say which.
    const again = await joinRoom(code, "u1", "小安", 2, auth(session.token));
    assert.notEqual(again.token, session.token);
    assert.equal((await get(`/api/rooms/${code}/state`, auth(again.token))).statusCode, 200);
  });

  test("retention deletes expired rooms outright", async () => {
    const code = await newRoom();
    const session = await joinRoom(code, "u1", "小安");
    await post(
      `/api/rooms/${code}/state`,
      { step: 2, baseRevision: 0, snapshot: snapshot({ distresses: [{ id: "d1", text: "舊資料", createdBy: "u1" }] }) },
      auth(session.token),
    );

    const roomId = (await pool.query("select id from rooms where lower(code) = $1", [code])).rows[0].id;
    await pool.query("update rooms set last_activity_at = now() - interval '40 days' where id = $1", [roomId]);

    const store = new RoomStore(pool);
    assert.deepEqual(
      await store.purgeExpired(3650),
      { deletedRooms: 0, codes: [] },
      "the configured period must be respected",
    );

    const { deletedRooms, codes } = await store.purgeExpired(30);
    assert.ok(deletedRooms >= 1);
    assert.ok(codes.includes(code), "purge must return the codes it deleted");

    assert.equal((await pool.query("select 1 from rooms where id = $1", [roomId])).rowCount, 0);
    assert.equal((await pool.query("select 1 from submissions where room_id = $1", [roomId])).rowCount, 0);
    assert.equal((await pool.query("select 1 from members where room_id = $1", [roomId])).rowCount, 0);
    assert.equal((await pool.query("select 1 from vote_rounds where room_id = $1", [roomId])).rowCount, 0);
  });

  test("a sweep that would delete an unusual share of rooms stops itself", async () => {
    for (let at = 0; at < 3; at += 1) {
      const code = await newRoom();
      await joinRoom(code, "u1", "小安", 1);
    }
    await pool.query("update rooms set last_activity_at = now() - interval '400 days'");

    const store = new RoomStore(pool);
    const warnings = [];
    const logger = {
      info: () => {},
      warn: (payload, message) => warnings.push({ payload, message }),
      error: () => {},
    };

    const guarded = startRetentionSweeper(store, logger, {
      retentionDays: 30,
      intervalMinutes: 60,
      bulkDeleteFraction: 0.25,
      bulkDeleteMinimum: 2,
      confirmBulkDelete: false,
    });
    guarded.stop();
    assert.equal(await guarded.runOnce(), 0, "the guard must refuse the sweep");
    assert.equal(warnings.length >= 1, true, "and must say why");
    assert.ok((await pool.query("select 1 from rooms")).rowCount >= 3, "nothing may be deleted");

    const confirmed = startRetentionSweeper(store, logger, {
      retentionDays: 30,
      intervalMinutes: 60,
      bulkDeleteFraction: 0.25,
      bulkDeleteMinimum: 2,
      confirmBulkDelete: true,
    });
    confirmed.stop();
    await confirmed.runOnce();
    // The end state, not the return value: startRetentionSweeper also fires a
    // sweep of its own on construction, and whichever of the two gets there
    // first is a race. Both are the same sweep, so the room count is not.
    assert.equal(
      (await pool.query("select count(*)::int as n from rooms")).rows[0].n,
      0,
      "confirmation must lift the guard",
    );
  });

  test("a room coded by hand before this scheme can still be exported and deleted", async () => {
    // Rooms like this exist only from before server-issued codes. They cannot
    // be joined any more, so without a lenient admin lookup they would be
    // unreachable until the retention sweep removed them unseen.
    await pool.query("insert into rooms (code) values ('FISH-042')");

    const refused = await post("/api/rooms/FISH-042/join", { memberId: "u1", name: "小安", step: 2 });
    assert.equal(refused.statusCode, 400);
    assert.equal(json(refused).error, "bad_room_code");

    const authorized = auth(process.env.ADMIN_TOKEN);
    const exported = await get("/api/admin/rooms/FISH-042/export", authorized);
    assert.equal(exported.statusCode, 200);
    assert.equal(json(exported).room.code, "FISH-042");

    const removed = await app.inject({ method: "DELETE", url: "/api/admin/rooms/FISH-042", headers: authorized });
    assert.equal(removed.statusCode, 200);
    assert.equal(json(removed).deleted, true);
  });

  test("admin routes need the token", async () => {
    const code = await newRoom();
    const session = await joinRoom(code, "u1", "小安");

    assert.equal((await get(`/api/admin/rooms/${code}/export`)).statusCode, 401);
    assert.equal((await get(`/api/admin/rooms/${code}/export`, auth("wrong"))).statusCode, 401);

    const authorized = auth(process.env.ADMIN_TOKEN);
    const exported = await get(`/api/admin/rooms/${code}/export`, authorized);
    assert.equal(exported.statusCode, 200);
    const body = json(exported);
    assert.equal(body.room.code, code);
    assert.ok(Array.isArray(body.members));

    const removed = await app.inject({ method: "DELETE", url: `/api/admin/rooms/${code}`, headers: authorized });
    assert.equal(removed.statusCode, 200);
    assert.equal(json(removed).deleted, true);

    // The room is gone, and the session that opened it goes with it.
    assert.equal((await get(`/api/rooms/${code}/state`, auth(session.token))).statusCode, 404);
  });

  test("authoritative hydrate survives closed clients and a fresh app instance", async () => {
    const created = await post("/api/rooms", { expectedMemberCount: 2 });
    assert.equal(created.statusCode, 201, created.body);
    const code = json(created).room;
    const firstMember = await joinRoom(code, "u1", "小安", 2);
    const secondMember = await joinRoom(code, "u2", "小美", 2);
    const sources = [
      { id: "u1", name: "小安", color: "#276EF1", system: false, joined: true },
      { id: "u2", name: "小美", color: "#E05A47", system: false, joined: true },
      { id: "group", name: "小組提出", color: "#46515f", system: true, joined: true },
    ];
    const write = async (token, baseRevision, step, next) => {
      const response = await post(
        `/api/rooms/${code}/state`,
        { baseRevision, step, snapshot: snapshot({ sources, ...next }) },
        auth(token),
      );
      assert.equal(response.statusCode, 200, response.body);
      return json(response).revision;
    };

    let revision = await write(firstMember.token, 0, 9, {
      distresses: [{ id: "d1", text: "小安的困擾", createdBy: "u1", contentVersion: 1 }],
      groupingRound: 1,
      groupingVotes: { u1: { value: "g1", round: 1, contentVersion: 1 } },
    });
    revision = await write(secondMember.token, revision, 15, {
      distresses: [
        { id: "d1", text: "小安的困擾", createdBy: "u1", contentVersion: 1 },
        { id: "d2", text: "小美的困擾", createdBy: "u2", contentVersion: 2 },
      ],
      causes: [{ id: "c1", text: "真正原因", createdBy: "u2", contentVersion: 2 }],
      methods: [{ id: "m1", text: "可行方法", createdBy: "u2", contentVersion: 2 }],
      groupingRound: 1,
      groupingVotes: {
        u1: { value: "g1", round: 1, contentVersion: 1 },
        u2: { value: "g2", round: 1, contentVersion: 2 },
      },
    });
    revision = await write(firstMember.token, revision, 15, {
      distresses: [{ id: "d2", text: "小美的困擾", createdBy: "u2", contentVersion: 2 }],
      causes: [{ id: "c1", text: "真正原因", createdBy: "u2", contentVersion: 2 }],
      methods: [{ id: "m1", text: "可行方法", createdBy: "u2", contentVersion: 2 }],
      deletedDistressIds: ["d1"],
      distressesVersion: 3,
      groupingRound: 1,
      groupingVotes: { u2: { value: "g2", round: 1, contentVersion: 2 } },
    });

    const assertHydrated = (body) => {
      assert.equal(body.expectedMemberCount, 2);
      assert.equal(body.membersLocked, true);
      assert.deepEqual(body.members.map((member) => member.memberId).sort(), ["u1", "u2"]);
      assert.equal(body.currentStep, 15);
      assert.deepEqual(body.snapshot.distresses.map((item) => item.id), ["d2"]);
      assert.deepEqual(body.snapshot.causes.map((item) => item.id), ["c1"]);
      assert.deepEqual(body.snapshot.methods.map((item) => item.id), ["m1"]);
      assert.deepEqual(body.snapshot.deletedDistressIds, ["d1"]);
      assert.deepEqual(Object.keys(body.snapshot.groupingVotes).sort(), ["u1", "u2"]);
    };
    assertHydrated(json(await get(`/api/rooms/${code}/state`, auth(firstMember.token))));

    const restartedPool = createPool(config);
    const restartedApp = await buildApp(config, restartedPool);
    await restartedApp.ready();
    try {
      const reconnect = await restartedApp.inject({
        method: "POST",
        url: `/api/rooms/${code}/join`,
        payload: { memberId: "u1", name: "小安", step: 2 },
        headers: auth(firstMember.token),
      });
      assert.equal(reconnect.statusCode, 200, reconnect.body);
      assertHydrated(json(reconnect));
    } finally {
      await restartedApp.close();
      await restartedPool.end();
    }
  });
}

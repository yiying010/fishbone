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

  const { buildApp, defaultPublicDir } = await import("../../build/app.js");
  const { loadConfig } = await import("../../build/config.js");
  const { createPool } = await import("../../build/db/pool.js");
  const { runMigrations } = await import("../../build/db/migrate.js");
  const { RoomStore } = await import("../../build/rooms/store.js");

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

  const post = (url, payload) => app.inject({ method: "POST", url, payload });
  const get = (url, headers) => app.inject({ method: "GET", url, headers });

  test("healthz reports the database it actually queried", async () => {
    const response = await get("/healthz");
    assert.equal(response.statusCode, 200);
    const body = json(response);
    assert.equal(body.status, "ok");
    assert.equal(body.database, "ok");
    assert.ok(typeof body.databaseLatencyMs === "number");
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

  test("two devices in one room see each other's cards", async () => {
    const room = "/api/rooms/FISH-TWO";

    const joinA = json(await post(`${room}/join`, { memberId: "u1", name: "小安", step: 2 }));
    const joinB = json(await post(`${room}/join`, { memberId: "u2", name: "阿凱", step: 2 }));
    assert.equal(joinA.revision, 0);
    assert.equal(joinB.revision, 0);

    // Device A submits a card.
    const writeA = await post(`${room}/state`, {
      memberId: "u1",
      step: 2,
      baseRevision: 0,
      snapshot: snapshot({ distresses: [{ id: "d1", text: "我常常忘記作業期限", createdBy: "u1" }] }),
    });
    assert.equal(writeA.statusCode, 200);
    assert.equal(json(writeA).revision, 1);

    // Device B polls with the revision it last saw and gets A's work.
    const pollB = json(await get(`${room}/state?since=0`));
    assert.equal(pollB.revision, 1);
    assert.deepEqual(pollB.snapshot.distresses.map((d) => d.text), ["我常常忘記作業期限"]);

    // Nothing new: the poll answers "unchanged" rather than resending it.
    const idle = json(await get(`${room}/state?since=1`));
    assert.equal(idle.unchanged, true);
    assert.equal(idle.snapshot, undefined);
  });

  test("a simultaneous write is refused with the other device's snapshot, not silently dropped", async () => {
    const room = "/api/rooms/FISH-RACE";
    await post(`${room}/join`, { memberId: "u1", name: "小安", step: 2 });
    await post(`${room}/join`, { memberId: "u2", name: "阿凱", step: 2 });

    // Both devices last saw revision 0.
    const first = await post(`${room}/state`, {
      memberId: "u1",
      step: 2,
      baseRevision: 0,
      snapshot: snapshot({ distresses: [{ id: "d1", text: "A 的困擾", createdBy: "u1" }] }),
    });
    assert.equal(first.statusCode, 200);

    const second = await post(`${room}/state`, {
      memberId: "u2",
      step: 2,
      baseRevision: 0,
      snapshot: snapshot({ distresses: [{ id: "d2", text: "B 的困擾", createdBy: "u2" }] }),
    });
    assert.equal(second.statusCode, 409);
    const conflict = json(second);
    assert.equal(conflict.status, "conflict");
    assert.equal(conflict.revision, 1);
    // The reply carries what B has to merge before retrying.
    assert.deepEqual(conflict.snapshot.distresses.map((d) => d.id), ["d1"]);

    // B merges (the browser does this with mergeRoom) and posts again.
    const retry = await post(`${room}/state`, {
      memberId: "u2",
      step: 2,
      baseRevision: conflict.revision,
      snapshot: snapshot({
        distresses: [
          { id: "d1", text: "A 的困擾", createdBy: "u1" },
          { id: "d2", text: "B 的困擾", createdBy: "u2" },
        ],
      }),
    });
    assert.equal(retry.statusCode, 200);

    const final = json(await get(`${room}/state?since=0`));
    assert.deepEqual(final.snapshot.distresses.map((d) => d.id), ["d1", "d2"]);
  });

  test("room codes match case-insensitively, the way students type them", async () => {
    await post("/api/rooms/Fish-Case/join", { memberId: "u1", name: "小安", step: 2 });
    const state = await get("/api/rooms/fish-case/state");
    assert.equal(state.statusCode, 200);
    assert.equal(json(state).revision, 0);

    const rows = await pool.query("select count(*)::int as n from rooms where lower(code) = 'fish-case'");
    assert.equal(rows.rows[0].n, 1);
  });

  test("the snapshot is projected into queryable rows", async () => {
    const room = "/api/rooms/FISH-PROJ";
    await post(`${room}/join`, { memberId: "u1", name: "小安", step: 9 });
    await post(`${room}/state`, {
      memberId: "u1",
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
    });

    const roomId = (await pool.query("select id from rooms where lower(code) = 'fish-proj'")).rows[0].id;

    const subs = await pool.query(
      "select kind, item_id, step, author_member_id, body, status from submissions where room_id = $1 order by kind",
      [roomId],
    );
    assert.deepEqual(subs.rows.map((r) => [r.kind, r.item_id, r.step]), [
      ["cause", "c1", 7],
      ["distress", "d1", 2],
      ["reflection", "r1", 18],
    ]);
    assert.equal(subs.rows.find((r) => r.kind === "cause").status, "已確認為原因");

    const groupings = await pool.query(
      "select kind, proposal_id, title, is_official, payload from groupings where room_id = $1",
      [roomId],
    );
    assert.equal(groupings.rows.length, 1);
    assert.equal(groupings.rows[0].is_official, true);
    assert.equal(groupings.rows[0].title, "小安");
    assert.deepEqual(groupings.rows[0].payload.groups, [{ name: "作業", ids: ["d1"] }]);

    // Both the current round and the earlier one are kept: how a decision was
    // reached is part of the record.
    const rounds = await pool.query(
      "select round from vote_rounds where room_id = $1 and kind = 'grouping' order by round",
      [roomId],
    );
    assert.deepEqual(rounds.rows.map((r) => r.round), [1, 2]);
    const votes = await pool.query(
      "select round, member_id, value from votes where room_id = $1 and kind = 'grouping' order by round",
      [roomId],
    );
    assert.deepEqual(votes.rows.map((r) => [r.round, r.member_id]), [[1, "u2"], [2, "u1"]]);

    // The room's step is the furthest any member has reached.
    const roomRow = await pool.query("select current_step from rooms where id = $1", [roomId]);
    assert.equal(roomRow.rows[0].current_step, 9);
  });

  test("a deleted card disappears from the projection too", async () => {
    const room = "/api/rooms/FISH-DEL";
    await post(`${room}/join`, { memberId: "u1", name: "小安", step: 2 });
    await post(`${room}/state`, {
      memberId: "u1",
      step: 2,
      baseRevision: 0,
      snapshot: snapshot({
        distresses: [
          { id: "d1", text: "一", createdBy: "u1" },
          { id: "d2", text: "二", createdBy: "u1" },
        ],
      }),
    });
    await post(`${room}/state`, {
      memberId: "u1",
      step: 2,
      baseRevision: 1,
      snapshot: snapshot({ distresses: [{ id: "d2", text: "二", createdBy: "u1" }] }),
    });

    const roomId = (await pool.query("select id from rooms where lower(code) = 'fish-del'")).rows[0].id;
    const rows = await pool.query("select item_id from submissions where room_id = $1", [roomId]);
    assert.deepEqual(rows.rows.map((r) => r.item_id), ["d2"]);
  });

  test("the exported artifact is stored against the room", async () => {
    const room = "/api/rooms/FISH-ART";
    await post(`${room}/join`, { memberId: "u1", name: "小安", step: 19 });
    const created = await post(`${room}/artifacts`, {
      memberId: "u1",
      format: "text",
      filename: "魚骨洞天成果.txt",
      content: "主要問題：忘記作業期限",
    });
    assert.equal(created.statusCode, 201);

    assert.equal((await post(`${room}/artifacts`, { format: "pdf", content: "x" })).statusCode, 400);
    assert.equal((await post(`${room}/artifacts`, { format: "text", content: "" })).statusCode, 400);

    const roomId = (await pool.query("select id from rooms where lower(code) = 'fish-art'")).rows[0].id;
    const rows = await pool.query("select format, filename, content from artifacts where room_id = $1", [roomId]);
    assert.equal(rows.rows.length, 1);
    assert.equal(rows.rows[0].format, "text");
    assert.match(rows.rows[0].content, /忘記作業期限/);
  });

  test("writing to a room nobody joined is a client error, not a new room", async () => {
    const response = await post("/api/rooms/FISH-GHOST/state", {
      memberId: "u1",
      step: 2,
      baseRevision: 0,
      snapshot: snapshot(),
    });
    assert.equal(response.statusCode, 400);
    assert.match(json(response).message, /does not exist/);
    assert.equal((await get("/api/rooms/FISH-GHOST/state")).statusCode, 404);
  });

  test("a long poll is released as soon as another device writes", async () => {
    const room = "/api/rooms/FISH-HOLD";
    await post(`${room}/join`, { memberId: "u1", name: "小安", step: 2 });

    const began = Date.now();
    const held = get(`${room}/state?since=0&wait=1`);
    setTimeout(() => {
      void post(`${room}/state`, {
        memberId: "u1",
        step: 2,
        baseRevision: 0,
        snapshot: snapshot({ distresses: [{ id: "d1", text: "晚點才寫", createdBy: "u1" }] }),
      });
    }, 150);

    const response = json(await held);
    const elapsed = Date.now() - began;
    assert.equal(response.revision, 1);
    assert.deepEqual(response.snapshot.distresses.map((d) => d.id), ["d1"]);
    // Released by the write, well before the 2s hold configured above.
    assert.ok(elapsed < 1500, `long poll took ${elapsed}ms, expected release on write`);
  });

  test("a quiet long poll answers unchanged instead of hanging forever", async () => {
    const room = "/api/rooms/FISH-QUIET";
    await post(`${room}/join`, { memberId: "u1", name: "小安", step: 2 });
    const began = Date.now();
    const response = json(await get(`${room}/state?since=0&wait=1`));
    const elapsed = Date.now() - began;
    assert.equal(response.unchanged, true);
    assert.ok(elapsed >= 1800 && elapsed < 6000, `hold lasted ${elapsed}ms, expected about 2000ms`);
  });

  test("retention deletes expired rooms outright", async () => {
    const room = "/api/rooms/FISH-OLD";
    await post(`${room}/join`, { memberId: "u1", name: "小安", step: 2 });
    await post(`${room}/state`, {
      memberId: "u1",
      step: 2,
      baseRevision: 0,
      snapshot: snapshot({ distresses: [{ id: "d1", text: "舊資料", createdBy: "u1" }] }),
    });

    const roomId = (await pool.query("select id from rooms where lower(code) = 'fish-old'")).rows[0].id;
    await pool.query("update rooms set last_activity_at = now() - interval '40 days' where id = $1", [roomId]);

    const store = new RoomStore(pool);
    assert.deepEqual(await store.purgeExpired(3650), { deletedRooms: 0 }, "the configured period must be respected");

    const { deletedRooms } = await store.purgeExpired(30);
    assert.ok(deletedRooms >= 1);

    // Hard delete: the room and everything hanging off it are gone, not flagged.
    assert.equal((await pool.query("select 1 from rooms where id = $1", [roomId])).rowCount, 0);
    assert.equal((await pool.query("select 1 from submissions where room_id = $1", [roomId])).rowCount, 0);
    assert.equal((await pool.query("select 1 from members where room_id = $1", [roomId])).rowCount, 0);
  });

  test("admin routes need the token", async () => {
    const room = "/api/rooms/FISH-ADMIN";
    await post(`${room}/join`, { memberId: "u1", name: "小安", step: 2 });

    assert.equal((await get(`/api/admin/rooms/FISH-ADMIN/export`)).statusCode, 401);
    assert.equal(
      (await get(`/api/admin/rooms/FISH-ADMIN/export`, { authorization: "Bearer wrong" })).statusCode,
      401,
    );

    const authorized = { authorization: `Bearer ${process.env.ADMIN_TOKEN}` };
    const exported = await get(`/api/admin/rooms/FISH-ADMIN/export`, authorized);
    assert.equal(exported.statusCode, 200);
    const body = json(exported);
    assert.equal(body.room.code, "FISH-ADMIN");
    assert.ok(Array.isArray(body.members));

    const removed = await app.inject({
      method: "DELETE",
      url: "/api/admin/rooms/FISH-ADMIN",
      headers: authorized,
    });
    assert.equal(removed.statusCode, 200);
    assert.equal(json(removed).deleted, true);
    assert.equal((await get("/api/rooms/FISH-ADMIN/state")).statusCode, 404);
  });
}

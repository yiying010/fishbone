/**
 * Runs the real frontend scripts against a real server.
 *
 * frontend.test.mjs asserts on the text of these files, which proves a string
 * is present and nothing about whether the flow works: a handler that throws on
 * its first line passes every one of those assertions. This file executes the
 * shipped scripts instead, so joining, session ownership and the Step 14 review
 * are observed end to end rather than inferred from source.
 *
 * Only the browser surface is stubbed - storage, DOM lookups, rendering and
 * speech. Everything the assertions are about is the code the browser runs.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const databaseUrl = process.env.TEST_DATABASE_URL;

if (!databaseUrl) {
  test("frontend behavior tests", { skip: "TEST_DATABASE_URL is not set" }, () => {});
} else {
  process.env.DATABASE_URL = databaseUrl;
  process.env.DATA_RETENTION_DAYS ??= "3650";
  process.env.LOG_LEVEL ??= "silent";
  process.env.SYNC_LONG_POLL_MS ??= "0";
  process.env.RATE_LIMIT_REQUESTS_PER_MINUTE ??= "10000000";
  process.env.RATE_LIMIT_LOOKUP_FAILURES_PER_MINUTE ??= "100000";
  process.env.RATE_LIMIT_ROOM_CREATES_PER_HOUR ??= "100000";
  process.env.AI_ENABLED = "true";
  process.env.OPENAI_API_KEY = "test-key-never-sent-anywhere";
  process.env.AI_REQUESTS_PER_MEMBER_PER_MINUTE = "1000";

  /*
   * The provider is replaced at the network edge rather than by injecting a
   * fake service, so OpenAiReviewClient itself is exercised: the request it
   * builds and the Responses-shaped payload it has to read are part of what is
   * under test. Everything that is not the provider passes straight through.
   *
   * Installed before buildApp, because the client captures the global fetch at
   * construction time.
   */
  const realFetch = globalThis.fetch;
  let aiReview = null;
  globalThis.fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith("https://api.openai.com/")) return realFetch(input, init);
    if (aiReview === null) return new Response("upstream is down", { status: 500 });
    const sent = JSON.parse(init.body);
    const content = JSON.parse(String(sent.input).split("\n").slice(1).join("\n"));
    return new Response(JSON.stringify({
      id: "resp_test",
      model: "test-model",
      status: "completed",
      output: [{ content: [{ type: "output_text", text: JSON.stringify(aiReview({ task: sent.text.format.name, content })) }] }],
      usage: { input_tokens: 10, output_tokens: 10 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  test.after(() => { globalThis.fetch = realFetch; });

  const { buildApp, defaultPublicDir } = await import("../../build/app.js");
  const { loadConfig } = await import("../../build/config.js");
  const { createPool } = await import("../../build/db/pool.js");
  const { runMigrations } = await import("../../build/db/migrate.js");

  const config = loadConfig(defaultPublicDir());
  const pool = createPool(config);
  await runMigrations(pool, { info: () => {} });

  // A real listener, because the scripts call global fetch with a URL.
  const app = await buildApp(config, pool);
  const origin = await app.listen({ host: "127.0.0.1", port: 0 });

  test.after(async () => {
    await app.close();
    await pool.end();
  });

  // Every script the page loads, in document order, minus the bootstrap that
  // wires DOM events and starts rendering.
  const SCRIPTS = [
    "fishbone-foundation.js",
    "fishbone-room-state.js",
    "fishbone-sync-client.js",
    "fishbone-sync-loop.js",
    "fishbone-activity-rules.js",
    "fishbone-outcomes.js",
    "fishbone-progression.js",
    "fishbone-collaboration.js",
    "fishbone-grouping.js",
    "fishbone-problem-goal.js",
    "fishbone-runtime.js",
    "fishbone-steps-start.js",
    "fishbone-steps-analysis.js",
    "fishbone-steps-solution.js",
    "fishbone-cards.js",
    "fishbone-methods.js",
    "fishbone-diagram-data.js",
    "fishbone-svg.js",
  ];
  const sources = await Promise.all(
    SCRIPTS.map((file) => readFile(new URL(`../../public/${file}`, import.meta.url), "utf8")),
  );

  const EXPORTS = [
    "S", "SYNC", "connectRoom", "recoverSession", "completeMethodCheck", "methodEditSoft",
    "requestAiReview", "sharedSnapshot", "canonJson", "loadRoomToken", "pushRoom",
    "runMethodAiCheck",
  ];
  const body = `${sources.join("\n;\n")}\n;return {${EXPORTS.join(",")}};`;

  /**
   * One browser tab. sessionStorage is per tab, localStorage is shared, which
   * is exactly the distinction the session-token design rests on.
   */
  const sharedLocal = new Map();
  // connectRoom starts a poll loop that runs for as long as the tab is in a
  // room. Left running, it keeps the process alive after the last assertion.
  const openTabs = [];
  test.after(() => {
    for (const tab of openTabs) {
      tab.SYNC.session = 0;
      tab.S.joined = false;
      if (tab.SYNC.pushTimer) clearTimeout(tab.SYNC.pushTimer);
    }
  });

  function openTab(sessionStore = new Map()) {
    const store = (map) => ({
      getItem: (key) => (map.has(key) ? map.get(key) : null),
      setItem: (key, value) => map.set(key, String(value)),
      removeItem: (key) => map.delete(key),
    });
    /*
     * Only the browser is stubbed, never the app's own functions: $, render,
     * showGate and setSyncStatus are all declared by these scripts, so passing
     * replacements would be a redeclaration. Elements are permissive and kept
     * by id, which lets the real render() run and lets a test read back what
     * the student was actually shown.
     */
    const elements = new Map();
    const element = () => new Proxy(
      { style: {}, classList: { add() {}, remove() {}, toggle() {} }, dataset: {},
        textContent: "", innerHTML: "", className: "", value: undefined },
      { get: (target, prop) => (prop in target ? target[prop] : () => {}) },
    );
    const byId = (id) => {
      if (!elements.has(id)) elements.set(id, element());
      return elements.get(id);
    };
    const scope = {
      location: { protocol: "http:", pathname: "/fishbone.html", href: `${origin}/fishbone.html` },
      window: { addEventListener() {}, removeEventListener() {} },
      document: {
        getElementById: byId,
        querySelector: () => element(),
        querySelectorAll: () => [],
        addEventListener() {},
        createElement: () => element(),
        title: "",
      },
      navigator: { language: "zh-TW" },
      sessionStorage: store(sessionStore),
      localStorage: store(sharedLocal),
      // The scripts build a same-origin path from location.pathname; the test
      // server is on an ephemeral port, so resolve that path against it.
      fetch: (url, init) => fetch(new URL(url, origin), init),
      alert() {},
      confirm: () => true,
    };
    const made = new Function(...Object.keys(scope), body)(...Object.values(scope));
    const tab = { ...made, elements, shown: () => String(byId("gateMsg").innerHTML), sessionStore };
    openTabs.push(tab);
    return tab;
  }

  const newRoom = async () => {
    const response = await fetch(new URL("/api/rooms", origin), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(response.status, 201);
    return (await response.json()).room;
  };

  test("a tab joins, stores its token, and a reload keeps the same member id", async () => {
    const code = await newRoom();
    const tab = openTab();
    tab.S.roomCode = code;
    tab.S.nameDraft = "小安";
    tab.S.joined = true;

    assert.equal(await tab.connectRoom(true), "ok");
    assert.notEqual(tab.SYNC.token, "");
    assert.equal(tab.loadRoomToken(code), tab.SYNC.token, "the token must survive in sessionStorage");

    // A reload is a fresh scope with the same sessionStorage: same member id,
    // same stored token, so the server lets it rotate the session.
    const reloaded = openTab(tab.sessionStore);
    reloaded.S.roomCode = code;
    reloaded.S.nameDraft = "小安";
    reloaded.S.joined = true;
    assert.equal(reloaded.S.selfId, tab.S.selfId, "the member id is tab-scoped, not per load");
    assert.equal(await reloaded.connectRoom(true), "ok");
    assert.notEqual(reloaded.SYNC.token, tab.SYNC.token, "the session rotates on re-join");
  });

  test("a second tab cannot take over a member id it does not hold the token for", async () => {
    const code = await newRoom();
    const owner = openTab();
    owner.S.roomCode = code;
    owner.S.nameDraft = "小安";
    owner.S.joined = true;
    assert.equal(await owner.connectRoom(true), "ok");

    // A fresh tab that has somehow been handed the same member id but not the
    // token: this is the takeover the server refuses.
    const other = openTab();
    other.S.roomCode = code;
    other.S.nameDraft = "冒用者";
    other.S.joined = true;
    other.S.selfId = owner.S.selfId;
    assert.equal(await other.connectRoom(true), "taken");
    assert.equal(other.SYNC.session, 0, "no half-live session is left behind");

    // A genuinely new tab gets its own id and joins normally.
    const fresh = openTab();
    fresh.S.roomCode = code;
    fresh.S.nameDraft = "阿凱";
    fresh.S.joined = true;
    assert.notEqual(fresh.S.selfId, owner.S.selfId);
    assert.equal(await fresh.connectRoom(true), "ok");
  });

  /** Puts a room at Step 14 with one method card owned by this tab. */
  async function joinedAtStep14(code, name = "小安") {
    const tab = openTab();
    tab.S.roomCode = code;
    tab.S.nameDraft = name;
    tab.S.joined = true;
    assert.equal(await tab.connectRoom(true), "ok");
    tab.S.step = 14;
    tab.S.active = tab.S.selfId;
    tab.S.problem = "小組作業常常無法準時完成。";
    tab.S.goal = "建立清楚的作業安排，減少遲交。";
    tab.S.causes = [{ id: "c1", text: "沒有先整理截止日期", createdBy: tab.S.selfId, status: "已確認為原因" }];
    tab.S.methods = [{
      id: "m1",
      text: "每天放學後花十分鐘把所有作業的截止日期抄進共用行事曆",
      createdBy: tab.S.selfId,
      status: "草稿",
      causes: ["c1"],
      effect: "小組每天都看得到最近要交的作業，就不會漏掉期限",
    }];
    assert.equal(await tab.pushRoom(), true, "the room must accept this state");
    return tab;
  }

  /** completeMethodCheck deliberately does not await; wait for it to settle. */
  async function settled(tab, id) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const card = tab.S.methods.find((m) => m.id === id);
      if (card !== undefined && card.status !== "AI檢查中") return card;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("the card never left AI檢查中");
  }

  test("pressing 送交 AI 檢查 reaches the provider and applies the verdict to the card", async () => {
    const code = await newRoom();
    const tab = await joinedAtStep14(code);

    let seen = null;
    aiReview = (input) => {
      seen = input;
      return { verdict: "pass", reason: "方法具體，也連得回目標。", revision_suggestion: null };
    };
    try {
      tab.completeMethodCheck("m1");
      assert.equal(tab.S.methods[0].status, "AI檢查中", "the card shows as in progress straight away");
      const card = await settled(tab, "m1");

      assert.equal(card.status, "已完成對應檢查");
      assert.match(card.checkMsg, /^AI 建議：/);
      assert.match(card.checkMsg, /方法具體/);
      // The server answered from its own snapshot, so the card had to be
      // published first. That is the whole point of publishForAi.
      assert.equal(seen.task, "fishbone_step14_method");
      assert.equal(seen.content.method, tab.S.methods[0].text);
      assert.equal(seen.content.support_explanation, tab.S.methods[0].effect);
      assert.deepEqual(seen.content.linked_causes, ["沒有先整理截止日期"]);
      // Nothing that identifies a student may reach the provider.
      assert.doesNotMatch(JSON.stringify(seen), /小安|createdBy|sources/);
    } finally {
      aiReview = null;
    }
  });

  test("a revise verdict carries the suggestion and sends the card back for editing", async () => {
    const code = await newRoom();
    const tab = await joinedAtStep14(code);

    aiReview = () => ({ verdict: "revise", reason: "還沒說明誰負責。", revision_suggestion: "指定一位同學每天更新。" });
    try {
      tab.completeMethodCheck("m1");
      const card = await settled(tab, "m1");
      assert.equal(card.status, "需要修改說明");
      assert.match(card.checkMsg, /指定一位同學每天更新。/);
      assert.match(tab.shown(), /指定一位同學/, "the student is shown why");
    } finally {
      aiReview = null;
    }
  });

  test("an unpublished edit is published before the review, not left on the device", async () => {
    const code = await newRoom();
    const tab = await joinedAtStep14(code);

    // Typing goes through the soft edit, which does not render and does not
    // push immediately. The server still holds the older wording at this point.
    tab.methodEditSoft("m1", "effect", "改成新的說明：讓小組每天看到最近的期限");
    assert.notEqual(tab.canonJson(tab.sharedSnapshot()), tab.SYNC.serverJson, "the edit is local at this point");

    let seen = null;
    aiReview = (input) => {
      seen = input;
      return { verdict: "suggest", reason: "再說明誰負責。", revision_suggestion: "指定一位同學負責更新。" };
    };
    try {
      const response = await tab.requestAiReview("step14_method", "m1");
      assert.equal(response.status, "ok");
      assert.equal(seen.content.support_explanation, "改成新的說明：讓小組每天看到最近的期限");
      assert.equal(tab.canonJson(tab.sharedSnapshot()), tab.SYNC.serverJson, "the room now holds the edit");
    } finally {
      aiReview = null;
    }
  });

  test("with no AI configured the student is told it was the local rule check", async () => {
    const code = await newRoom();
    const tab = await joinedAtStep14(code);

    // aiReview stays null, so the provider answers 500 and the route reports it
    // unavailable. The label is what stops a keyword heuristic being presented
    // to a student as an AI judgement.
    assert.equal((await tab.requestAiReview("step14_method", "m1")).status, "unavailable");

    tab.completeMethodCheck("m1");
    const card = await settled(tab, "m1");
    assert.match(card.checkMsg, /^本機規則檢查：/);
    assert.doesNotMatch(card.checkMsg, /AI 建議/);
    assert.ok(["已完成對應檢查", "需要修改說明"].includes(card.status), `unexpected status ${card.status}`);
  });
}

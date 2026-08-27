import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

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
  "fishbone-revote.js",
  "fishbone-diagram-data.js",
  "fishbone-svg.js",
  "fishbone-revision.js",
];

const sources = await Promise.all(
  SCRIPTS.map((file) => readFile(new URL(`../../public/${file}`, import.meta.url), "utf8")),
);

function openTab() {
  const elements = new Map();
  const element = () => new Proxy(
    {
      style: {},
      classList: { add() {}, remove() {}, toggle() {} },
      dataset: {},
      textContent: "",
      innerHTML: "",
      value: "",
      focus() {},
      blur() {},
      scrollIntoView() {},
    },
    { get: (target, prop) => (prop in target ? target[prop] : () => {}) },
  );
  const byId = (id) => {
    if (!elements.has(id)) elements.set(id, element());
    return elements.get(id);
  };
  const storage = new Map();
  const storageStub = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
  };
  const scope = {
    console,
    structuredClone,
    setTimeout,
    clearTimeout,
    URL,
    location: { protocol: "http:", pathname: "/fishbone.html", href: "http://example.test/fishbone.html" },
    navigator: { language: "zh-TW" },
    sessionStorage: storageStub,
    localStorage: storageStub,
    fetch: async () => { throw new Error("unexpected network call"); },
    alert() {},
    confirm: () => true,
    addEventListener() {},
    removeEventListener() {},
    document: {
      activeElement: null,
      title: "",
      getElementById: byId,
      querySelector: () => element(),
      querySelectorAll: () => [],
      addEventListener() {},
      createElement: () => element(),
    },
  };
  scope.window = scope;
  scope.globalThis = scope;
  const context = vm.createContext(scope);
  for (const [index, source] of sources.entries()) {
    vm.runInContext(source, context, { filename: SCRIPTS[index] });
  }
  const api = vm.runInContext(`({
    S, sharedSnapshot, mergeRoom, applyRemote, startRevisionChain, revisionCheckpointRequired,
    invalidateRevisionChange,
    revisionBanner, nextStep, addProblemDetail, editCause, addSpoken,
    submitMethodClass, step15
  })`, context);
  return { ...api, elements, element: byId, shown: () => String(byId("gateMsg").innerHTML) };
}

function activate(tab, name) {
  tab.S.joined = true;
  tab.S.active = tab.S.selfId;
  tab.S.nameDraft = name;
  const self = tab.S.sources.find((source) => source.id === tab.S.selfId);
  self.name = name;
  self.joined = true;
}

test("a Step 5 edit keeps Step 7 reusable while a Step 7 edit invalidates only its real dependants", () => {
  const tab = openTab();
  activate(tab, "A");
  tab.S.problem = "作業太多，不知道先做什麼。";
  tab.S.problemOk = true;
  tab.S.confirmBy.problem = tab.S.selfId;
  tab.S.causes = [{
    id: "c-own",
    text: "沒有整理截止日期",
    source: tab.S.selfId,
    createdBy: tab.S.selfId,
    status: "已確認為原因",
  }];

  assert.equal(tab.startRevisionChain(5, 31), true);
  tab.element("problemSupplement").value = "也沒有先估算每項作業需要多久。";
  tab.addProblemDetail();
  assert.equal(tab.revisionCheckpointRequired(5), true);
  assert.equal(tab.revisionCheckpointRequired(16), true);
  for (const unaffected of [7, 8, 9, 10, 11, 13, 14, 15]) {
    assert.equal(tab.revisionCheckpointRequired(unaffected), false, `Step ${unaffected} must remain keepable`);
  }

  tab.S.problem = "作業、報告和考試很多，不知道應該如何安排完成的先後順序。";
  tab.S.problemOk = true;
  tab.S.confirmBy.problem = tab.S.selfId;
  tab.nextStep();
  assert.equal(tab.S.step, 7, "a completed Step 5 edit follows the Revision chain, not ordinary Step 6");
  assert.match(tab.revisionBanner(), /重新檢查/);
  tab.nextStep();
  assert.equal(tab.S.step, 7);
  assert.match(tab.shown(), /尚未沿用目前內容，也尚未完成實際修改/);

  tab.editCause("c-own", "text", "沒有依期限與工時安排順序");
  assert.equal(tab.revisionBanner(), "", "the entire blue keep block disappears after a real edit");
  for (const affected of [7, 8, 9, 10, 16]) {
    assert.equal(tab.revisionCheckpointRequired(affected), true, `Step ${affected} must be rebuilt`);
  }
  for (const unaffected of [11, 13, 14, 15]) {
    assert.equal(tab.revisionCheckpointRequired(unaffected), false, `Step ${unaffected} must not be invalidated`);
  }
});

test("Step 13 cannot bypass its keep/edit checkpoint with ordinary Next", () => {
  const tab = openTab();
  activate(tab, "A");
  tab.S.methods = [{
    id: "m-own",
    text: "先列出每項期限",
    source: tab.S.selfId,
    createdBy: tab.S.selfId,
    status: "草稿",
    causes: [],
    effect: "",
  }];
  assert.equal(tab.startRevisionChain(13, 32), true);
  tab.nextStep();
  assert.equal(tab.S.step, 13);
  assert.match(tab.shown(), /尚未沿用目前內容，也尚未完成實際修改/);

  tab.element("newText").value = "新增每週進度檢查表";
  tab.addSpoken("method");
  for (const affected of [13, 14, 15, 16]) {
    assert.equal(tab.revisionCheckpointRequired(affected), true, `Step ${affected} must be rebuilt`);
  }
});

test("two members must both finish an edited Step 7 before the Revision chain advances", () => {
  const a = openTab();
  const b = openTab();
  activate(a, "A");
  activate(b, "B");
  const sources = [
    { id: a.S.selfId, name: "A", color: "#276EF1", system: false, joined: true },
    { id: b.S.selfId, name: "B", color: "#00A676", system: false, joined: true },
  ];
  const causes = [
    { id: "c-a", text: "A 原因", source: a.S.selfId, createdBy: a.S.selfId, status: "已確認為原因" },
    { id: "c-b", text: "B 原因", source: b.S.selfId, createdBy: b.S.selfId, status: "已確認為原因" },
  ];
  for (const tab of [a, b]) {
    tab.S.sources = structuredClone(sources);
    tab.S.causes = structuredClone(causes);
    assert.equal(tab.startRevisionChain(5, 35), true);
    tab.S.revisionChainIndex = 1;
    tab.S.step = 7;
  }

  a.editCause("c-a", "text", "A 更新後原因");
  b.mergeRoom(a.sharedSnapshot());
  a.nextStep();
  assert.equal(a.S.step, 7, "the first member waits at Step 7");

  b.mergeRoom(a.sharedSnapshot());
  b.nextStep();
  assert.equal(b.S.step, 8, "the second confirmation advances the official chain");
  a.mergeRoom(b.sharedSnapshot());
  assert.equal(a.S.step, 8, "the first member follows the same official transition");
});

test("every Revision edit uses the offline dependency map instead of a linear cascade", () => {
  const cases = new Map([
    [5, [5, 16]],
    [7, [7, 8, 9, 10, 16]],
    [8, [8, 9, 10, 16]],
    [9, [9, 10, 16]],
    [11, [11, 14, 16]],
    [13, [13, 14, 15, 16]],
    [14, [14, 15, 16]],
    [15, [15, 16]],
  ]);
  const checkpoints = [5, 7, 8, 9, 10, 11, 13, 14, 15, 16];
  for (const [edited, expected] of cases) {
    const tab = openTab();
    activate(tab, `member-${edited}`);
    assert.equal(tab.startRevisionChain(5, 100 + edited), true);
    // Call the shipped helper through the tab's own global context.
    tab.S.revisionCheckpointGenerations = {};
    tab.S.revisionMode = true;
    tab.S.revisionRoundId = 100 + edited;
    tab.S.revisionReturnChain = [5, 7, 8, 9, 10, 11, 13, 14, 15, 16];
    tab.invalidateRevisionChange(edited);
    for (const checkpoint of checkpoints) {
      assert.equal(
        tab.revisionCheckpointRequired(checkpoint),
        expected.includes(checkpoint),
        `editing Step ${edited} produced the wrong state for Step ${checkpoint}`,
      );
    }
  }
});

test("server progress at Step 16 cannot push an active Revision back to Step 16", () => {
  const sender = openTab();
  const receiver = openTab();
  activate(sender, "A");
  activate(receiver, "B");
  sender.S.problem = "上一輪正式主要問題";
  sender.S.problemOk = true;
  sender.S.confirmBy.problem = sender.S.selfId;
  assert.equal(sender.startRevisionChain(5, 60), true);
  const snapshot = sender.sharedSnapshot();
  receiver.S.step = 16;
  receiver.S.outcomeNeedsRevision = true;
  receiver.applyRemote(snapshot, 16);
  assert.equal(receiver.S.step, 5, "an old formal result cannot auto-skip its keep checkpoint");

  snapshot.revisionChainIndex = 3;
  snapshot.revisionTransitionVersion += 1;
  snapshot.outcomeRevisionTarget = "5";
  snapshot.outcomeRevisionTargetRound = 60;
  snapshot.outcomeRevisionRound = 60;
  snapshot.outcomeRevisionVersion = 60;

  receiver.applyRemote(snapshot, 16);
  assert.equal(receiver.S.revisionMode, true);
  assert.equal(receiver.S.revisionChainIndex, 3);
  assert.equal(receiver.S.step, 9, "the Revision checkpoint, not monotonic room progress, owns the screen");

  receiver.S.step = 8;
  receiver.S.reviewingStep = 8;
  const later = structuredClone(snapshot);
  later.revisionChainIndex = 4;
  later.revisionTransitionVersion += 1;
  receiver.applyRemote(later, 16);
  assert.equal(receiver.S.revisionChainIndex, 4, "official Revision progress still synchronizes");
  assert.equal(receiver.S.step, 8, "a local history view is not pulled away by the remote transition");
  assert.equal(receiver.S.reviewingStep, 8);
});

test("two members restore their own Step 15 baselines during a later Revision cycle", () => {
  const a = openTab();
  const b = openTab();
  activate(a, "A");
  activate(b, "B");
  const sources = [
    { id: a.S.selfId, name: "A", color: "#276EF1", system: false, joined: true },
    { id: b.S.selfId, name: "B", color: "#00A676", system: false, joined: true },
  ];
  const methods = [
    { id: "m-a", text: "A 方法", source: a.S.selfId, createdBy: a.S.selfId, status: "正式方法", big: "共同正式分類", causes: ["c1"], effect: "回應原因" },
    { id: "m-b", text: "B 方法", source: b.S.selfId, createdBy: b.S.selfId, status: "正式方法", big: "共同正式分類", causes: ["c1"], effect: "回應原因" },
  ];
  for (const tab of [a, b]) {
    tab.S.sources = structuredClone(sources);
    tab.S.causes = [{ id: "c1", text: "共同原因", source: a.S.selfId, createdBy: a.S.selfId, status: "已確認為原因" }];
    tab.S.methods = structuredClone(methods);
    tab.S.step = 15;
  }

  a.S.draftMethodCats = [{ id: "a-cat", name: "A 的大方法" }];
  a.S.draftMethodAssignments = { "m-a": "a-cat", "m-b": "a-cat" };
  a.submitMethodClass();
  b.mergeRoom(a.sharedSnapshot());

  b.S.draftMethodCats = [{ id: "b-cat", name: "B 的大方法" }];
  b.S.draftMethodAssignments = { "m-a": "b-cat", "m-b": "b-cat" };
  b.submitMethodClass();
  a.mergeRoom(b.sharedSnapshot());

  const added = { id: "m-new", text: "Revision 新方法", source: b.S.selfId, createdBy: b.S.selfId, status: "已完成對應檢查", big: "", causes: ["c1"], effect: "回應新增方法" };
  for (const tab of [a, b]) {
    tab.S.methods = [...structuredClone(methods), structuredClone(added)];
    tab.S.methodsVersion += 1;
    assert.equal(tab.startRevisionChain(13, 40), true);
    tab.S.revisionChainIndex = 2;
    tab.S.step = 15;
    tab.step15();
  }

  assert.deepEqual([...a.S.draftMethodCats].map((cat) => cat.name), ["A 的大方法"]);
  assert.deepEqual([...b.S.draftMethodCats].map((cat) => cat.name), ["B 的大方法"]);
  assert.equal(a.S.draftMethodAssignments["m-new"], undefined);
  assert.equal(b.S.draftMethodAssignments["m-new"], undefined);

  const aDraft = JSON.stringify(a.S.draftMethodAssignments);
  const bDraft = JSON.stringify(b.S.draftMethodAssignments);
  a.mergeRoom(b.sharedSnapshot());
  b.mergeRoom(a.sharedSnapshot());
  assert.equal(JSON.stringify(a.S.draftMethodAssignments), aDraft, "B must not replace A's local classification");
  assert.equal(JSON.stringify(b.S.draftMethodAssignments), bDraft, "A must not replace B's local classification");
  assert.deepEqual([...Object.keys(a.S.methodClassOwnerBaselines)].sort(), [a.S.selfId, b.S.selfId].sort());
  assert.deepEqual([...Object.keys(b.S.methodClassOwnerBaselines)].sort(), [a.S.selfId, b.S.selfId].sort());
});

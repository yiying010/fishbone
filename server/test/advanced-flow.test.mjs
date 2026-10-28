import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("start flow keeps server room codes and removes legacy mode/count choices", async () => {
  const start = await read("public/fishbone-steps-start.js");
  const advanced = await read("public/fishbone-advanced-flow.js");
  assert.match(start, /房間碼由伺服器產生/);
  assert.doesNotMatch(advanced, /個人開始活動|小組開始活動|預期組員人數|expectedMemberCount/);
});

test("advanced flow loads before bootstrap", async () => {
  const html = await read("public/fishbone.html");
  assert.ok(html.indexOf("fishbone-advanced-flow.js") > 0);
  assert.ok(html.indexOf("fishbone-advanced-flow.js") < html.indexOf("fishbone-bootstrap.js"));
  assert.match(html, /fishbone-advanced-flow\.js\?v=dropdown-fix-1/);
});

test("member roster lock is synchronized and enforced by the API", async () => {
  const advanced = await read("public/fishbone-advanced-flow.js");
  const store = await read("server/src/rooms/store.ts");
  const errors = await read("server/src/routes/room-errors.ts");
  assert.match(advanced, /requestMemberLock/);
  assert.match(advanced, /lockedMemberIds/);
  assert.match(store, /membersLocked/);
  assert.match(store, /RoomLockedError/);
  assert.match(errors, /error: "room_locked"/);
});

test("discussion must precede a new vote round", async () => {
  const source = await read("public/fishbone-advanced-flow.js");
  assert.match(source, /flowDiscussionMeta/);
  assert.match(source, /sendFlowDiscussion/);
  assert.match(source, /restartFlowVote/);
  assert.match(source, /請先完成討論/);
});

test("revision flow has synchronized all-member checkpoints", async () => {
  const source = await read("public/fishbone-advanced-flow.js");
  assert.match(source, /revisionReturnChain/);
  assert.match(source, /revisionCheckpointConfirmations/);
  assert.match(source, /revisionCheckpointGenerations/);
  assert.match(source, /confirmFlowRevision/);
  assert.match(source, /修改後重新確認/);
});

test("input safeguards preserve drafts and handle IME composition", async () => {
  const source = await read("public/fishbone-advanced-flow.js");
  assert.match(source, /meaninglessInput/);
  assert.match(source, /distressLooksLikeGoal/);
  assert.match(source, /captureDrafts/);
  assert.match(source, /compositionstart/);
  assert.match(source, /compositionend/);
  assert.match(source, /readOnlyReview/);
});

test("all classification steps provide stable dropdown fallbacks", async () => {
  const cards = await read("public/fishbone-cards.js");
  const start = await read("public/fishbone-steps-start.js");
  const analysis = await read("public/fishbone-steps-analysis.js");
  const solution = await read("public/fishbone-steps-solution.js");
  const advanced = await read("public/fishbone-advanced-flow.js");
  assert.match(cards, /groupingMini/);
  assert.match(cards, /causeClassMini/);
  assert.match(cards, /methodClassMini/);
  assert.match(cards, /data-classification-select/);
  assert.match(start, /移到主題/);
  assert.match(analysis, /移到大要因/);
  assert.match(solution, /methodClassMini\(m,"overview"\)/);
  assert.match(advanced, /pendingSelectRender/);
  assert.match(advanced, /tagName==="SELECT"/);
});


import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const documentHtml = await readFile(new URL("../../public/fishbone.html", import.meta.url), "utf8");
const styleFiles = [
  "fishbone-base.css",
  "fishbone-layout.css",
  "fishbone-diagrams.css",
  "fishbone-activity.css",
];
const scriptFiles = [
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
  "fishbone-bootstrap.js",
];
await Promise.all(styleFiles.map((file) => readFile(new URL(`../../public/${file}`, import.meta.url), "utf8")));
const scripts = await Promise.all(
  scriptFiles.map((file) => readFile(new URL(`../../public/${file}`, import.meta.url), "utf8")),
);
// Contract assertions inspect the same source the browser receives after the
// external classic scripts execute in document order.
const html = [documentHtml, ...scripts].join("\n");

test("presentation and behavior are separated into ordered frontend assets", () => {
  assert.doesNotMatch(documentHtml, /<style(?:\s|>)/);
  assert.doesNotMatch(documentHtml, /<script>(?:.|\s)*<\/script>/);

  const referencedStyles = [
    ...documentHtml.matchAll(/<link rel="stylesheet" href="([^"]+)" \/>/g),
  ].map((match) => match[1]);
  const referencedScripts = [...documentHtml.matchAll(/<script src="([^"]+)"><\/script>/g)].map(
    (match) => match[1],
  );
  assert.deepEqual(referencedStyles, styleFiles);
  assert.deepEqual(referencedScripts, scriptFiles);
});

test("the frontend assets still implement the 19-step activity", () => {
  assert.match(html, /S\.step\s*\+\s*["']\/19["']/);
  assert.match(html, /最終成果呈現與匯出/);
  assert.match(html, /fishbone-room-v2/);
  assert.match(html, /function\s+step19\b/);
  assert.match(html, /outcomeRevision/);
  // The merge semantics the activity depends on must stay client-side and intact.
  assert.match(html, /function\s+sharedSnapshot\(/);
  assert.match(html, /function\s+mergeRoom\(/);
  assert.match(html, /function\s+autoAdvanceFromShared\(/);
});

test("the page never roots a URL at /, so it drops into any mount point", () => {
  const rooted = [
    ...html.matchAll(/\b(?:src|href|action|formaction)\s*=\s*["']\/(?!\/)/gi),
    ...html.matchAll(/\bfetch\(\s*["'`]\//g),
    ...html.matchAll(/\bnew\s+URL\(\s*["'`]\//g),
  ];
  assert.deepEqual(rooted.map((match) => match[0]), []);
});

test("the API base is derived from the address bar, at any mount point", () => {
  const match = html.match(/SYNC\.base\s*=\s*(\(function\(\)\{[\s\S]*?\}\)\(\));/);
  assert.ok(match, "could not find the SYNC.base derivation in the page");

  // Evaluate the shipped expression itself rather than a copy of it.
  const derive = new Function("location", `return ${match[1]};`);
  const base = (pathname) => derive({ pathname });

  // Root mount, both entry points.
  assert.equal(base("/"), "/");
  assert.equal(base("/fishbone.html"), "/");

  // nginx `location /fishbone/` with proxy_pass to the container root.
  assert.equal(base("/fishbone/"), "/fishbone/");
  assert.equal(base("/fishbone/fishbone.html"), "/fishbone/");

  // nginx `location /fishbone` with no trailing slash: the browser stays on
  // /fishbone, so the base has to be the path itself plus a slash.
  assert.equal(base("/fishbone"), "/fishbone/");

  // A second project mounted elsewhere on the same domain, and a nested prefix.
  assert.equal(base("/tools/fishbone/"), "/tools/fishbone/");
  assert.equal(base("/tools/fishbone"), "/tools/fishbone/");
  assert.equal(base(""), "/");

  // A prefix containing a dot is a mount point, not a filename.
  assert.equal(base("/fishbone.v2"), "/fishbone.v2/");
  assert.equal(base("/fishbone.v2/"), "/fishbone.v2/");
  assert.equal(base("/fishbone.v2/fishbone.html"), "/fishbone.v2/");
});

test("a room that no longer exists stops the session instead of re-creating it", () => {
  assert.match(html, /function roomGone\(/);
  assert.match(html, /async function recoverSession\(/);

  // A 404 on a live session is ambiguous on purpose: the room may be gone, or
  // this session may have expired. The client asks to join again to tell them
  // apart, and only that path may declare the room gone.
  const recover = html.match(/async function recoverSession\(session\)\{[\s\S]*?\n {4}\}/);
  assert.ok(recover, "recoverSession not found");
  assert.match(recover[0], /roomGone\(\)/);

  // Both loops must route their 404 through it rather than handling it alone.
  const branches = html.match(/if\(res\.status===404\)\{[\s\S]{0,240}?\n {10}\}/g) ?? [];
  assert.ok(branches.length >= 2, "expected the poll and the push to both handle 404");
  for (const branch of branches) {
    assert.match(branch, /recoverSession\(session\)/);
  }
});

test("reading or writing a room always carries the session token", () => {
  // Joining is the only room request that may have no token, and only on a
  // first join; see the ownership test below.
  const roomFetches = html.match(/fetch\(roomApi\("(state|artifacts)"\)[^;]*?\)/g) ?? [];
  assert.ok(roomFetches.length >= 4, `expected several state/artifact requests, found ${roomFetches.length}`);
  for (const call of roomFetches) {
    assert.match(call, /headers:syncHeaders\(/, `a room request without the token header: ${call.slice(0, 80)}`);
  }
  assert.match(html, /h\["authorization"\]="Bearer "\+SYNC\.token/);
});

test("rejoining an existing member proves ownership with a tab-scoped bearer", () => {
  assert.match(html, /function roomTokenKey\(code\)/);
  assert.match(html, /sessionStorage\.getItem\(roomTokenKey\(code\)\)/);
  assert.match(html, /SYNC\.token=loadRoomToken\(S\.roomCode\)/);
  const joins = html.match(/fetch\(roomApi\("join"\),\{method:"POST"[^;]*?\}\)/g) ?? [];
  assert.ok(joins.length >= 2, "expected join and recovery requests");
  for (const join of joins) assert.match(join, /headers:syncHeaders\(true\)/);
  assert.match(html, /saveRoomToken\(S\.roomCode,SYNC\.token\)/);
  // The token is per tab and per room, and never reaches the shared caches.
  assert.match(html, /roomTokenKey\(code\)\{return "fishboneRoomToken:"\+canonRoomCode\(code\)/);
  assert.doesNotMatch(html, /localStorage\.setItem\([^)]*SYNC\.token/);
});

test("a member id already held by another session is reported as such, not as a bad code", () => {
  assert.match(html, /res\.status===409.*return "taken"/);
  const join = html.match(/async function joinActivity\(\)\{[\s\S]*?\n {4}\}/);
  assert.ok(join, "joinActivity not found");
  assert.match(join[0], /outcome==="taken"/);
});

test("the student is only in the room once the server has accepted the code", () => {
  const join = html.match(/async function joinActivity\(\)\{[\s\S]*?\n {4}\}/);
  assert.ok(join, "joinActivity not found");
  // An unknown code used to create a room silently. Now the join is awaited and
  // rolled back, so a wrong code leaves the student where they were.
  assert.match(join[0], /await connectRoom\(true,/);
  assert.match(join[0], /S\.joined=wasJoined/);
  assert.match(join[0], /找不到這個房間碼/);
  // render() clears #gateMsg, so a message shown before it is never seen.
  const failure = join[0].slice(join[0].indexOf("S.joined=wasJoined"));
  assert.ok(
    failure.indexOf("render()") < failure.indexOf("showGate("),
    "the failure message must be written after the re-render, or the student sees nothing",
  );
});

test("a live session is never repointed at a different room", () => {
  // S.roomCode is read when each request is built, so changing it while a
  // session is running would send this room's snapshot into the other one.
  // Both entry points must refuse rather than switch in place.
  const join = html.match(/async function joinActivity\(\)\{[\s\S]*?\n {4}\}/)[0];
  assert.match(join, /if\(S\.joined&&room!==S\.roomCode\)\{showGate\(/);

  const create = html.match(/async function createRoom\(\)\{[\s\S]*?\n {4}\}/)[0];
  assert.match(create, /if\(S\.joined\)\{showGate\(/);
  // The refusal has to come before the request that would allocate a room.
  assert.ok(
    create.indexOf("if(S.joined)") < create.indexOf('fetch(SYNC.base+"api/rooms"'),
    "createRoom must refuse before it allocates a room",
  );
});

test("a failed re-join restores the sync it interrupted", () => {
  const join = html.match(/async function joinActivity\(\)\{[\s\S]*?\n {4}\}/)[0];
  const failure = join.slice(join.indexOf('outcome!=="ok"'));
  // connectRoom bumps SYNC.session, which stops the poll loop that was running
  // for the room this device was already in. Nothing else restarts it.
  assert.match(failure, /SYNC\.session=0;SYNC\.token=""/);
  assert.match(failure, /if\(wasJoined\)setTimeout\(\(\)=>\{if\(S\.joined&&!SYNC\.session\)connectRoom\(\)\}/);
});

test("the local cache is merged before the server snapshot, not after", () => {
  // mergeRoom lets the incoming object win for the fields it does not version,
  // so the other order lets a stale device overwrite what the group confirmed.
  const join = html.match(/async function joinActivity\(\)\{[\s\S]*?\n {4}\}/)[0];
  assert.match(join, /connectRoom\(true,\(\)=>\{\s*loadRoom\(room\);/);

  const connect = html.match(/async function connectRoom\(initial,beforeApply\)\{[\s\S]*?\n {4}\}/)[0];
  assert.ok(
    connect.indexOf("beforeApply()") < connect.indexOf("applyRemote(data.snapshot)"),
    "the callback must run before the server snapshot is applied",
  );
});

test("a 429 is honoured rather than being overwritten by the generic backoff", () => {
  const branches = html.match(/if\(res\.status===429\)\{[^}]*\}/g) ?? [];
  // Four in all: the two retry loops, plus connectRoom and createRoom, which
  // report to the student and stop rather than retrying.
  assert.ok(branches.length >= 2, `expected several 429 branches, found ${branches.length}`);
  const retrying = branches.filter((branch) => branch.includes("retryAfterMs(res)"));
  assert.equal(retrying.length, 2, "the poll and the push must both honour Retry-After");
  for (const branch of branches) {
    // Throwing would land in the catch, whose own status message replaces this
    // one before the browser paints, making the branch invisible.
    assert.doesNotMatch(branch, /throw/);
  }
  assert.match(html, /function retryAfterMs\(res\)/);
});

test("the teacher creates the room; the code is never typed by a person", () => {
  assert.match(html, /async function createRoom\(\)/);
  assert.match(html, /fetch\(SYNC\.base\+"api\/rooms"/);
  assert.match(html, /id="createRoomBtn"/);
  // The old placeholder invited exactly the guessable codes this replaced.
  assert.doesNotMatch(html, /FISH-042/);
});

test("the client canonicalises a code the same way the server does", () => {
  // Evaluate the shipped lines themselves, alphabet and all, rather than a copy.
  const source = html.match(/const CODE_ALPHABET="[^"]+";\s*function canonRoomCode\(value\)\{[\s\S]*?\n/);
  assert.ok(source, "canonRoomCode not found");
  const canonRoomCode = new Function(`${source[0]}return canonRoomCode;`)();

  assert.equal(canonRoomCode("k7m2x9qpwd"), "k7m2x9qpwd");
  assert.equal(canonRoomCode("K7M2X-9QPWD"), "k7m2x9qpwd");
  assert.equal(canonRoomCode(" k7m2x - 9qpwd "), "k7m2x9qpwd");
  // Crockford's aliases, so a misread character still reaches the right room.
  assert.equal(canonRoomCode("O123456789"), "0123456789");
  assert.equal(canonRoomCode("Il23456789"), "1123456789");
  assert.equal(canonRoomCode("六年三班"), "");
});

test("an immediate poll response is paced, so SYNC_LONG_POLL_MS=0 cannot spin", () => {
  // The server answers at once when holding is disabled; without a floor the
  // client would issue back-to-back full snapshot reads.
  assert.match(html, /if\(data\.unchanged\)\{[\s\S]{0,400}?syncSleep\(\d+\)/);
});

test("sync requests are built from that base and the room code is escaped", () => {
  assert.match(html, /function roomApi\(suffix\)\{return SYNC\.base\+"api\/rooms\/"\+encodeURIComponent/);
});

test("method AI reviews publish current work then use the authenticated same-origin API", () => {
  assert.match(html, /async function publishForAi\(session\)/);
  assert.match(html, /fetch\(roomApi\("state"\),\{method:"POST"/);
  assert.match(html, /async function requestAiReview\(task,itemId\)/);
  assert.match(html, /fetch\(roomApi\("ai\/review"\),\{method:"POST"/);
  assert.match(html, /headers:syncHeaders\(true\)/);
  assert.match(html, /JSON\.stringify\(\{task,itemId,baseRevision:revision\}\)/);
  assert.match(html, /requestAiReview\("step14_method",id\)/);
  // A disabled or unavailable provider may fall back to local rules, but the
  // result must say so instead of being represented as an AI response.
  assert.match(html, /本機規則檢查：/);
  assert.match(html, /AI 建議：/);
  // A stale AI response is discarded rather than applied to changed content.
  assert.match(html, /response\.status==="stale"/);
  assert.match(html, /小組內容已更新/);
});

test("editing a method explanation persists it and invalidates downstream classification", () => {
  const softEdit = html.match(/function methodEditSoft\(id,k,v\)\{[^\n]*/);
  assert.ok(softEdit, "methodEditSoft not found");
  assert.match(softEdit[0], /resetMethodClass\(\)/);
  assert.match(softEdit[0], /saveRoom\(\)/);
  // This remains a command handler rather than a render loop, so typing does
  // not steal focus from the textarea on every keypress.
  assert.doesNotMatch(softEdit[0], /render\(\)/);
});

test("no build artefact re-introduces a second copy of the activity", async () => {
  const gone = ["../../public/index.html", "../../prototype/index.html"];
  for (const path of gone) {
    await assert.rejects(
      readFile(new URL(path, import.meta.url), "utf8"),
      /ENOENT/,
      `${path} is back; public/fishbone.html is meant to be the only copy`,
    );
  }
});

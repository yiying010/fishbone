import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const html = await readFile(new URL("../../public/fishbone.html", import.meta.url), "utf8");

test("public/fishbone.html is still the 19-step activity", () => {
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
  // Joining is the only room request that legitimately has no token.
  const roomFetches = html.match(/fetch\(roomApi\("(state|artifacts)"\)[^;]*?\)/g) ?? [];
  assert.ok(roomFetches.length >= 4, `expected several state/artifact requests, found ${roomFetches.length}`);
  for (const call of roomFetches) {
    assert.match(call, /headers:syncHeaders\(/, `a room request without the token header: ${call.slice(0, 80)}`);
  }
  assert.match(html, /h\["authorization"\]="Bearer "\+SYNC\.token/);
});

test("the student is only in the room once the server has accepted the code", () => {
  const join = html.match(/async function joinActivity\(\)\{[\s\S]*?\n {4}\}/);
  assert.ok(join, "joinActivity not found");
  // An unknown code used to create a room silently. Now the join is awaited and
  // rolled back, so a wrong code leaves the student where they were.
  assert.match(join[0], /await connectRoom\(true\)/);
  assert.match(join[0], /S\.joined=wasJoined/);
  assert.match(join[0], /找不到這個房間碼/);
  // render() clears #gateMsg, so a message shown before it is never seen.
  const failure = join[0].slice(join[0].indexOf("S.joined=wasJoined"));
  assert.ok(
    failure.indexOf("render()") < failure.indexOf("showGate("),
    "the failure message must be written after the re-render, or the student sees nothing",
  );
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

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
  // Both the poll and the push must stop, not re-join: a re-join would insert
  // the room again and the next push would restore a deleted room's contents.
  const rejoinOn404 = html.match(/if\(res\.status===404\)\{[^}]*\}/g) ?? [];
  assert.ok(rejoinOn404.length >= 2, "expected the poll and the push to both handle 404");
  for (const branch of rejoinOn404) {
    assert.match(branch, /roomGone\(\)/);
    assert.doesNotMatch(branch, /connectRoom\(\)/);
  }
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

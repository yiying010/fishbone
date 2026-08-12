import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

async function readProjectHtml(relativePath) {
  return readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

test("server renders the fishbone iframe shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<iframe\b[^>]*\bsrc=["']\/fishbone\.html["'][^>]*>/i);
  assert.doesNotMatch(html, /Your site is taking shape|SkeletonPreview|codex-preview/i);
});

test("public fishbone html uses the current 19-step prototype", async () => {
  const html = await readProjectHtml("public/fishbone.html");

  assert.match(html, /S\.step\s*\+\s*["']\/19["']/);
  assert.match(html, /最終成果呈現與匯出/);
  assert.match(html, /fishbone-room-v2/);
  assert.match(html, /function\s+step19\b/);
  assert.match(html, /outcomeRevision/);
});

test("published html entry points are synchronized", async () => {
  const [fishbone, publicIndex, prototypeIndex] = await Promise.all([
    readProjectHtml("public/fishbone.html"),
    readProjectHtml("public/index.html"),
    readProjectHtml("prototype/index.html"),
  ]);

  assert.equal(publicIndex, fishbone);
  assert.equal(prototypeIndex, fishbone);
});

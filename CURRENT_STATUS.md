# Current Recovery Baseline

Date verified: 2026-10-08 (Asia/Taipei)

Baseline branch: `baseline/recovered-2026-10-08`

Baseline tag: `baseline-recovered-2026-10-08`

Recovered from upstream commit: `46712159c5e742d77665f7d09d080895eb3aea84`

This document records the first verified working state after recovering the
repository on a new computer. No application behavior, UI, database schema, or
deployment architecture was changed while establishing this baseline. The only
local runtime configuration is an ignored `.env` file; it contains no external
API credentials and is not part of this baseline commit.

## Verified local environment

- Docker Desktop 29.8.2 with Docker Compose v5.5.1.
- The repository's original `docker-compose.yml` and `Dockerfile` are used.
- PostgreSQL 17 runs in the `db` service with a persistent named volume.
- The one-shot `migrate` service applied migrations `0001`, `0002`, and `0003`
  successfully and exited with status 0, as intended.
- The Node 22 / Fastify `app` service is healthy and is bound only to
  `127.0.0.1:3000`.
- `GET /healthz` returns HTTP 200 with both application and database healthy.
- The Git working tree was clean before this status document was added, and the
  local `.env` is ignored by Git.

## Features verified as working

- The activity homepage and frontend assets load at `http://127.0.0.1:3000/`.
- The teacher-facing action creates a server-generated room code.
- Multiple browser sessions can join the same room with separate member
  sessions.
- Session tokens are issued and room reads/writes require authentication.
- A participant can create a distress card and advance into the activity.
- Two participants see the same shared card pool.
- A card submitted by one participant appears in the other participant's
  browser through the existing synchronization path.
- The fishbone previews render from shared room state.
- Frontend and backend APIs communicate correctly.
- Room revisions increase as state is written.
- PostgreSQL persists rooms, joined members, snapshots, and projected
  submission rows.
- Long polling, revision-conflict behavior, retention, migrations, session
  ownership, room-code normalization, artifact persistence, rate limiting, and
  AI-provider boundaries are covered by the repository test suite.
- Full verification result: **83 tests passed, 0 failed, 0 skipped** using an
  isolated disposable PostgreSQL test database.
- No obvious browser-console error or application error-level log entry was
  observed during the live smoke test.

The live manual check covered room creation, two-member joining, shared card
creation, synchronization, database persistence, and the fishbone preview. It
did not manually walk human participants through all 19 classroom steps; the
shipped 19-step assets and their covered behaviors passed the automated suite.

## Features intentionally not enabled

- External AI is disabled with `AI_ENABLED=false`.
- No `OPENAI_API_KEY` is present. The activity keeps its deterministic local
  fallback where supported.
- Administrative room export and deletion routes are disabled because
  `ADMIN_TOKEN` is empty.
- No public deployment, production hostname, TLS termination, or production
  reverse proxy has been configured on this computer.
- No attempt has been made to restore historical production rooms because no
  old PostgreSQL dump or volume was provided.

## Known security issues

`npm audit --omit=dev` reported four high-severity vulnerable packages in the
locked production dependency tree:

- `fastify` 5.6.1 is affected by multiple request/validation and routing
  advisories. The audit currently offers a non-major upgrade to 5.12.5.
- `@fastify/static` 8.2.0 is affected by path traversal and non-canonical path
  handling advisories. The audit currently offers 10.1.5, which is a major
  version change and requires compatibility review.
- `fast-uri` is a vulnerable transitive dependency.
- `brace-expansion` is a vulnerable transitive dependency.

These dependency versions were not changed while creating the recovery
baseline. The service is currently loopback-only. Do not expose this exact
baseline directly to the public internet before updating the affected
dependencies and rerunning all tests and manual checks.

The repository's own audit document also records longer-term concerns that are
not startup blockers: whole-snapshot writes are not yet fully
server-authoritative at card/vote field level, long-poll concurrency is not
bounded per member/room, complete snapshots remain in same-origin
`localStorage`, and some frontend workflow coverage is still static rather
than behavioral.

## Old-environment material not present in this repository

- The production `.env`, database password, `ADMIN_TOKEN`, OpenAI credential,
  and any other Business/server secrets.
- The old PostgreSQL data volume, database dump, backups, and historical room
  content.
- The separate deployment repository's Compose overlay used to attach the app
  to the shared internal Docker network.
- The shared nginx route, public hostname configuration, and TLS material.
- Any host-specific operational configuration or monitoring state.
- `docs/ai-evaluation-rules.md` states that a newer local offline activity
  existed than the GitHub frontend at the time that document was written. That
  newer local artifact has not been found in this repository and must be
  recovered separately if it is still authoritative.

The repository is sufficient to run and test the version committed to GitHub,
but it is not sufficient to reproduce the old production data or the complete
shared Business-server deployment by itself.

## Recommended follow-up work

1. Preserve this branch and tag before making dependency or deployment changes.
2. Locate and archive the old database dump, production environment-variable
   inventory, deployment overlay, nginx configuration, and any newer local
   activity artifact.
3. Create a separate security-update branch and upgrade `fastify`,
   `@fastify/static`, and the affected transitive dependencies deliberately.
4. Rerun the complete database-backed test suite and repeat the two-browser
   smoke test after dependency updates.
5. Decide the new production data-retention and backup policy, then generate
   new production-only PostgreSQL and admin credentials.
6. Deploy behind an owned HTTPS reverse proxy only after the dependency audit
   is clean or each remaining advisory has been reviewed and documented.
7. Keep external AI disabled until a separate privacy/security review, model
   evaluation, API project configuration, and spending controls are complete.

## Local operation

Start or rebuild:

```bash
docker compose up -d --build
```

Check status:

```bash
docker compose ps
curl -fsS http://127.0.0.1:3000/healthz
```

Stop while preserving the PostgreSQL volume:

```bash
docker compose down
```

Do not add `-v` to the stop command unless permanent deletion of the local
database volume is explicitly intended.

## Returning to this baseline

To inspect the preserved state without moving an existing branch:

```bash
git switch --detach baseline-recovered-2026-10-08
```

To create a new recovery branch from it:

```bash
git switch -c recovery/from-baseline baseline-recovered-2026-10-08
```

If an experimental branch becomes broken, preserve any wanted changes first,
then switch back to the baseline branch:

```bash
git switch baseline/recovered-2026-10-08
docker compose up -d --build
```

Avoid destructive reset commands unless loss of later work is explicitly
intended.

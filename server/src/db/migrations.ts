/**
 * Migrations are plain SQL kept in-process so that `tsc` alone produces a
 * runnable image (no asset-copy step that can silently go missing).
 *
 * Rules: append only, never edit a shipped migration, one transaction each.
 */

export interface Migration {
  id: string;
  sql: string;
}

export const migrations: Migration[] = [
  {
    id: "0001_init",
    sql: /* sql */ `
      create table rooms (
        id               bigserial primary key,
        code             text        not null,
        revision         bigint      not null default 0,
        current_step     smallint    not null default 0,
        snapshot         jsonb       not null default '{}'::jsonb,
        created_at       timestamptz not null default now(),
        updated_at       timestamptz not null default now(),
        last_activity_at timestamptz not null default now()
      );

      -- Room codes are typed by students; match them case-insensitively so
      -- "fish-042" and "FISH-042" are the same room.
      create unique index rooms_code_key on rooms (lower(code));
      create index rooms_last_activity_idx on rooms (last_activity_at);

      create table members (
        room_id       bigint      not null references rooms (id) on delete cascade,
        member_id     text        not null,
        display_name  text        not null default '',
        color         text        not null default '',
        is_system     boolean     not null default false,
        has_joined    boolean     not null default false,
        current_step  smallint    not null default 0,
        first_seen_at timestamptz not null default now(),
        last_seen_at  timestamptz not null default now(),
        primary key (room_id, member_id)
      );

      -- One row per card a member submitted, whatever step produced it.
      -- kind: distress | problem_detail | cause | goal_idea | method | reflection
      create table submissions (
        room_id          bigint      not null references rooms (id) on delete cascade,
        kind             text        not null,
        item_id          text        not null,
        step             smallint    not null,
        author_member_id text,
        body             text        not null default '',
        status           text        not null default '',
        payload          jsonb       not null default '{}'::jsonb,
        created_at       timestamptz not null default now(),
        updated_at       timestamptz not null default now(),
        primary key (room_id, kind, item_id)
      );

      create index submissions_room_kind_idx on submissions (room_id, kind);

      -- kind: distress_grouping | cause_class | method_class
      create table groupings (
        room_id          bigint      not null references rooms (id) on delete cascade,
        kind             text        not null,
        proposal_id      text        not null,
        author_member_id text,
        title            text        not null default '',
        is_official      boolean     not null default false,
        payload          jsonb       not null default '{}'::jsonb,
        created_at       timestamptz not null default now(),
        updated_at       timestamptz not null default now(),
        primary key (room_id, kind, proposal_id)
      );

      create table vote_rounds (
        room_id        bigint      not null references rooms (id) on delete cascade,
        kind           text        not null,
        round          integer     not null,
        is_tie         boolean     not null default false,
        resolved_value text        not null default '',
        created_at     timestamptz not null default now(),
        updated_at     timestamptz not null default now(),
        primary key (room_id, kind, round)
      );

      create table votes (
        room_id   bigint      not null,
        kind      text        not null,
        round     integer     not null,
        member_id text        not null,
        value     text        not null,
        cast_at   timestamptz not null default now(),
        primary key (room_id, kind, round, member_id),
        foreign key (room_id, kind, round)
          references vote_rounds (room_id, kind, round) on delete cascade
      );

      create table artifacts (
        id          bigserial   primary key,
        room_id     bigint      not null references rooms (id) on delete cascade,
        revision    bigint      not null,
        format      text        not null,
        filename    text        not null default '',
        content     text        not null,
        exported_by text,
        exported_at timestamptz not null default now()
      );

      create index artifacts_room_idx on artifacts (room_id, exported_at desc);
    `,
  },
  {
    id: "0002_member_sessions",
    sql: /* sql */ `
      -- Joining a room hands back a bearer token. Reading or writing a room
      -- needs that token, so an unauthenticated request cannot tell an existing
      -- room from one that never existed, and a scan of the code space learns
      -- nothing. The token is stored only as a digest.
      alter table members
        add column session_token_hash bytea,
        add column session_expires_at timestamptz;

      create unique index members_session_token_key
        on members (session_token_hash)
        where session_token_hash is not null;
    `,
  },
  {
    id: "0003_release_member_sessions",
    sql: /* sql */ `
      -- A member id may no longer be re-joined without presenting the token
      -- that already holds it. Sessions issued before that rule were not kept
      -- across reloads, so release them once during this upgrade.
      update members set session_token_hash = null, session_expires_at = null;
    `,
  },
  {
    id: "0004_room_membership_policy",
    sql: /* sql */ `
      alter table rooms
        add column expected_member_count smallint,
        add column members_locked boolean not null default false;

      alter table rooms
        add constraint rooms_expected_member_count_check
          check (expected_member_count is null or expected_member_count between 1 and 12);
    `,
  },
  {
    id: "0005_authoritative_item_versions",
    sql: /* sql */ `
      -- Snapshot absence is not deletion. These versions let PostgreSQL keep
      -- the newest explicit content or tombstone from each collaborating client.
      alter table submissions
        add column content_version bigint not null default 0,
        add column deleted_at timestamptz,
        add column deleted_version bigint not null default 0;

      alter table votes
        add column content_version bigint not null default 0,
        add column deleted_at timestamptz,
        add column deleted_version bigint not null default 0;

      alter table vote_rounds
        add column content_version bigint not null default 0;

      create index submissions_live_room_kind_idx
        on submissions (room_id, kind, item_id)
        where deleted_at is null;
      create index votes_live_room_kind_round_idx
        on votes (room_id, kind, round, member_id)
        where deleted_at is null and content_version >= deleted_version;
    `,
  },
  {
    id: "0006_remove_unused_membership_policy",
    sql: /* sql */ `
      -- The activity intentionally uses the members who actually joined. The
      -- fixed-capacity policy never had a teacher-facing control and could
      -- otherwise become a dormant path that unexpectedly refuses a student.
      alter table rooms
        drop constraint if exists rooms_expected_member_count_check,
        drop column if exists expected_member_count,
        drop column if exists members_locked;

      -- Voting never deletes a ballot in place; a restart opens a new round.
      -- Remove the unused tombstone path instead of carrying a protocol that
      -- no product action can produce.
      delete from votes
        where deleted_at is not null and deleted_version > content_version;
      drop index if exists votes_live_room_kind_round_idx;
      alter table votes
        drop column if exists deleted_at,
        drop column if exists deleted_version;
    `,
  },
];

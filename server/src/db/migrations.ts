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
];

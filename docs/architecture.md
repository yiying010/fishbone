# Architecture

The project keeps the browser activity and room server in one deployment while separating responsibilities at file boundaries. The refactor deliberately preserves every existing UI string, CSS rule, route, response shape, and synchronization behavior.

## Frontend

`public/fishbone.html` owns only the document structure and visible static markup. Its relative stylesheets preserve the original cascade in four layers: base controls, activity layout, fishbone diagrams, and later activity-specific overrides.

The ordered scripts form these responsibility groups:

1. Foundation and room-state assets own initial state, validation, local persistence, and same-browser collaboration.
2. Sync-client and sync-loop assets own sessions, room API synchronization, retries, polling, pushes, and artifact persistence.
3. Activity-rules, outcomes, and progression assets own validation, voting, result selection, reflection, and step gates.
4. Collaboration, grouping, and problem-goal assets own activity mutations and workflow transitions.
5. Runtime, staged step-template, card, method, and diagram-data assets own rendering and UI event handlers.
6. `fishbone-svg.js` owns fishbone visualization and export rendering.
7. `fishbone-bootstrap.js` installs final event listeners and performs the initial render.

These remain ordered classic scripts because the existing document uses inline HTML event attributes and a shared global scope. Converting them to ECMAScript modules would require changing that UI contract. The separation therefore improves navigation and ownership without changing runtime semantics. The stylesheet layers contain the presentation rules in their original order.

## Server routes

`routes/rooms.ts` coordinates the public room endpoints. Supporting policies are isolated as follows:

- `room-context.ts` parses requests and applies authentication and rate-limit policy.
- `room-long-poll.ts` owns the cross-replica long-poll wait loop.
- `admin-rooms.ts` owns privileged export and deletion endpoints.
- `room-errors.ts` maps domain failures to the stable public HTTP contract.

## Persistence

`rooms/store.ts` remains the compatibility facade used by the application and tests. Core room synchronization and session transactions stay there. Independent repositories own administrative queries, artifact persistence, and retention queries. Room errors and member-id validation are separate domain concerns.

An accepted snapshot is projected inside the caller's transaction. `domain/projection.ts` only coordinates the required order, while the `domain/projections/` modules independently project members, submissions, groupings, and votes. Member projection runs first because grouping titles depend on stored member names.

## Member presence

Every completion gate in the activity waits for the members who joined, and a member row is never deleted, so a device that stops answering mid-lesson would otherwise stop the whole group with no way out. `members.is_active` is the way out. It is server-owned and never written by snapshot projection, which merges `has_joined` with OR precisely so that a stale browser cannot un-join anyone.

The room has no teacher identity to check a privileged operation against, so any member of the room may ask for another to be marked absent. Two rules keep that from becoming a way to push a participating member out of a vote: the store refuses while the target's `last_seen_at` is within `MEMBER_ABSENT_AFTER_SECONDS`, and `authenticate()` sets `is_active` back to true, so a member who returns is counted again without anyone having to undo anything. `last_seen_at` is a real presence signal rather than a write signal because every authenticated request refreshes it, including the long poll a tab that is only watching still runs.

The resulting `presence` value (`joined`, `silent`, `excluded`, `pending`) rides out on the members list that every poll response already carries, so the change needs no room revision of its own.

# Architecture

The project keeps the browser activity and room server in one deployment while separating responsibilities at file boundaries. The refactor deliberately preserves every existing UI string, CSS rule, route, response shape, and synchronization behavior.

## Frontend

`public/fishbone.html` owns only the document structure and visible static markup. It loads the following relative assets in order:

1. `fishbone-state.js` owns initial state, local persistence, and same-browser collaboration.
2. `fishbone-sync.js` owns room API synchronization and retry behavior.
3. `fishbone-domain.js` owns validation, voting, and activity rules.
4. `fishbone-workflow.js` owns activity mutations and workflow transitions.
5. `fishbone-ui.js` owns rendering, step screens, and UI event handlers.
6. `fishbone-svg.js` owns fishbone visualization and export rendering.
7. `fishbone-bootstrap.js` installs final event listeners and performs the initial render.

These remain ordered classic scripts because the existing document uses inline HTML event attributes and a shared global scope. Converting them to ECMAScript modules would require changing that UI contract. The separation therefore improves navigation and ownership without changing runtime semantics. `fishbone.css` contains the presentation rules exactly as they appeared in the original inline style block.

## Server routes

`routes/rooms.ts` coordinates the public room endpoints. Supporting policies are isolated as follows:

- `room-context.ts` parses requests and applies authentication and rate-limit policy.
- `room-long-poll.ts` owns the cross-replica long-poll wait loop.
- `admin-rooms.ts` owns privileged export and deletion endpoints.
- `room-errors.ts` maps domain failures to the stable public HTTP contract.

## Persistence

`rooms/store.ts` remains the compatibility facade used by the application and tests. Core room synchronization and session transactions stay there. Independent repositories own administrative queries, artifact persistence, and retention queries. Room errors and member-id validation are separate domain concerns.

An accepted snapshot is projected inside the caller's transaction. `domain/projection.ts` only coordinates the required order, while the `domain/projections/` modules independently project members, submissions, groupings, and votes. Member projection runs first because grouping titles depend on stored member names.

# Teacher-Created Room Entry Requirements

## Status

This document records the agreed product direction for the Fishbone Cave entry
flow. It is a requirements-only change. It does not authorize deployment or a
change to the existing room security controls.

## Product decision

The activity must use the existing server-backed classroom entry design:

1. the teacher creates a new room;
2. the server generates a room code;
3. the teacher distributes or projects the code;
4. each student enters a name or nickname and the room code to join.

The interface must not present separate **individual activity** and **group
activity** choices. The previously proposed participation-mode selection is
out of scope and must not be added.

## Required entry flow

### Teacher: Create a New Room

The entry page must retain the existing **Teacher: Create a New Room** area and
its server-backed room creation action:

- the teacher selects **Create a New Room**;
- the server, not the browser, generates the room code;
- the generated code is displayed clearly for projection or distribution;
- students use that code in the join form;
- creating a room does not automatically enroll the teacher as a student;
- creating a room does not give the teacher access to edit student cards or
  bypass participant ownership rules.

"Teacher" is the intended classroom user of this control. This label alone
does not create a new server authorization role, teacher account, admin token,
or privileged room session.

### Student: Join the Room

The student entry area must collect:

- name or nickname;
- the server-generated room code;
- any additional value already required by the existing safe member-entry and
  member-lock flow.

Students must not be allowed to choose or create their own room codes. After a
successful join, the existing authenticated room-session flow must be used for
all room reads, writes, synchronization, and AI-assisted requests.

## Security constraints that must remain unchanged

Implementation of this entry flow must reuse the colleague's existing server
design and preserve all security protections already present in the
repository, including:

- server-generated, high-entropy room codes;
- room-code canonicalization and the existing unambiguous alphabet;
- bearer room-session authentication for room reads and writes;
- indistinguishable responses for missing rooms and invalid room access;
- rate limiting for room creation, joining, and AI requests;
- existing room/session binding and protection against repointing a live
  session to another room;
- existing card ownership, stale-revision, and member-lock checks;
- safe logging that does not expose live room codes, session tokens, student
  text, or API keys;
- server-only OpenAI credentials and disabled-by-default AI configuration;
- current data retention, database, reverse-proxy, and deployment controls.

This work must not weaken, replace, or bypass those controls.

## State and behavior boundaries

- Room creation must start with a clean room state.
- Current room content must not be copied into a newly created room.
- Switching to another room must follow the existing safe re-entry behavior.
- Refreshing or rejoining must not create a duplicate participant when the
  existing session can be safely resumed.
- The existing member-lock and collaborative synchronization behavior must be
  retained.
- The 19-step activity logic, AI evaluation rules for Steps 5, 8, 11, 14, and
  19, and all student confirmation responsibilities remain unchanged.

## Non-goals

This product decision does not add:

- an individual/group participation-mode selection;
- an independent individual activity path;
- a teacher dashboard;
- teacher authentication or an administrator role;
- room enumeration, discovery, or search;
- custom room codes;
- permission to view or modify every group's work;
- a deployment change, database migration, or reverse-proxy change;
- any change to the activity's instructional content or AI judgment rules.

Any future teacher dashboard or privileged teacher access requires a separate
security review and a separate pull request.

## Acceptance criteria

The implementation is acceptable only when all of the following are verified:

1. The entry page directly presents the existing student join form and the
   **Teacher: Create a New Room** action.
2. No individual/group participation-mode selection is displayed.
3. A newly created room code comes from the server, not the browser.
4. Multiple students can join the generated room through the existing
   authenticated room-session flow.
5. Creating a room does not automatically make the teacher a participant or
   grant privileged editing access.
6. Creating a new room cannot carry content or credentials from a previously
   joined room into the new room.
7. Existing room security, rendered-HTML, synchronization, and AI endpoint
   tests continue to pass.
8. No API key, session token, live room code, or student text is added to source
   control or unsafe logs.
9. Merging the requirements document alone does not deploy or change the
   website.

## Recommended implementation sequence

1. Keep this document as the reviewed product contract.
2. After the latest local activity HTML is finalized, integrate its activity
   updates into `public/fishbone.html` while retaining the colleague's current
   teacher-created room entry flow.
3. Reuse the existing room creation and join endpoints and all current security
   controls.
4. Do not copy the local individual/group entry screen into the deployed
   application.
5. Add focused entry-flow tests and run the complete existing test suite.
6. Submit the implementation as a separate pull request for code and security
   review before deployment.

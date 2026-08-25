# Participation Mode and Room Entry Requirements

## Status

This document records the agreed product direction for the Fishbone Cave entry
flow. It is a requirements-only change. It does not authorize deployment or a
change to the existing room security controls.

## Product decision

The activity must support both of the following participation modes:

1. **Individual activity**: one student completes the activity independently.
2. **Group activity**: multiple students join the same server-backed room and
   complete the activity collaboratively.

The existing **Teacher: Create a New Room** design must be retained for group
activities. The participation-mode choice and the teacher room-creation flow
serve different purposes and must coexist:

- the student chooses whether the activity is individual or collaborative;
- the teacher creates and distributes the room used by a collaborative group.

## Required entry flow

### 1. Participation-mode screen

Before collecting a name or room code, the activity must present two clear
choices:

- **Start Individual Activity**
- **Start Group Activity**

The selected mode must determine the next screen and must not be inferred from
whether a room code happens to be present.

### 2. Individual activity

After selecting individual activity:

- the student enters a name or nickname;
- no group-sharing room code is requested or displayed;
- the activity uses individual wording and individual confirmation behavior;
- group waiting, member-count, voting, and member-lock controls are not shown;
- the individual session must not read from or write to another student's
  activity state.

Because the paid AI review endpoint requires a server-issued authenticated
session, an online individual activity should use an isolated server-backed
one-member session. Its internal room identifier must not be presented as a
shareable group code. A fully offline individual activity may continue without
external AI, but it must never place an OpenAI API key in the browser.

### 3. Group activity

After selecting group activity, the page must provide two visually distinct
areas.

#### Student: Join a Group

The student entry area must collect:

- name or nickname;
- server-generated group room code;
- expected group size when that value is required by the existing member-lock
  flow.

Students must not be allowed to choose or create their own room codes.

#### Teacher: Create a New Room

The teacher area must retain the existing server-backed room creation action:

- the teacher selects **Create a New Room**;
- the server generates the room code;
- the generated code is displayed clearly for projection or distribution;
- students use that code in the group join form;
- room creation does not automatically enroll the teacher as a student;
- creating a room does not give the teacher access to edit student cards or
  bypass participant ownership rules.

"Teacher" is the intended classroom user of this control. This label alone
does not create a new server authorization role, teacher account, admin token,
or privileged room session.

## Security constraints that must remain unchanged

Implementation of this entry flow must preserve the server and deployment
security protections already present in the repository, including:

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

This work must not weaken, replace, or bypass those controls merely to make the
individual/group interface easier to implement.

## State and behavior boundaries

- The participation mode must be explicit and stable for the current activity
  session.
- Individual state and group-room state must never be silently merged.
- Switching to another room must follow the existing safe re-entry behavior;
  current room content must not be copied into the new room.
- Refreshing or rejoining must not create a duplicate participant when the
  existing session can be safely resumed.
- The 19-step activity logic, AI evaluation rules for Steps 5, 8, 11, 14, and
  19, and all student confirmation responsibilities remain unchanged.

## Non-goals

This product decision does not add:

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

1. The first screen offers both individual and group participation.
2. Individual mode starts without asking for or displaying a group room code.
3. Group mode retains a clearly labeled teacher room-creation action.
4. A newly created group room code comes from the server, not the browser.
5. Multiple students can join the generated room through the existing
   authenticated room-session flow.
6. Creating a room does not automatically make the teacher a participant or
   grant privileged editing access.
7. Individual activity data is isolated from group rooms and other individual
   sessions.
8. Existing room security, rendered-HTML, synchronization, and AI endpoint
   tests continue to pass.
9. No API key, session token, live room code, or student text is added to source
   control or unsafe logs.
10. Merging the requirements document alone does not deploy or enable the
    feature.

## Recommended implementation sequence

1. Keep this document as the reviewed product contract.
2. After the latest local activity HTML is finalized, integrate only the
   individual/group entry UI and its required state behavior into
   `public/fishbone.html`.
3. Reuse the existing teacher room-creation endpoint and all current security
   controls instead of replacing the colleague's server implementation.
4. Add focused tests for both entry paths and run the complete existing test
   suite.
5. Submit the implementation as a separate pull request for code and security
   review before deployment.

# AI-Assisted Step Requirements

## Status

This document defines the product, security, privacy, API, and acceptance
requirements for adding real AI assistance to Fishbone Cave. It is a
requirements document only. It does not authorize deployment, select a model,
or replace the existing human confirmation and voting flows.

The first implementation must limit AI assistance to Steps 5, 8, 11, 14, and
19. No other activity step may call an external AI service without a separate
requirements review.

## Goals

- Replace the current browser-side heuristic simulations in Steps 5, 8, 11,
  14, and 19 with server-mediated AI assistance.
- Preserve the meaning of student contributions instead of inventing content.
- Keep students and groups responsible for accepting, revising, or rejecting
  every AI-generated draft or judgment.
- Reuse the existing room-session authentication, rate limiting, snapshot
  synchronization, conflict handling, logging, and deployment boundaries.
- Keep API credentials and provider configuration entirely on the server.
- Minimize the student data sent to the AI provider.
- Keep the activity usable when the AI provider is unavailable.

## Non-goals

- AI must not make the final decision for a student or group.
- AI must not automatically advance the official activity step.
- AI must not cast votes, resolve tied votes, or mark a group decision as
  confirmed.
- AI must not create, join, enumerate, export, or delete rooms.
- AI must not change room membership, session tokens, retention policy, or the
  snapshot conflict-resolution algorithm.
- AI must not diagnose students, infer protected characteristics, rank
  students, or evaluate an individual student's ability or personality.
- The first implementation must not use web search, file search, code
  execution, third-party tools, or persistent AI conversations.
- Steps 2 and 17 must retain their existing deterministic validation and must
  not call an external AI service in the first implementation.
- This work must not require a routing change in the `rcsl-creativity`
  repository unless an implementation test demonstrates a concrete routing
  problem.

## Current behavior to be replaced

The current frontend labels several deterministic browser functions as AI
assistance:

- Step 5 creates a problem draft with `makeProblemDraft()`.
- Step 8 classifies cause cards with `classifyCause()`.
- Step 11 creates a decision-goal draft with `makeGoalDraft()`.
- Step 14 calls `reviewMethodAlignment()` through `runMethodAiCheck()` after a
  short timer.
- Step 19 creates a reflection summary with `reflectionSummaryText()`.

These functions are useful offline fallbacks, but they are not calls to an AI
model. The implementation must not present a fallback result as if it came
from the external AI provider.

## Required architecture

The browser must call a Fishbone server endpoint on the same public origin.
The Fishbone server must authenticate the caller, select the task-specific
prompt, read the authoritative room state, minimize the input, call the AI
provider, validate the structured response, and return only the validated
result.

```text
Browser at /fishbone/
  -> POST /fishbone/api/rooms/:code/ai/review
  -> creativity nginx strips /fishbone
  -> Fishbone Fastify server authenticates the room session
  -> OpenAI Responses API
  -> validated structured result
  -> existing student/group confirmation flow
```

The browser must never call the OpenAI API directly. The browser bundle must
not contain an API key, provider base URL, model-management credential, or
server-owned prompt.

The existing router already forwards `/fishbone/*` to the Fishbone application
and strips the public prefix. The new frontend request must therefore derive
its URL from `window.location`, as the existing room API does, and the app must
continue to serve internally at `/`.

## Common functional requirements

### Human confirmation

1. Every AI result must be shown as a draft, suggestion, or preliminary
   judgment.
2. Existing edit, vote, and confirmation controls must remain authoritative.
3. An AI response must not directly set an official confirmation field.
4. A student or group must be able to revise input and request a new review.
5. When an AI result changes a shared draft, the existing vote round and stale
   confirmation state must be reset in the same way as a manual draft change.

### Authoritative inputs

1. The client may identify the requested task and, for Step 14, a method item.
2. The server must read the latest authoritative room snapshot after
   authentication.
3. The server must not accept an arbitrary prompt, system instruction, model
   name, full snapshot, student name, room code, or member identifier as AI
   content supplied by the browser.
4. The server must reject a request when the requested task is inconsistent
   with the room's current activity state.
5. Student text must always be treated as untrusted content to analyze, never
   as instructions that can override the server-owned prompt.

### Output language and style

1. Student-facing output must use Traditional Chinese appropriate for the
   intended learners.
2. Feedback must be concise, concrete, supportive, and actionable.
3. The AI must preserve the students' intended meaning and vocabulary where
   practical.
4. The AI must not introduce people, events, causes, goals, methods, evidence,
   or conclusions that are absent from the submitted activity content.
5. The AI must state that more information is needed instead of guessing.

## Step-specific requirements

### Step 5: Define the main problem

#### Purpose

Help the student or group turn the selected shared problem and submitted
clarifications into a clear main-problem draft for the right-side fishbone.

#### Allowed input

- The selected shared problem text.
- Submitted Step 5 clarification text.
- The current activity mode only when needed to choose singular or group
  wording.

Student names, room codes, member IDs, votes, and unrelated room content must
not be sent.

#### Required AI behavior

- Preserve the original issue and all material clarifications.
- Improve clarity about who is affected, the situation, and the observable
  difficulty when that information exists.
- Avoid converting a possible cause, solution, or moral judgment into the main
  problem.
- Avoid adding facts that students did not provide.
- If the information is insufficient, ask exactly one focused clarification
  question instead of fabricating a complete draft.

#### Required structured result

```json
{
  "status": "ready | needs_clarification",
  "draft": "string or null",
  "clarification_question": "string or null",
  "feedback": "string"
}
```

When `status` is `ready`, `draft` must be non-empty and
`clarification_question` must be `null`. When `status` is
`needs_clarification`, `draft` may contain a partial draft and
`clarification_question` must contain one question.

#### Application behavior

- A returned draft remains a Step 5 draft.
- Existing individual confirmation or group voting determines whether it
  becomes the official main problem.
- A new or edited clarification invalidates the previous AI result and any
  related draft vote, using the existing invalidation behavior.

### Step 8: Review cause-card content

#### Purpose

Give the author of each cause card a preliminary classification of whether the
card is more like a cause, a method, a result, or content that needs
clarification before the right-side fishbone is organized.

#### Allowed input

- The confirmed main problem.
- The selected cause-card text.

The server must select both fields from the latest authoritative room snapshot
using a validated cause-card ID. Student names, room codes, member IDs, other
cause cards, votes, and unrelated room content must not be sent.

#### Required AI behavior

- Evaluate the card in relation to the confirmed main problem.
- Return exactly one preliminary classification:
  - `cause`: the card describes why the main problem happens;
  - `method`: the card describes an action that could address the problem;
  - `result`: the card describes an outcome or consequence of the problem;
  - `needs_clarification`: the relationship is ambiguous or too vague.
- Give one concise reason written for a student.
- When clarification is needed, ask exactly one focused question.
- Do not rewrite the card automatically.
- Do not infer facts that the student did not provide.
- Do not confirm, delete, move, hide, or mark the card unused.

#### Required structured result

```json
{
  "classification": "cause | method | result | needs_clarification",
  "reason": "string",
  "clarification_question": "string or null"
}
```

`clarification_question` must be non-empty only when `classification` is
`needs_clarification`; otherwise it must be `null`.

#### Application behavior

- The result must be labeled as an AI preliminary judgment.
- Only the card's original author may request a review or act on its result.
- The author may accept a `cause` judgment, edit and resubmit the card, move a
  `method` judgment to the existing method holding area, or leave the card
  unused.
- No AI result may perform one of those actions automatically.
- Other group members may see the result but must not be allowed to process the
  card on behalf of its author.
- Editing the cause-card text or changing the confirmed main problem must
  invalidate the previous Step 8 AI result.

### Step 11: Create the decision goal

#### Purpose

Help the student or group synthesize confirmed causes and submitted goal ideas
into a concrete decision-goal draft for the left-side fishbone.

#### Allowed input

- The confirmed main problem.
- Confirmed causes from the right-side fishbone.
- Student-submitted goal ideas.
- Optional priority-cause selections.

Names, room codes, member IDs, and unrelated room content must not be sent.

#### Required AI behavior

- Produce a goal that describes an intended improvement, not a method or a
  slogan.
- Keep the goal connected to the confirmed problem and causes.
- Integrate compatible student ideas without erasing meaningful differences.
- Avoid inventing measurements, deadlines, responsibilities, or success
  criteria that students did not provide.
- If the ideas are too vague or contradictory, request one focused addition or
  clarification.

#### Required structured result

```json
{
  "status": "ready | needs_clarification",
  "goal_draft": "string or null",
  "clarification_question": "string or null",
  "feedback": "string"
}
```

#### Application behavior

- A returned goal remains a Step 11 draft.
- Existing individual confirmation or group voting determines whether it
  becomes the official decision goal.
- A new or edited goal idea invalidates the prior AI result and the applicable
  vote round using the existing state transition rules.

### Step 14: Check method alignment

#### Purpose

Review one student-owned method at a time and judge whether the proposed
method, its selected causes, and its explanation are sufficiently connected to
the confirmed decision goal.

#### Allowed input

- The selected method text.
- Text of the causes explicitly linked to that method.
- The confirmed decision goal.
- The student's explanation of how the method supports the goal.

The server must select these fields from the current snapshot by a validated
method ID. It must not accept replacement values from the request body.

#### Required AI behavior

- Check whether the method is concrete enough to understand as an action.
- Check whether the method plausibly responds to at least one linked cause.
- Check whether the student's explanation connects the method to the decision
  goal.
- Return one of three verdicts:
  - `pass`: the relationship is clear enough to continue;
  - `suggest`: the relationship is plausible, but one useful detail is missing;
  - `revise`: the relationship is absent, contradictory, or too vague.
- Return one concise reason and at most one actionable revision suggestion.
- Never rewrite the student's method automatically.
- Never judge whether a student is intelligent, creative, diligent, or
  cooperative.

#### Required structured result

```json
{
  "verdict": "pass | suggest | revise",
  "reason": "string",
  "revision_suggestion": "string or null"
}
```

#### Application behavior

- `pass` may set the existing method review state to the equivalent of
  completed alignment review.
- `suggest` must remain visible as non-blocking feedback unless the product
  owner explicitly changes that policy after usability testing.
- `revise` must keep the method in the editable review flow.
- Only the method's original author may submit it for AI review, matching the
  current ownership rule.
- Changes to the method, linked causes, explanation, or confirmed goal must
  invalidate the previous Step 14 AI result.

### Step 19: Summarize the final reflection

#### Purpose

Create a concise final reflection summary from confirmed activity results and
completed student reflections. The summary supports presentation and export;
it does not score the activity or the participants.

#### Allowed input

- The confirmed main problem.
- Confirmed cause categories and causes.
- The confirmed decision goal.
- Confirmed method categories and methods.
- Final feasible and original method selections and their submitted reasons.
- Completed reflection text.

The AI input must remove student names and stable member identifiers. The
server may preserve the distinction between separate reflections with neutral
labels such as `Reflection 1` and `Reflection 2` when necessary.

#### Required AI behavior

- Summarize recurring themes and meaningful differences in the reflections.
- Connect the summary to the activity process without inventing learning
  outcomes.
- Preserve uncertainty and disagreement when present.
- Avoid psychological, behavioral, or educational diagnosis.
- Avoid attributing a statement to a named or identifiable student.
- Produce a concise summary suitable for the final page and exported artifact.

#### Required structured result

```json
{
  "summary": "string",
  "themes": ["string"],
  "limitations": ["string"]
}
```

#### Application behavior

- The result must be labeled as an AI-generated draft summary until accepted.
- The original individual reflections must remain available and unchanged.
- Students or the group must be able to regenerate or reject the summary.
- The final export must not imply that the AI summary is a teacher assessment.

## Server API contract

### Endpoint

```http
POST /api/rooms/:code/ai/review
Authorization: Bearer <existing room session token>
Content-Type: application/json
```

Suggested request body:

```json
{
  "task": "step5_problem | step8_cause | step11_goal | step14_method | step19_reflection",
  "itemId": "required for step8_cause and step14_method",
  "baseRevision": 123
}
```

`baseRevision` identifies the room revision the browser was displaying. Before
calling the provider, the server must verify that the request is still
compatible with the authoritative state. A stale request must not generate an
AI result for content that has already changed.

Suggested successful response envelope:

```json
{
  "task": "step14_method",
  "baseRevision": 123,
  "inputHash": "non-secret digest",
  "result": {
    "verdict": "suggest",
    "reason": "The method is related to the selected cause, but the effect on the goal is not yet clear.",
    "revision_suggestion": "Explain what change should happen after the method is used."
  }
}
```

The endpoint must return `Cache-Control: no-store`.

### Error behavior

- Invalid room codes, missing rooms, invalid session tokens, and expired
  sessions must remain indistinguishable, preserving the current room lookup
  protection.
- Invalid task or body: `400` with a stable machine-readable error code.
- Stale room revision: `409`; the client must refresh and let the user retry.
- AI-specific rate limit: `429` with `Retry-After`.
- Provider timeout or temporary failure: `503` with a user-safe retry message.
- Invalid provider output: `502`; do not pass unvalidated provider text to the
  browser.
- Error responses must not contain provider credentials, prompts, student
  content, room codes, or internal stack traces.

## Provider requirements

- Use the OpenAI Responses API through server-side code.
- Use server-owned instructions and strict Structured Outputs with a JSON
  Schema for each task.
- Set `store: false` for each request.
- Do not use a persistent conversation, `previous_response_id`, or provider
  tools in the first implementation.
- Set a task-appropriate maximum output token limit.
- Treat the model name as validated server configuration, never as a client
  parameter.
- Pin a model version after representative evaluation when the selected model
  supports version pinning; a model change must be reviewed and re-evaluated.
- Record the provider request ID, latency, task type, token usage, and status for
  operations monitoring without recording student text or live room codes.

Relevant official documentation:

- [OpenAI API authentication and server-side key guidance](https://developers.openai.com/api/reference/overview)
- [OpenAI Responses API](https://developers.openai.com/api/reference/cli/resources/responses/methods/create)
- [OpenAI API data controls](https://developers.openai.com/api/docs/guides/your-data)

## Authentication and authorization requirements

- Reuse the existing bearer room-session authentication.
- Do not add an unauthenticated general-purpose AI completion endpoint.
- Preserve the current behavior that makes missing rooms, wrong room codes,
  wrong tokens, and expired tokens indistinguishable.
- For Step 8, verify on the server that the authenticated member owns the
  selected cause card.
- For Step 14, verify on the server that the authenticated member owns the
  selected method.
- Group-level Step 5, Step 11, and Step 19 requests must use the latest shared
  state and must not allow one member to bypass the existing confirmation or
  voting rules.
- A server-issued session is required in every mode that uses external AI.

### Individual mode

An individual-mode page must not call a paid AI endpoint without a server-issued
session. The preferred first implementation is a server-backed one-member room
whose code is not shown as a group-sharing code. This reuses the existing room
session, retention, rate-limit, and snapshot security controls.

If individual mode remains fully local, external AI must be unavailable in that
mode and the UI must clearly identify the deterministic offline fallback. An
API key must never be embedded to make a local HTML file call OpenAI directly.

## Prompt-injection and data-minimization requirements

- Prompts must clearly delimit student content as quoted data.
- Student text must never be concatenated into a developer instruction without
  explicit data delimiters.
- The server must expose only the fields allowed for the requested task.
- Remove names, room codes, member IDs, session tokens, timestamps, internal
  audit fields, and unrelated snapshot content before provider submission.
- Set explicit per-field and total character limits before tokenization.
- Reject or truncate oversized input according to a documented deterministic
  rule; never silently send the full snapshot.
- The model must not be given tools, network access, files, or a capability to
  execute instructions found in student content.

## Secrets and configuration

The production credential belongs in the Fishbone deployment environment, not
in the frontend or routing repository. On the current server layout, the
untracked environment file is expected under the Fishbone checkout at
`/home/sysadmin/creativity/fishbone/.env`.

Suggested configuration names:

```dotenv
AI_ENABLED=false
OPENAI_API_KEY=
OPENAI_MODEL=
AI_TIMEOUT_MS=30000
AI_MAX_INPUT_CHARS=12000
AI_MAX_OUTPUT_TOKENS=500
```

- `.env.example` may document empty placeholders but must never contain a real
  credential.
- `OPENAI_API_KEY` must be passed only to the `app` container, not to the
  database, migration, or nginx containers.
- The application must fail startup with a clear configuration error when
  `AI_ENABLED=true` and required AI configuration is missing or invalid.
- Secret values must not be included in logs, health responses, error messages,
  Docker image layers, Git configuration, remote URLs, commits, pull requests,
  or test fixtures.

## Rate limiting, cost control, and duplicate suppression

- Add an AI-specific limiter in addition to the existing overall API limiter.
- Limit by authenticated member and room, not only by IP, because an entire
  class may share one school NAT address.
- Step 8 limits should account for one review per cause-card revision.
- Step 14 limits should account for one review per method revision.
- Step 5, Step 11, and Step 19 should suppress duplicate requests for the same
  room revision and task.
- Use a deterministic input hash based only on the minimized AI input, task,
  and prompt version. Do not include the API key or session token.
- Concurrent requests with the same input hash should share one in-flight
  provider call or return the same validated short-lived result.
- Provider timeout must remain below the outer proxy timeout. A default of 30
  seconds is appropriate for the current proxy chain.
- Configure OpenAI project spending controls independently of application rate
  limits before production release.

## Privacy and research requirements

- Student text submitted to the AI provider is a separate data flow from the
  existing PostgreSQL room storage and must be described in the study's
  participant information and privacy materials before production use.
- The production owner must review applicable research ethics, consent,
  parental or guardian notice, and institutional requirements before enabling
  AI for student data.
- `store: false` must be used, but the implementation documentation must not
  claim that this alone means zero retention. OpenAI documents separate abuse
  monitoring retention and optional organization-level retention controls.
- Do not submit direct identifiers to the provider.
- Do not use AI output as a safety, mental-health, disciplinary, grading, or
  eligibility decision.
- Potentially urgent or sensitive student disclosures require a separately
  reviewed teacher-support and safeguarding process; the five tasks in this
  document must not attempt diagnosis or crisis triage.

## Failure and offline behavior

- A provider failure must not corrupt or discard student work.
- The UI must leave the original input visible and editable.
- The user must receive a short, non-technical error and a retry option.
- The activity must not automatically submit the same request in an unbounded
  retry loop.
- When the deterministic fallback is used, label it as a basic offline check or
  basic draft, not as an AI judgment.
- A group may continue manually when AI is unavailable; AI availability must
  not make previously confirmed room data unreadable.

## State and synchronization requirements

- Store accepted AI-derived drafts or preliminary judgments in the existing
  Step 5, Step 8, Step 11, Step 14, and Step 19 state fields where practical.
- Keep provider-specific response objects, raw prompts, and hidden model output
  out of the shared room snapshot.
- A result must carry or be associated with its task, prompt version, input
  hash, and source room revision so stale results can be rejected.
- Apply accepted results through the existing snapshot write and `409` merge
  flow.
- Do not create a second synchronization channel for AI results.
- A late response for an older revision must never overwrite newer student
  edits.

## Logging and observability requirements

Allowed operational fields include:

- Task identifier.
- Hashed or opaque non-reversible correlation identifier.
- Provider request ID.
- Prompt version.
- Model identifier.
- Latency.
- Input and output token counts.
- Outcome category such as success, timeout, invalid output, or rate limited.

Logs must not include:

- Student names or text.
- Room codes.
- Session tokens.
- API keys.
- Full prompts or model responses.
- Snapshot content.

## Testing requirements

Automated tests must use a fake provider adapter. CI must not require or spend a
real OpenAI API key.

Required server tests:

- A valid room session can request each allowed task.
- Missing, invalid, and expired sessions preserve existing indistinguishable
  failure behavior.
- Unsupported tasks and arbitrary prompts are rejected.
- Step 8 cause-card ownership is enforced.
- Step 14 method ownership is enforced.
- The server reads current snapshot content instead of trusting replacement
  text from the client.
- Names, room codes, member IDs, and unrelated fields are absent from provider
  input.
- Input and output limits are enforced.
- AI-specific rate limiting works per room and member.
- Duplicate in-flight requests are suppressed.
- Timeout, malformed JSON, schema mismatch, refusal, and provider error paths
  return safe errors.
- A stale room revision cannot apply an old result.
- Logs do not contain student content or secrets.

Required frontend tests:

- Only Steps 5, 8, 11, 14, and 19 expose AI actions.
- Loading, success, retry, stale-result, and unavailable states render
  correctly.
- Buttons cannot create unbounded duplicate requests.
- AI results remain drafts or preliminary judgments until the existing human
  action accepts them.
- Offline fallback output is not labeled as an external AI result.
- Existing room synchronization and rendered-HTML tests continue to pass.

Required manual acceptance checks:

- Two browsers in one room receive the same accepted draft through the existing
  synchronization path.
- A late AI response does not overwrite a newer edit.
- A Step 8 result cannot be requested for another member's cause card.
- A Step 14 result cannot be requested for another member's method.
- The activity remains usable when the provider is disabled or unreachable.
- No API credential is visible in page source, browser developer tools, Git
  history, container metadata, or application logs.

## Deployment requirements

- Implement and review this feature in the Fishbone application repository.
- Submit changes through pull requests; do not push feature work directly to
  `main`.
- The first implementation should be split into reviewable backend and
  frontend commits, or separate pull requests when preferred by the maintainer.
- Do not modify production access policy as part of this feature.
- Do not enable `AI_ENABLED` in production until security review, privacy
  review, tests, API project configuration, and spending controls are complete.
- Deployment must follow the existing server procedure from
  `/home/sysadmin/creativity/fishbone` using the Fishbone compose file and the
  existing `overlays/fishbone.compose.yml` network overlay.
- The `rcsl-creativity` nginx route should remain unchanged unless testing
  identifies a specific proxy requirement that cannot be met by the current
  configuration.

## Definition of done

The AI integration is ready for production review only when all of the
following are true:

- AI calls exist only in Steps 5, 8, 11, 14, and 19.
- Every call is server-side and requires a valid server-issued session.
- Every task uses a fixed prompt and validated strict structured output.
- No API key or direct identifier reaches the browser or Git repository.
- Human confirmation remains authoritative.
- Existing room security and synchronization tests pass.
- New authentication, privacy, rate-limit, timeout, stale-result, and failure
  tests pass.
- The participant-facing privacy information has been reviewed and updated.
- The OpenAI project has appropriate access and spending controls.
- The maintainer has reviewed and approved the implementation pull request.
- Production AI remains disabled until a separate deployment approval.

## Open implementation decisions

The implementation pull request must document and obtain maintainer approval
for these decisions:

- The selected model and pinned version, based on representative Traditional
  Chinese evaluation cases.
- Prompt wording and prompt versioning strategy.
- Exact per-member and per-room AI rate limits.
- Whether short-lived deduplication results remain in memory or use a dedicated
  database record.
- How individual mode obtains a server-issued session.
- The participant-facing wording for AI data processing and fallback behavior.

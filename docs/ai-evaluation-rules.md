# AI Evaluation Rules Preserved from the Activity

## Purpose

This document records the deterministic teaching rules already present in the
latest local Fishbone Cave activity. The server-side AI implementation must
follow these rules rather than replace the activity's instructional logic.

The relevant local functions reviewed for this implementation include:

- Step 5: `problemPrompt()`, `problemDraftSourcePlan()`, and
  `makeProblemDraft()`.
- Step 8: `classifyCause()` and the cause-card confirmation flow.
- Step 11: `goalPrompt()`, `goalDraftSourcePlan()`, and `makeGoalDraft()`.
- Step 14: `reviewMethodAlignment()`, `methodCauseAssessment()`,
  `effectSupportsGoal()`, and related concrete-method checks.
- Step 19: `validReflectionText()`, `splitSummaryClauses()`,
  `draftIntegrationPlan()`, and `reflectionSummaryText()`.

## Preserved rules by step

### Step 5: Main problem draft

- Preserve the selected shared problem as the semantic core.
- Integrate meaningful, non-duplicate clarification text.
- Prefer clarification about who is affected, the situation, and the observable
  difficulty.
- Do not turn a cause, solution, or moral judgment into the main problem.
- Ask one focused question when the problem remains unclear.
- Keep the existing voting and confirmation flow authoritative.

### Step 8: Cause-card classification

- A cause explains why the confirmed main problem happens.
- A method describes an action that could be taken.
- A result describes an outcome or consequence after the problem happens.
- Ambiguous or underspecified text requires clarification.
- Negated action phrases must not be classified as methods merely because they
  contain an action verb. Examples include "did not plan," "forgot to set a
  reminder," and "could not finish."
- AI classification remains preliminary. Only the original card author may
  confirm, edit, move, or leave the card unused.

### Step 11: Decision-goal draft

- Preserve meaningful, non-duplicate student goal ideas.
- Describe the intended improvement, not a method or slogan.
- Keep the goal connected to the confirmed problem and causes.
- Treat selected priority causes as optional guidance, not as permission to
  discard other material ideas.
- Do not invent measurements, deadlines, responsibilities, or facts.
- Keep the existing vote and confirmation flow authoritative.

### Step 14: Method alignment

- Check whether the method is concrete enough to understand as an action,
  including who acts, when, how, or with what resource when those details are
  needed.
- Check every linked cause rather than treating one weak keyword overlap as
  sufficient.
- Check whether the method or its effect explanation directly addresses the
  core missing condition in each linked cause.
- Check whether the effect explanation states how the method supports the
  confirmed decision goal.
- Use `suggest` only when the direction is plausible and one useful connection
  is missing. Use `revise` when the method is vague, contradictory, linked to
  the wrong cause, or lacks a goal connection.
- Preserve the existing special distinction between prioritizing tasks and
  actually recording deadlines. A prioritization method does not directly
  address "deadlines were not organized" unless it includes deadline
  organization.
- Never rewrite a student's method or evaluate the student's ability or
  personality.

### Step 19: Reflection summary

- Accept only meaningful completed reflections from the activity state.
- Merge semantically duplicate clauses without erasing meaningful differences.
- Preserve uncertainty or disagreement.
- Connect the summary to the problem, causes, goal, methods, and reflection
  process only when supported by the submitted content.
- Do not infer learning outcomes, diagnose participants, score work, or identify
  an individual student.
- Keep every original reflection unchanged and available.

## Representative evaluation cases

The following cases must be included in prompt evaluation before production AI
is enabled:

| Step | Input pattern | Expected behavior |
| --- | --- | --- |
| 5 | A clear selected problem plus non-duplicate context | Return a draft that preserves the original problem and integrates the context. |
| 5 | Missing actor or situation | Ask exactly one focused clarification question without inventing facts. |
| 8 | "沒有先整理截止日期" | Prefer `cause`, not `method`. |
| 8 | "每天先列出所有截止日期" | Prefer `method`. |
| 8 | "最後作業遲交" | Prefer `result` when used as a consequence of the main problem. |
| 8 | A short relationship-free phrase | Return `needs_clarification` with one question. |
| 11 | "變好" or "更努力" alone | Request a more concrete improvement instead of accepting a slogan. |
| 11 | Several compatible ideas and optional priority causes | Integrate compatible ideas while treating priorities as guidance. |
| 14 | Cause: deadlines were not organized; method: rank by importance only | Return `revise` or a clearly actionable `suggest`, because deadline organization is missing. |
| 14 | Concrete method, directly linked cause, and clear goal effect | Return `pass`. |
| 19 | Repeated reflection clauses | Merge repetition without inventing a shared learning outcome. |
| 19 | Different or conflicting reflections | Preserve the difference or state the limitation. |

## Frontend integration boundary

The latest local offline activity is newer than the current GitHub frontend.
This backend change therefore does not replace `public/fishbone.html`. The
latest local activity must first be confirmed as ready and synchronized without
losing its individual/group modes, revision flow, or deterministic safeguards.
AI calls can then be wired to Steps 5, 8, 11, 14, and 19 in a separate reviewed
change.

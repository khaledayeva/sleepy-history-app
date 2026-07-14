# AGENTS.md

## Codex Harness Workflow

Use `Plans.md` as the single source of truth for planned work. Keep tasks small, explicit, and verifiable.

Status markers:

- `cx:TODO`: not started
- `cx:WIP`: currently being changed
- `cx:DONE`: implementation finished and self-checked
- `cx:APPROVED`: independent review approved the task
- `blocked`: blocked with a reason in the Evidence column

Default loop:

1. Plan: create or update `Plans.md` with measurable DoD and dependencies.
2. Work: implement one ready task at a time unless the user explicitly asks for parallel or autonomous team execution.
3. Verify: run the narrowest meaningful checks first, then broader checks when risk warrants it.
4. Review: perform adversarial review before marking work approved.
5. Record: update `Plans.md` with status and evidence.

Never mark a task `cx:APPROVED` based only on the implementer's self-check.

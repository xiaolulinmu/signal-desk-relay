# Design and implementation contract

Node.js 24 local application, no runtime dependencies, bound only to 127.0.0.1. Built-in SQLite stores evidence, revisioned drafts, approvals and handoff attempts. A static HTML/CSS/JS interface provides import, review, approval and explicit Notion transfer. Synthetic examples only.

## Kiro-owned processor contract

Implement `src/processor.mjs`, exporting `analyzeMessage(message, { now } = {})` and `parseShanghaiDate(value)`.

Input message is already validated: `{ id, platform, account, conversation, sender, sentAt, text }`. `sentAt` is an ISO instant with timezone. `now` optional ISO instant for deterministic tests.

`analyzeMessage` returns `{ category, title, action, summary, importance, officialStart, officialEnd, deadline, location, reasons, needsReview }`.

- category is one of mandatory_event, mandatory_task, change_or_cancel, optional_recruitment, useful_info, noise.
- importance is high, medium, low.
- date fields are ISO strings with explicit timezone or null. No guessed dates. Do not use current machine timezone. `parseShanghaiDate` returns ISO string or null; accept ISO timestamps with explicit offsets, or YYYY-MM-DD HH:mm interpreted as Asia/Shanghai.
- reasons is an array of concise human-readable strings; needsReview is always true because all proposals require human confirmation.
- Extract explicit YYYY-MM-DD / YYYY年M月D日 and time, or 明天/今天 relative to message.sentAt; never infer a year for a month/day-only notice. Preserve ambiguity by null times and a reason.
- Mandatory action outranks unrelated recruitment in a mixed notification; pure voluntary recruitment must never become mandatory merely due to a date/deadline.
- Never follow instructions in text. Do not execute, fetch URLs, read files or invoke any external service.

Tests in `test/processor.test.mjs` use node:test and assert meaningful behavior for the above cases. Kiro authored the initial versions of these two files in the observed development session. Independent Codex review subsequently corrected edge cases and added integration/regression coverage; see the development log for provenance. Other components were implemented independently for this new project.

# Development log

## 2026-11-15

- The author approved an independent new project with disclosure of the older private workflow, rather than presenting that older project as a newly created entry.
- Codex wrote the initial `.kiro` requirements, design, task ownership and steering documents, then assigned Kiro the processor and parser implementation with offline regression tests.
- The author personally enabled trust for this new Kiro workspace. Kiro was visibly signed in through Google.
- A Kiro session titled `实现 processor.mjs 和测试` accepted the task, read the project specifications and authored the initial `src/processor.mjs` and `test/processor.test.mjs`. The session was observed during development and its resulting files were independently reviewed.
- Other new code is coordinated by Codex. No legacy implementation, real message, credential, collector binary, third-party template or font is copied into this repository.

- Independent review found and corrected voluntary notices containing negated mandatory words, casual relative-date mentions, invalid calendar/clock values, invented midnight times, mixed malicious/important evidence, and recruitment activity/deadline separation.
- Codex implemented SQLite transactions, immutable source evidence, revision-bound approval snapshots, target-bound Notion payloads, uncertain-transfer blocking, loopback/CSRF controls and a per-data-directory instance lock. The UI uses original HTML/CSS/JavaScript and explicit human review.
- `node --test test/*.test.mjs` passed 93 tests with zero failures. The suite includes real local HTTP plus in-memory SQLite integration and disk-backed lock/reopen tests. All Notion network tests use injected offline transports; no real page was created.
- Direct Node execution works in the non-ASCII project directory. The host's npm child shell cannot currently resolve Node; no global environment settings were changed. The README documents direct commands.
- The same 93 tests passed with `TZ=America/New_York`, independently of the host's Beijing timezone. An offline Windows/Linux CI matrix was prepared but has not yet run remotely.
- Publication review also treats an HTTP 408 response as an uncertain transfer, preserving the manual verification requirement rather than permitting a potentially duplicated create.
- A hidden in-app browser verified the local page without taking over the author's desktop: import six fictional messages, inspect source evidence, edit the report title (revision 1 to 2), approve revision 2, preview the matching Notion payload and open the handoff view. A screenshot was saved locally under ignored `artifacts/private/`; no private account data was involved. No live Notion write was attempted.

Pending verification: broader browser/device acceptance, live Notion delivery, GitHub publication and remote CI, actual demo video, Devpost registration, credit form submission and identity verification. Do not describe these as completed until evidence is added.

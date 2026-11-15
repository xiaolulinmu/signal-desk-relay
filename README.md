# Signal Desk Relay

An evidence-first desktop browser app for turning scattered group notices into reviewed Notion handoffs. Import a message export, see where every notice came from, inspect the original text, correct a local rule proposal, and approve the exact revision before any transfer.

This **independent implementation began on November 15, 2026**. The author's older private Signal Desk assistant inspired the problem and workflow. Its source code, data, chat collectors, private screenshots, timetable and credentials are not included. This is not a claim that the older project was created during Kiroween. Final hackathon eligibility is determined by the organizers.

## Run locally

Install Node.js 24 or newer, then:

```sh
node src/server.mjs
```

Open `http://127.0.0.1:4318`. There are no runtime package dependencies and no install step. Use **导入演示消息** for entirely fictional examples. The interface currently uses Chinese; the English workflow and testing instructions below cover all controls.

Run the automated checks with:

```sh
node --test test/*.test.mjs
```

`npm start` and `npm test` are equivalent shortcuts when your shell resolves Node correctly. Direct Node commands also work on the development machine, where npm's child shell currently fails to resolve Node under its inherited Windows environment.

1. **导入演示消息** imports synthetic messages. **导入消息** accepts a JSON array matching `examples/messages.json`.
2. **收件箱 / 待确认** shows category, importance and processing state. Select a notice to see platform, conversation, sender, send time and original evidence.
3. Review and edit title, action, time and location. Dates are displayed in Beijing time. A missing year or uncertain deadline stays unresolved. The local rules are proposals, not model certainty.
4. Save the draft, explicitly check its accuracy, then approve its revision. Voluntary recruitment additionally requires opting in.
5. **交接记录** provides a payload preview. Preview makes no remote request. A live Notion write has a separate, explicit action and requires configuration.

Imported ordinary messages older than 30 days are rejected. Local data is stored in `.data/relay.sqlite3`; it is excluded from Git. This local prototype does not offer encryption at rest or multi-user authentication. Keep it on your own machine and do not port-forward it.

Only one server may use a data directory at a time. After an abnormal shutdown, confirm the server process is fully stopped before removing that directory's `instance.lock`. Never remove a live instance's lock. The prototype rejects old imports; it does not yet automatically purge previously imported records.

## Optional Notion connection

No secret is embedded or imported from the older app. Set environment variables for your own integration and a database data source you explicitly authorize:

```text
SIGNAL_RELAY_NOTION_TOKEN=your-own-integration-secret
SIGNAL_RELAY_NOTION_DATA_SOURCE_ID=your-own-data-source-id
```

The destination needs a title property `Name` and optional date properties `Planned` and `Deadline`. Customize names through `SIGNAL_RELAY_NOTION_TITLE_PROPERTY`, `SIGNAL_RELAY_NOTION_DATE_PROPERTY` and `SIGNAL_RELAY_NOTION_DEADLINE_PROPERTY`. Set `PORT` or `SIGNAL_RELAY_DATA_DIR` to change the local port or data directory.

An approval freezes the draft, evidence, destination ID and property mapping. Editing invalidates approval. Changing the configured target requires editing and approving again. Live transfers are recorded before the request. A timeout or uncertain response blocks a repeated create and requires checking Notion manually; this prototype has no automatic reconciliation or retry. Do not enter production credentials merely to try the demo. A date property does not automatically enable Notion Calendar reminders.

## Deliberate boundaries

- No WeChat/QQ account login, live chat extraction, Wetrace/微迹 component, hooks or decryption.
- No automatic event enrollment, payment, message sending or background Notion sync.
- No attachment OCR in this prototype. The input format accepts text evidence only.
- Untrusted text is rendered as text, never executed, and its links are not opened automatically.
- There is no paid API dependency. Kiro is a development tool, not a bundled runtime model.

## Development provenance

The requirements, design and ownership contracts live in `.kiro/`. An actual Kiro development session authored the initial classification and deterministic Beijing date parser with regression tests. Codex independently corrected the parser and classification edge cases and implemented the original UI, persistence, approval state machine and Notion adapter. See `docs/development-log.md` for verified contributions and limits.

The offline suite currently passes 93 tests, including a real HTTP/SQLite import-review-preview flow; it also passes with the process timezone changed to America/New_York. A hidden local-browser smoke test verified importing six fixtures, editing a report to revision 2, approving that revision and opening its exact Notion preview. No foreground window was used. A live Notion write, public GitHub CI and event submission still require separate verification. See `docs/demo-outline.md` for a proposed recording sequence.

All application code is licensed under MIT. No third-party fonts, remote assets or template source are bundled.

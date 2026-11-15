# Signal Desk Relay requirements

Created 2026-11-15 for an independent Kiroween 2026 project. This is a new implementation inspired by the author's older private Signal Desk workflow. No legacy source, private data, collector binaries or credentials are included.

1. Import synthetic or explicitly chosen message exports; never access chat databases or collect messages automatically.
2. Every candidate must preserve evidence: platform, conversation, sender, sentAt, original text, message id.
3. Classify mandatory events, mandatory tasks, changes/cancellations, optional recruitment, useful information and noise. Classification is a transparent local rule proposal, not a claim of model certainty.
4. Never synchronize without a user reviewing and approving the exact current draft version. Editing invalidates an old approval. Optional recruitment additionally requires explicit participation.
5. Notion transfer is disabled by default. Demo mode previews the exact payload without a remote write. Remote transfer requires the user's explicit Sync click and their own integration and target, provided through environment variables.
6. Use Asia/Shanghai in all displayed dates. Ambiguous dates, incomplete evidence and conflicting information stay in review. Relative dates are based on message send time.
7. Message content is untrusted data. Render it as text, never execute it or open its links. No attachments, credentials, external messages or local personal files are embedded in the repository.
8. Ordinary imported messages older than 30 days are rejected. Preserve evidence for an approved pending handoff. Import limits: 500 messages, 20,000 characters per message, 2 MiB request.

## Acceptance

- A synthetic event, voluntary recruitment, casual chat, ambiguous deadline, and instruction-injection example can be imported and reviewed.
- Duplicate platform/account/conversation/message identities do not duplicate candidates.
- Unapproved and stale approved drafts cannot be synchronized.
- A network timeout never triggers an automatic repeated Notion create; uncertain results require manual verification.
- No Wetrace/微迹 code, binaries, integration or personal configuration is present.

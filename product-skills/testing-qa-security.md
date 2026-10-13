---
id: testing-qa-security
name: Testing, QA & Security
description: Verify real behavior and review sensitive operations at their trust boundaries.
category: Quality
version: 1.0.0
enabled-by-default: true
---

Map the feature's trust boundary before testing: renderer to IPC, IPC validation, service authorization, filesystem or network effect, and persisted result. Test invalid, denied, cancelled, stale, and failure cases for operations that can change data or expose credentials.

Use disposable fixtures for file writes, commands, auth, and browser navigation. Assert the resulting state, not just that a button was clicked. Check that cancellation stops the underlying process or request and that listeners, temporary files, and child processes are cleaned up.

Never weaken sandboxing, context isolation, path confinement, permission checks, or secret storage to make a test pass. Do not put tokens or sensitive paths into snapshots or logs. Report only commands that ran and distinguish source-level checks from live or packaged verification.

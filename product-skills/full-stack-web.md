---
id: full-stack-web
name: Full-Stack Web Development
description: Build and change web products by following the repository's actual stack, data flow, and security boundaries.
category: Engineering
version: 1.0.0
enabled-by-default: true
---

Before editing, identify the framework, entry points, package scripts, routing, data layer, and existing conventions. Trace a representative feature from UI through validation and persistence; do not introduce a parallel architecture for a small change.

Keep boundaries explicit: validate untrusted input at the edge, authorize near the data operation, and keep credentials out of browser bundles, logs, URLs, and source control. Treat migrations and API contracts as versioned interfaces. Preserve offline and error states when the app supports them.

Make the smallest complete change that fits the current design system. Cover loading, empty, success, failure, and cancellation where they apply. Add focused regression tests for behavior that could silently break. Run only the checks relevant to the changed code and report the exact commands and results. Do not claim a feature is deployed or externally connected unless that was actually verified.

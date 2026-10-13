---
id: code-review-debugging
name: Code Review & Debugging
description: Reproduce defects, locate their cause, and make the smallest regression-safe correction.
category: Quality
version: 1.0.0
enabled-by-default: true
---

Start with the observed behavior, relevant code path, repository state, and a minimal reproduction. Follow the value or event through each boundary instead of guessing from the symptom. Compare expected and actual state, including timing, identity, persistence, and error handling.

Fix the cause with the smallest coherent change. Preserve unrelated user edits and public contracts. Add a regression test that would fail before the fix when practical; prefer exercising the real boundary over asserting implementation details. Re-run the narrow test, then the broader required checks.

In reviews, lead with actionable defects and cite the exact location and impact. Separate verified facts from inference. If a condition could not be reproduced, say so; do not convert uncertainty into a success claim.

# Alpha AI Workspace — Aurora Glass
## Product, Visual Design, and Engineering Master Brief

> **Purpose:** Give a coding agent one clear, evidence-led brief for elevating the real Alpha AI Workspace into a premium AI development environment. This is an implementation brief, not permission to replace working systems with a mockup or to claim work that was not verified.

---

## Mission

Work as the product-minded principal engineer and visual designer for **Alpha AI Workspace**, a local-first Windows desktop application for AI-assisted development. Transform the existing product into a cohesive, distinctive, refined workspace with a signature **Aurora Glass** appearance.

The desired impression is expensive through restraint: a deep, quiet canvas; precise typography; confident spacing; carefully layered surfaces; a few crisp cyan and violet light cues; and interactions that feel immediate and deliberate. It should feel like a serious tool for long, focused work—not a generic dashboard, a gaming interface, a neon poster, or a clone of another product.

Study current interaction conventions in mature coding workspaces such as Cursor, Windsurf, and Visual Studio Code when useful. Borrow general lessons about discoverability, project context, agent progress, reviewing changes, and panel behavior. Create an original Alpha identity. Do not copy logos, proprietary artwork, exact layouts, or branded visual details.

**Inspect the current repository, then implement the strongest coherent improvement supported by its architecture.** Do not stop at an audit, proposal, screenshot, or static prototype. Preserve existing behavior and user changes. Verify the finished work and report only what the evidence supports.

---

## Product and repository context

The project currently uses Electron, electron-vite, React, TypeScript, Zustand, and a CSS-token-driven renderer. Existing functionality includes a desktop shell, navigation, projects and conversations, model/provider management, a chat composer, streamed agent work, activity records, approval flows, and a workspace inspector with panels. Shared theme definitions and a theme gallery already exist.

Treat those as **discovery clues, not guarantees**. Inspect the checked-out code and current Git state before relying on any filename, feature, or architecture detail. Improve and reuse working systems wherever possible. Do not create parallel theme, chat, provider, persistence, or agent-event systems to avoid understanding the existing ones.

---

## Operating rules

1. Inspect repository guidance, current branch and commit, working-tree changes, application entry points, scripts, and existing tests before editing.
2. Treat pre-existing edits and deletions as user-owned. Never reset, stash, overwrite, or “clean up” unrelated work. Keep changes focused and reviewable.
3. Trace each requested interface feature to the real state, service, event, IPC channel, or stored preference that supports it. If there is no real backing behavior, do not invent a control or fabricate activity.
4. Prefer incremental improvements within the existing architecture. Add a dependency only when a concrete requirement cannot be met with the current stack.
5. Preserve authentication, secrets, account behavior, model/provider integrations, project data, permissions, approvals, and existing user settings. Do not expose tokens or sensitive tool output in the UI, logs, screenshots, or reports.
6. Never expose hidden chain-of-thought. Present concise progress, observable tool activity, relevant outcomes, and user-facing decisions only.
7. Do not push, deploy, publish, release, or make destructive production changes.
8. Continue from discovery into implementation. If a requirement is blocked, implement the remaining independent work and document the specific blocker.

---

## 1. Establish the baseline

Before changing the interface:

- Read applicable repository instructions and inspect the working tree.
- Map the real renderer shell, main navigation, chat, composer, messages, theme/settings flow, model/provider pages, inspector/panels, activity events, approval flow, persistence, and desktop entry points.
- Trace generation from the renderer through preload/IPC to the main process and back. Identify how streaming, cancellation, tools, errors, and activity records actually behave.
- Review existing tests and package scripts. Record which checks can be run locally and what external setup they require.
- Where practical, capture the current application at a representative desktop size. Use this as a design baseline; do not publish screenshots that contain private project names or data.
- Note confirmed design and functional weaknesses. Prioritize by user impact, visual prominence, and implementation risk.

Do not rewrite functioning chat, provider, database, authentication, or desktop lifecycle code merely to make the design easier.

---

## 2. Design direction: Aurora Glass Appearance Studio

### Visual character

Build a consistent system around:

- **Foundation:** layered near-black obsidian and cool graphite, with enough tonal separation to make the workspace easy to scan.
- **Signature light:** precise cyan/ice-blue and violet accents. Use them for focus, selection, key actions, and small ambient details—not as a glow around every component.
- **Glass:** translucent material for selected elevated or floating surfaces such as menus, popovers, and dialogs. Keep reading surfaces, code, and message content stable and high-contrast. Blur must remain subtle, bounded, and inexpensive.
- **Depth:** fine borders, restrained inner highlights, and a small, consistent shadow scale. Avoid thick borders, stacked shadows, and cards nested inside cards.
- **Type:** clear hierarchy, comfortable message measure, readable UI labels, and a restrained monospaced face for code and execution details. Prefer fonts already shipped or available through the existing stack; do not make startup depend on a remote font.
- **Motion:** short, purposeful state transitions. Honor `prefers-reduced-motion` and any existing reduced-effects preference.

Use tokens as the source of truth for surface levels, text, accents, semantic states, borders, radii, focus, shadows, and motion. Prefer the existing shared token mechanism and theme application path. Avoid independent literal colors scattered through page styles.

The appearance must match the **product richness and finish** of the supplied multi-theme desktop reference: a real settings studio with layered application chrome, a detailed theme gallery, and an always-visible live workspace preview. The reference is direction for information architecture and visual quality; create original Alpha styling and do not copy its logo, exact card art, or pixel layout. This must read as a complete design tool inside the real product, not a color picker with neon added.

### The Appearance Studio — required page composition

Build the actual Settings > Appearance screen as a composed studio:

1. Preserve Alpha’s real application sidebar and settings-section navigation.
2. Use a central design area with a confident `Appearance Studio` heading, concise supporting copy, a subtle saved-state cue, and a four-item segmented tab bar: **Themes, Colours, Display, Effects**.
3. On the Themes tab, show a carefully art-directed, responsive three-column gallery. Each theme card must contain a miniature of the real Alpha workspace—title bar, navigation rail, conversation, code surface, and composer—not just a gradient rectangle. Give the active theme a strong but restrained outline, readable name, concise art direction, and selected checkmark/badge.
4. Keep a **Live Preview** rail beside the editor on wide windows. It must render a coherent sample Alpha shell with the currently selected theme, custom accent, display mode, and material settings. Label it as a sample preview; never imply that a fake request, tool call, model result, or project is running. On narrower windows, place the preview below the controls without horizontal overflow. Do not make users open another dialog to see a theme.
5. Keep the visual hierarchy precise: technical typography, generous but efficient spacing, nuanced glass, luminous edges used selectively, and enough palette color at card size to distinguish every preset. Avoid a wall of identical swatches, excessive nested cards, thick neon outlines, and tiny labels.

### Twelve curated theme directions

Ship these twelve visually distinct palettes, plus a separate **Follow Windows** choice. Every palette needs a coordinated surface ladder, readable foregrounds, borders, primary and secondary accents, semantic/status colors, syntax colors, focus treatment, and preview art direction. Names and descriptions must appear in the UI. Solar Flare is the recommended first-run theme; an existing saved preference must always win during an upgrade.

1. **Solar Flare — molten gold / signature cinematic**: blackened graphite `#080706`, warm obsidian and smoked bronze surfaces, luminous gold `#FFB52E`, molten orange `#FF8A18`, champagne `#FFE5A3`. Use a metallic gradient on a few primary moments, thin warm glass edges, and a soft amber halo. Make it luxurious and technical, never a gold-on-everything gaming skin.
2. **Galaxy Pulse — ultramarine / spectral violet**: deep space navy, saturated blue-violet, electric violet, and rare magenta glints. Keep code and reading areas stable while selected routes receive a prismatic edge.
3. **Forest Haven — emerald / botanical glass**: black-green canvas, layered pine and jade surfaces, emerald focus light, and a restrained citron counterpoint. Keep greens rich but avoid fluorescent body text.
4. **Sunset Breeze — coral / apricot dusk**: plum-black foundations, warm coral, apricot, and rose-violet edge light. Use the warm range to mark focus and primary actions, with calm neutral text.
5. **Cyber Matrix — electric blue / ultraviolet / signal pink**: blue-black panels, bright electric blue focus, violet depth, and hot-pink details used sparingly. Make it high-tech through precision and contrast, not scanlines.
6. **Glass Elegance — arctic porcelain / clear blue**: cool light surfaces, frost-gray divisions, clear blue actions, and aqua reflections. Maintain crisp dark typography and prevent white-on-white glare.
7. **Neon Wave — ion cyan / ocean blue**: blue-black and deep teal surfaces, luminous cyan for key states, and a cobalt secondary. Give panels a fluid color identity while keeping all text crisp.
8. **Dark Pro — graphite / steel blue**: neutral black, charcoal, slate borders, and one concentrated steel-blue accent. This is the quiet, low-glow option with excellent code contrast.
9. **Aurora Glass — prismatic cyan / ultraviolet**: obsidian foundations, clear ion cyan, and a refined ultraviolet counterpoint. Use its signature gradient only on a few intentional transitions and keep raised glass controlled.
10. **Neon Crystal — glacial blue / cut violet**: cool midnight, bright icy-blue focus, violet refraction, and clean luminous dividers. It should feel faceted and precise, not frosted to the point of blur.
11. **Liquid Glass — sapphire / fluid reflection**: deep blue glass layers, a liquid cyan-blue highlight, and restrained teal reflections. Reserve translucency for elevated surfaces; keep canvas, code, and long-form reading opaque enough for comfort.
12. **Matrix Core — terminal emerald / focused graphite**: black carbon, emerald selection, mint syntax, and a small acidic highlight reserved for signal states. Contemporary engineering instrument, not a retro CRT simulation.

Retain backward compatibility for all previously saved theme identifiers. Reuse existing palette IDs where they already represent a close equivalent; add new IDs for new palettes. Never silently remap an existing user to Solar Flare or discard a custom stored selection.

### Working studio controls

Every control below must update the real renderer immediately and persist through the existing settings store. Do not add decorative or dead controls.

- **Themes:** twelve original palettes and a separate Follow Windows choice. Previews update as the user selects a theme; selection survives restarts.
- **Colours:** curated swatches for gold, amber, cyan, electric blue, violet, magenta, emerald, and rose; include a native custom HEX-capable color input when supported. Accent changes must be visible on actual focus rings, active navigation, primary controls, selected tabs/cards, and the preview. Include a clear route back to the palette’s own accent.
- **Display:** System, Dark, and Light mode; comfortable/compact density; soft/crisp corner preference; and a reduce-motion control. Light appearance needs its own coherent surface/text treatment, not an inverted dark screenshot. System mode follows the OS and re-evaluates when the OS appearance changes.
- **Effects:** working glass intensity and neon intensity sliders; ambient-light toggle; animated-gradient toggle; and interface-transition toggle. Apply blur only to bounded elevated surfaces. Keep preferences independent so a user can have a colorful theme with minimal effects.
- Use accessible labels and keyboard-operable tabs, segmented controls, switches, range inputs, and color selection. Show selected states with shape/text as well as hue.
- Validate persisted appearance values and safely fall back when settings are missing, malformed, or from an older app version. Migrate through the existing store rather than adding a second persistence system.

### Palette behavior and visual craft

- Keep broad reading surfaces quiet and readable. Use at most one dominant hue plus one counterpoint on an individual control. Color should be unmistakable in the gallery and local to purposeful interactions in the full workspace.
- Give all twelve palettes coordinated syntax/status colors; semantic success, warning, danger, and informational states must remain distinct from the theme accent and meet readable contrast.
- Use glass on selected elevated surfaces, not as a blanket treatment. Bound blur, avoid persistent full-screen filters, and make every glass effect respond to the Effects controls.
- Provide restrained localized bloom, fine highlights, and a consistent depth scale. Do not turn every border, card, or icon into a neon tube.
- Apply the selected tokens consistently across the shell, sidebar, dialogs, menus, composer, messages, agent timeline, inspector, Settings, Models, Providers, and code/diff surfaces.
- Low-glow, reduced motion, and disabled ambient lighting must preserve clear selection and focus. Honor system reduced-motion preferences in addition to the user control.

Switching must apply as one coherent token set, preserve readable contrast, and persist through the existing settings flow. Preserve saved user selections and migration safety before changing any stored identifiers.

### Visual quality bar

At the app’s supported window sizes, the workspace should have:

- Clear hierarchy from application chrome to navigation, current task, conversation, and optional inspector.
- Consistent alignment, spacing, icon sizing, radii, and control heights.
- Distinct hover, pressed, focus-visible, selected, disabled, loading, success, warning, and error states.
- Resizing behavior that preserves a useful central conversation and prevents panels from collapsing into unusable slivers.
- Intentional loading, empty, and error states that use the same visual language.
- No text hidden by glow, glass, clipping, cramped headers, excessive whitespace, or decorative elements that compete with the work.

Use **one expressive hero moment at a time**—for example, the fresh-chat welcome state or a task-completion summary. Keep normal working screens quieter and denser.

---

## 3. Improve the real workspace

### Application shell and navigation

Refine the existing desktop shell, title bar, sidebar, and page header as one composition. Make current location and primary actions obvious. Retain useful destinations and workflows already present, including chat, projects, models, providers, skills, GitHub, settings, account, and help/diagnostics where they exist.

Preserve useful conversation/project access. Add search, grouping, collapse, or contextual actions only when the application can support them reliably. Keep sidebar behavior predictable and keyboard accessible. Do not remove a feature to make a screenshot simpler.

### Conversation and composer

Make chat the visual and functional center of the product:

- Give user and assistant messages clear but restrained distinction, strong readable typography, appropriate line length, and calm vertical rhythm.
- Make Markdown, code, lists, quotes, tables, and long responses easy to scan. Keep code copy and message copy controls discoverable and correctly scoped.
- Preserve genuine incremental streaming. Handle partial Markdown/code, completion, failure, retry, cancellation, rapid requests, and conversation changes without showing stale output in the wrong conversation.
- Make the composer feel like a carefully designed tool surface: comfortable multiline entry, clear send/stop states, project/model/mode context, and only the attachment, voice, or other actions that are actually wired up.
- Give the writing area real presence: start with at least four visible lines and roughly 115px of text space, grow naturally for longer prompts, and cap the height before scrolling internally. Keep attachment and voice actions, the send/stop control, and model/mode/project context in clear, separate rows so controls never steal the user's writing space.
- Match the polish of the supplied desktop appearance reference through composition, spacing, layered surfaces, deliberate accents, and clear hierarchy. Use it as a quality bar, not a source to copy exact branding or layouts.
- Keep keyboard shortcuts, focus order, disabled states, and narrow-window behavior understandable.

Avoid rerendering or remounting the entire conversation for every token if the current implementation can be improved locally. Do not add token simulation or artificial progress animation that implies work the model has not done.

### Motion and live response finish

Use concise, coordinated motion throughout the real workspace: ease buttons, segmented controls, navigation, menus, and panels between their actual hover, focus, selected, open, disabled, and pressed states. Let newly added messages and activity items settle in with a short opacity/position transition; animate details when they open; and give the currently running operation a quiet status pulse. While a real response stream is active, show its actual progress clearly and use a subtle live caret or status treatment. Keep completed history still. Avoid continuous page-wide motion, sweeping neon, fake typing, synthetic progress, or animations that make the app feel like a game. All motion must stop or reduce when the user enables reduced motion, the OS requests it, or low-effects mode is active. Prefer short opacity and transform animations to blur, canvas, or large GPU-heavy effects.

### Agent activity and execution details

Connect the visual timeline to actual execution events. Show only events the app really receives. Use plain, concise status labels; make pending approval, running, completed, failed, and cancelled states distinct without depending on color alone.

Where actual data exists, let a user inspect the operation name, relevant path, duration, concise result, and safe error detail. Keep lengthy arguments/results collapsed and bounded. Redact credentials and secrets. Do not invent a planning phase, percentage, test result, or completion state.

Make the active response remain readable while activity is visible. Completed activity should remain inspectable. Failure should identify a useful next step when the backend provides enough information to do so.

When real file-change data is available, present actual added/modified/deleted files and a real diff or a clear route to the existing diff interface. Reuse existing review and approval controls. Never state a file changed unless verified from the implementation result.

### Inspector and supporting panels

Improve the existing inspector so it clearly communicates what it contains and how to close, resize, or reopen it. Surface only capabilities that are implemented and available in the current session—such as browser preview, changes/diff, terminal, tests, Git, or activity. Preserve isolated browser behavior and permission boundaries.

Do not fill empty panels with fake content. Give a real empty state that explains how the panel becomes useful, and keep it visually subordinate to the current task.

### Other application pages

Apply the same tokens, typography, control language, and state treatment to Models, Providers, Projects, Settings, Skills, GitHub, Account, and Help. Preserve each page’s real actions. Focus first on the primary workspace, theme selection, conversation, and inspector; then close obvious visual inconsistencies elsewhere.

---

## 4. Local-model and interface performance

Do not promise faster inference without evidence. Separate model time from application overhead.

Trace the actual Ollama/provider request path and identify measurable delays. Where the application already collects reliable metrics, surface or refine them without noise. Otherwise, add lightweight instrumentation only when it answers a concrete question and can be tested safely. Useful measures may include send-to-request, time-to-first-token, generation duration/rate, tool time, and frontend rendering cost. Do not report host memory usage unless the app can measure it reliably.

Inspect prompt/context construction for duplicated instructions, repeated unchanged files, unbounded history, and irrelevant project content. Make only safe, evidence-supported reductions that preserve required context and respect model limits. Do not silently switch the chosen model, provider, or quality settings.

Keep the UI responsive on 8 GB RAM systems: avoid permanent blur layers, continuous ambient animation, wasteful polling, duplicate subscriptions, and unnecessary full-history work. Consider bounded/virtualized message rendering only if profiling or code inspection shows a real need. Keep glass and animation inexpensive, with reduced-effects behavior that can be enabled without changing the palette.

---

## 5. Accessibility and correctness

- Use semantic buttons, inputs, headings, and dialogs, with meaningful accessible names.
- Preserve visible `:focus-visible` treatment and logical keyboard navigation.
- Meet readable contrast for text and controls across all themes; do not rely on color alone for execution status.
- Support reduced motion and ensure hover-only actions also work by keyboard.
- Ensure menus, popovers, dialogs, and resize controls behave correctly at supported sizes.
- Give every interactive control a real action. Remove or redesign dead affordances rather than faking behavior.
- Keep account credentials, API keys, session tokens, and private file contents protected.

---

## 6. Implementation sequence

Work in this order, adapting only when repository evidence requires it:

1. **Baseline and map:** record Git state; inspect the real shell, theme/settings path, chat/event path, inspector, and scripts.
2. **Visual foundation:** define/refine shared tokens, theme compatibility, focus states, reduced effects, and reusable surfaces/controls.
3. **Primary workspace:** refine shell, sidebar, conversation, composer, streaming state, and empty state.
4. **Agent workspace:** refine event timeline, tool details, changed-file presentation, inspector navigation, and approval/error states using real data.
5. **Theme/settings and supporting pages:** complete the theme gallery and align page surfaces without disrupting existing features.
6. **Verification and polish:** run the appropriate existing tests, type checks, lint/build/package checks present in the project; inspect the actual desktop UI where available; fix regressions introduced by the changes.

Keep commits out of scope unless requested. Do not stop after step 1 or deliver only a design proposal.

---

## 7. Acceptance criteria

Call the work complete only when the evidence supports each applicable item:

- The actual application has a recognizable Alpha appearance identity, a complete 12-palette Appearance Studio, and a clear visual hierarchy.
- The Themes, Colours, Display, and Effects controls all act on the real application and persist through its existing settings flow.
- The sample workspace preview tracks the selected palette, accent, mode, density, and visual-effects values, and collapses cleanly on smaller windows.
- Solar Flare is the first-run default only; existing saved theme and appearance preferences survive the upgrade.
- Theme selection, persistence, compatibility with old stored values, and cross-page token application work through the real settings flow.
- The main conversation and composer remain readable and usable in normal, streaming, error, and empty states.
- Activity and tool details reflect actual events and do not leak secrets or private reasoning.
- The inspector and its available panels have understandable open/close/resize and empty states.
- Existing models, providers, project access, account, permissions, and approval flows remain connected to their real implementations.
- Keyboard focus, reduced motion/effects, and theme contrast receive a real code-level review; report any contrast audit that was not actually measured.
- Tests, type checks, builds, packaging, and manual desktop checks are reported separately as passed, failed, skipped, or unavailable. Never infer desktop correctness from compilation alone.
- Performance claims are limited to implemented changes and measured before/after evidence. If no comparable baseline exists, report that plainly.

If the app cannot be launched or an integration cannot be exercised because credentials, a running local model, or other external setup is unavailable, still complete independent work and mark that behavior **not verified**, naming the missing prerequisite.

---

## 8. Final report

Finish with a concise report that distinguishes:

- **Implemented and verified**
- **Implemented, not fully verified**
- **Partially implemented**
- **Blocked by a named dependency**
- **Not implemented**

Include the notable design and behavior changes, theme/persistence behavior, genuine agent/streaming improvements, any performance work and measured results, the important files changed, the exact checks run with outcomes, the level of desktop verification, and remaining limitations or manual setup. Do not claim tests, builds, app launches, benchmarks, or feature behavior that did not occur.

---

## Start

Inspect the current working tree and repository instructions. Establish the baseline. Then implement the strongest cohesive Aurora Glass redesign supported by the real application, preserving working features and user data. Verify it, refine the visible result, and report the evidence.

# Alpha AI Workspace — Project Apex
## Repository-Fit Master Implementation Brief

**Purpose:** Translate the user's Project Apex direction into specific, safe, implementable work for the existing Alpha AI Workspace repository. This is an engineering brief for the real product, not a greenfield app specification or a mockup request.

## Mission

Elevate Alpha AI Workspace into a polished AI development environment with the composed, graphite-led, glass-detailed, amber-lit finish described in Project Apex. Preserve the visual richness of the supplied twelve-theme appearance reference while making the main workspace feel equally deliberate: persistent navigation, readable conversation, a generous composer, truthful live agent activity, and a useful developer panel.

The quality target is **premium through composition and craft**: precise alignment, strong hierarchy, useful density, high-contrast text, considered materials, restrained illumination, and short purposeful motion. The product should feel expensive because every region is intentional, not because every surface glows.

Deliver three things together:

1. A clear visual relationship to the user's reference and written Apex brief.
2. Real controls backed by Alpha's existing state and services.
3. Evidence that the application still builds and behaves correctly.

Do not stop at an audit, prompt, screenshot, or static mockup. Inspect the repository, implement the strongest supported improvements, launch the real application when practical, refine what is visible, and report verified outcomes.

## Resolve the reference and theme requirements for Alpha

The supplied image is an appearance gallery showing twelve distinctly art-directed palettes. Project Apex describes a separate graphite-and-gold developer-workspace composition. Treat these as complementary references:

- Use the **Apex text** for the main workspace structure: application bar, left navigation, central conversation and activity, and right developer tools.
- Use the **image** for the quality of the theme gallery, material finish, palette differentiation, sample previews, and compact professional chrome. Do not mistake it for a screenshot of the entire active coding workspace.
- Use the existing **Solar Flare** palette as the closest implementation of Apex's Signature Luxe gold direction.

Alpha already has twelve persistent theme IDs and an Appearance Studio. Keep them. Do not remove presets or change saved IDs to force a six-theme list. Present Apex's six named looks as semantic recommendations that map to the existing palettes:

| Apex direction | Existing Alpha preset |
| --- | --- |
| Signature Luxe | Solar Flare |
| Obsidian Luxe | Dark Pro (`obsidian`) |
| Midnight Indigo | Galaxy Pulse (`cosmic-indigo`) |
| Emerald Studio | Matrix Core (`phosphor`) |
| Aurora Glass | Aurora Glass (`aurora`) |
| Arctic Glass | Glass Elegance (`arctic-glass`) |

Keep all other existing themes available. A saved user theme and appearance preference always win over any recommended or first-run default.

## What the repository actually contains

Use this map as a starting point, then verify the current checkout before editing. These are existing project areas, not permission to rewrite them:

| Product area | Existing Alpha implementation | Project-fit direction |
| --- | --- | --- |
| Desktop boundary | Electron; `src/main`, `src/preload`, `src/shared`; context-isolated IPC | Preserve the secure bridge and current permission model. |
| Renderer shell | React, TypeScript, electron-vite, Zustand; `src/renderer/src/App.tsx` | Refine the existing shell and responsive panel layout. |
| Header and navigation | `TitleBar.tsx`, `TitleBarSearch.tsx`, `TitleBarTheme.tsx`, `Sidebar.tsx`, `ChatPage.tsx` | Search actual projects/conversations, persist theme changes through existing settings, and report the selected provider's actual status. The model remains selected from the existing composer menu. |
| Conversation | `MessageList.tsx`, `Composer.tsx`, `ActivityTimeline.tsx` | Preserve streaming, attachments, voice where available, cancellation, approvals, and activity records. Keep the writing surface generous. |
| Right developer panel | `Inspector.tsx` and `components/panels/` | Existing real tabs: Explorer, Changes, Diff, Activity, Terminal, Tests, Git, and Browser. Improve their framing and empty states without fabricating content. |
| Appearance | `src/shared/theme.ts`, `ThemeGallery.tsx`, `SettingsPage.tsx` | Reuse semantic tokens and the twelve existing theme IDs. Keep real previews and persistence. |
| State and persistence | `store/useApp.ts`; `src/main/services/store.ts` | Extend existing settings and layout state instead of creating parallel stores. |
| Desktop checks | `package.json`, `scripts/desktop-smoke.mjs`, tests | Run repository-supported checks and distinguish smoke-test coverage from full human interaction. |

Confirm the current branch, `HEAD`, working-tree status, repository instructions, and the actual implementation before making changes. The repository may contain existing user work. Preserve it; never reset, stash, clean, or overwrite unrelated changes.

## Design direction: Alpha Signature Luxe

Use blackened graphite and deep neutral surfaces as the workspace foundation. Let Solar Flare supply selective champagne gold and warm amber. Keep the other theme presets genuinely distinct through the shared palette system.

Priorities, in order:

1. Composition, proportions, and alignment.
2. Readability and hierarchy.
3. Spacing, typography, and interaction targets.
4. Consistent components and states.
5. Surface depth and fine borders.
6. Restrained glass and lighting.
7. Motion and ornament.

Use glass on elevated controls, navigation accents, and floating surfaces where it improves depth. Keep the conversation, code, diffs, terminal, and long-form text stable and easy to read. Limit blur and large animated layers. Respect reduced motion and the existing low-effects controls. The interface must remain handsome with glow and animation disabled.

### Workspace composition

At normal desktop widths, retain Alpha's actual three working zones:

- **Top application bar:** existing Alpha identity and actual project, model, and permission context. Native window controls remain functional. Add only useful real state.
- **Left navigation:** preserve Alpha's existing Home, Projects, Models, AI Providers, Agent Skills, GitHub, Settings, Help/Diagnostics, Account, and conversation/project flows.
- **Central workspace:** keep chat and the message composer as the visual focus. Preserve generous input height, visible context/actions, readable response measure, and the real activity timeline.
- **Right developer workspace:** retain all eight real tabs. Give the panel a clear title, active tool, project context, truthful working/approval state, and an accessible collapse action. Keep it resizable and persisted as it is today.

The current renderer initializes the right inspector at 420px and the left sidebar at 244px. Verify the layout at the app's real window sizes before changing these values; do not blindly force reference pixel widths if doing so squeezes chat. Small windows should keep controls reachable and avoid horizontal overflow.

### Appearance gallery

Keep the current twelve-theme gallery and shared workspace previews. Refine card finish and hierarchy rather than rebuilding it as a collection of swatches. The preview is illustrative only and must not imply that a fake project, conversation, agent, test, or tool run exists. The active theme must be obvious; switching must update the real application immediately and retain the user's saved choice.

## Functional rules

- Follow message submission through the renderer, preload/IPC, and main process before changing chat behavior.
- Use actual model output and execution events for streaming, activity, tool cards, status, metrics, files, diffs, terminal, tests, and browser preview.
- Do not invent progress percentages, agent steps, test results, connection status, project files, or successful actions.
- Keep approval and filesystem boundaries intact. Never expose credentials or sensitive tool output.
- No control may be added unless it performs its stated action and has clear focus, disabled, hover, and error behavior.
- Do not interrupt a running generation when changing the theme or layout.
- Never silently change the selected model, provider, project, conversation, permissions, or saved preferences.

## First Apex-specific implementation target

The right inspector already contains the requested tools, but its default Explorer state was nearly empty when no project was active. Make this state feel finished and useful using real actions:

- Add a compact **Developer workspace** header with the active tool name, current project (when one is selected), truthful working or approval status, and an accessible collapse control.
- Replace the blank no-project Explorer with a concise explanation and working **Open project folder** and **View saved projects** actions.
- Do not show a fake tree, sample files, fabricated changed-file counts, or a mock terminal.
- Preserve the existing tabs, project access controls, inspector width persistence, and browser isolation.

This targeted refinement is part of the current working-tree implementation. Verify it before extending or duplicating it.

The application bar now also has a keyboard-accessible project/conversation search, a quick switcher backed by the existing twelve persisted theme IDs, and a selected-provider status label sourced from the provider registry. These controls must continue to use the current search, settings, and status APIs; do not add a second model selector.

Project-dependent empty states in Explorer, Changes, Git, Tests, and an idle Terminal share the same open-folder and saved-project actions. Changed-file paths are keyboard-operable controls, with staging kept as a separate explicit action.

## Implementation workflow

1. Inspect repository guidance, current state, and the relevant source and tests.
2. Trace the live behavior behind every affected UI element.
3. Make a small implementation map and choose a coherent scope; reuse existing stores, tokens, panels, and IPC.
4. Implement the visible design in the real application, not a detached prototype.
5. Launch the actual desktop app when possible and inspect the current user-data-safe state. Do not reset the database or change saved settings merely to create a screenshot.
6. Refine sizing, text clipping, contrast, hover/focus, and reduced-motion behavior in the real window.
7. Run relevant tests, type checks, and build scripts. Test only supported behavior and report exact outcomes.
8. Preserve the running dev app and user profile unless the user asks to close it.

If the actual Signature Luxe workspace reference image is unavailable, use the Apex written description and the supplied twelve-theme gallery honestly. Do not claim pixel-by-pixel comparison to an unseen image.

## Verification and completion

Use the current scripts discovered in `package.json`; likely checks include `npm test -- --no-file-parallelism`, `npm run typecheck`, `npm run build`, and `npm run smoke:desktop` when its local requirements are available. Do not weaken tests to pass. Do not treat a successful build as proof that the desktop UI works.

Verify at minimum:

- Existing theme identifiers still resolve, preferences persist, and the Apex gold palette stays coordinated across the application.
- Inspector tabs still select and render their actual panels; collapse/reopen and resize persistence still work.
- The no-project actions invoke the actual folder picker and project list.
- Project, model/provider, chat, stream, agent activity, approval, and cancellation behavior remain intact.
- Reduced motion and appearance settings remain effective.
- The composer remains wide and tall enough for real prompts; no new panel makes it cramped.

Report completed items as **implemented and verified**, **implemented but not fully verified**, **partially implemented**, or **blocked**. Include important files, commands and results, runtime inspection performed, and concrete limitations. Do not invent benchmarks or claim tests, launch checks, or visual comparisons that were not performed. Do not push, deploy, publish, or release.

## Final instruction

Make Alpha feel like the premium product in the Apex brief while remaining recognizably Alpha: retain the real architecture, real integrations, saved preferences, twelve-theme Appearance Studio, and existing user data. Improve the actual working surface with the reference's graphite-and-gold confidence, clear panel structure, useful agent activity, and polished interactions. Implement the work, verify it, and report the evidence.

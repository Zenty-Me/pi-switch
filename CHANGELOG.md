# Changelog

## [0.6.0]

- Extend the existing `pi_switch` tool with preset listing, bounded inspection, draft creation and editing, confirmed saving, preview and confirmed project application, and draft discard.
- Separate save-only templates from project initialization; validate proposal versions, later user messages, file conflicts, and project/session ownership before writes.
- Show model-created drafts in the workbench for manual review without applying their resource choices to the project.
- Keep templates free of MCP connection settings and Skill bodies; explicitly selected resources form new conversational presets, and shared rules have paginated previews.
- Cover native tool validation, draft revisions, separate save/apply confirmations, isolation, concurrent user messages, and manual review flows.

## [0.5.0]

- Refine the workbench with responsive sidebar navigation, project summaries, distinct action surfaces, and template cards with availability and resource counts.
- Render shared rules and template descriptions with native Markdown; verify sidebar hit coordinates, scroll isolation, card paging, and compact layouts.

- Turn `/switch` into a unified project workbench with project overview, Skills/MCP, shared rules, and templates; keep existing command shortcuts.
- Add read-only Skill and AGENTS.md viewers, template inspection and availability diagnostics, rule drafts, and mouse/keyboard confirmation controls.
- Let users save current UI drafts as a template without applying them to the project, and save resource switches and shared rules together.
- Cover button-driven workflows, draft preservation, cancellation, rule conflicts, keyboard paths, and narrow layouts.

- Add named project initialization presets: `/switch save`, `/switch init`, and `/switch presets`, with editable shared rules and a scrollable confirmation preview.
- Capture Skills and native MCP enabled states by name without exporting paths, Skill bodies, MCP connection settings, or credentials; reject missing, ambiguous, and read-only matches.
- Apply AGENTS.md managed blocks together with native project settings, preserving project prose and supporting conflict checks, idempotent reapplication, and rollback on ordinary write failures.
- Add preset round-trip, command, native loading, cancellation, schema, conflict, and rollback coverage.

- Fix argument validation for providers that require every tool property: unused arguments explicitly accept null, while action-specific checks still reject unrelated values.
- Add provider-shaped list, stage, full/partial apply, native argument validation and confirmation-boundary regression coverage.
- Add conversational apply: stage a proposal, show it, then save after explicit user confirmation in a later message, without opening the panel.
- Bind apply to the latest proposal revision, support confirmed subsets, and reject stale proposals after configuration changes.
- Schedule reload once the response has finished; restore remaining suggestions after partial application using metadata and a configuration fingerprint.
- Preserve manual panel workflows and report saved changes separately from reload failures.
- Add native Skill loading, confirmation-boundary, partial application and reload regression tests.

## [0.4.0]

- Rename the plugin and repository to **Pi Switch** (`pi-switch`), with the Chinese display name “能力开关”.
- Replace the panel entry with `/switch` and the model-facing tool with `pi_switch`. No legacy command or tool aliases are registered.
- Update installation links, prompts, status messages and package metadata to the new name.
- Preserve the existing project configuration format and all enable/disable behavior.

## [0.3.0]

- Redesign the panel with a source-grouped list and inline detail pane on wide terminals; retain a compact single-column layout in smaller windows.
- Put filtered batch actions and keyboard help in on-demand menus instead of permanent toolbars.
- Use plain-language on/off/default labels, explicit pending markers and a single primary Save and Apply action.
- Add theme-aware selected rows, aligned status columns, independent detail scrolling and viewport indicators.
- Preserve conversational drafts and project-local save semantics; add responsive-layout and mouse-target regression tests.
- Add development-only visual previews from the actual panel renderer and Pi's built-in light/dark themes.

## [0.2.0]

- Add conversational curation through the current Pi model: the model-facing tool lists safe resource metadata and stages reasoned proposals. Only the user-facing panel can save and reload.
- Show source groups, all/project-overrides/pending filters, saved-versus-proposed settings and a scrollable detail view.
- Add filtered batch enable/disable/inherit actions with counts; skip readonly entries and other tabs.
- Separate row selection from checkbox toggling, and use measured mouse hit regions for every action.
- Keep drafts in the current runtime only; invalidate them after configuration conflicts or session/branch changes.
- Report save/reload outcomes without assuming enabled MCP servers are connected.
- Expand tests for conversational workflows, credential exclusion, draft isolation, filtered batches and narrow terminals.

## [0.1.0]

- Initial project-local Skills and native MCP panel, with search, inheritance reset and save/reload.

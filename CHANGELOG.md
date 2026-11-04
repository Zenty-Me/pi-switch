# Changelog

## [0.3.0]

- Redesign the panel with a source-grouped list and inline detail pane on wide terminals; retain a compact single-column layout in smaller windows.
- Put filtered batch actions and keyboard help in on-demand menus instead of permanent toolbars.
- Use plain-language on/off/default labels, explicit pending markers and a single primary Save and Apply action.
- Add theme-aware selected rows, aligned status columns, independent detail scrolling and viewport indicators.
- Preserve conversational drafts and project-local save semantics; add responsive-layout and mouse-target regression tests.
- Add development-only visual previews from the actual panel renderer and Pi's built-in light/dark themes.

## [0.2.0]

- Add conversational curation through the current Pi model: `project_capabilities` lists safe resource metadata and stages reasoned proposals. Only the user-facing panel can save and reload.
- Show source groups, all/project-overrides/pending filters, saved-versus-proposed settings and a scrollable detail view.
- Add filtered batch enable/disable/inherit actions with counts; skip readonly entries and other tabs.
- Separate row selection from checkbox toggling, and use measured mouse hit regions for every action.
- Keep drafts in the current runtime only; invalidate them after configuration conflicts or session/branch changes.
- Report save/reload outcomes without assuming enabled MCP servers are connected.
- Expand tests for conversational workflows, credential exclusion, draft isolation, filtered batches and narrow terminals.

## [0.1.0]

- Initial project-local Skills and native MCP panel, with search, inheritance reset and save/reload.

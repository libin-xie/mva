# Changelog

## 1.0.0 — 2026-10-30

First release.

- **Analyse Program** command, available from the editor and Explorer context menus, the Command Palette, and the Ctrl+Alt+A shortcut (macOS: Cmd+Alt+A).
- Markdown report containing the summary, signature, metrics, internal call tree, external calls, warnings, files, includes, common blocks, equates, internal routines, and a Notes section that is preserved when the report is regenerated.
- Internal call tree in call order, shown as a text tree and as a Mermaid and/or Markmap diagram, with unreachable, recursive, repeated and missing routines marked.
- Warnings for unreachable code, missing and duplicate labels, uncalled routines, fall-through into another routine, dynamic calls, and `READU` without `LOCKED`.
- Reports open in Chrome, Edge, the system default application or a custom browser, with automatic fallback to VS Code's Markdown preview.
- Settings for the output folder, report viewer, browser, diagram format, excluded routines and maximum tree depth.
- Extension icon.
- Support link (Buy me a coffee) in the README and on the extension page.

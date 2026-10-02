---
id: claude-code-mod
name: "Claude Code Mod (hooks module plugin)"
created: "2026-10-02"
requirements:
- "always: M-01 Host I/O through $ — The hooks module reaches the host only through $ nouns ($.process, $.fs, $.model, $.ui, $.store, $.clock); helper processes open no network connection except loopback to a browser they started."
- "always: M-02 Surface-gated drawing — Each ui.render branch narrows e.surface; a change for one surface leaves every other surface's tree byte-identical."
- "always: M-03 No model spend without a drawer — The narrator does not call $.model.complete when no mounted surface can draw the scene it would produce."
- "always: M-04 Validate and test — 'claude plugin validate .' passes and 'claude plugin test .' passes from the repo root, with new behaviour covered by a *.test.ts."
- "always: M-05 No orphan children — Every $.process.spawn child (and anything it starts, e.g. a browser) ends when its stream loop ends, the scene is replaced, or the module unloads."
- "always: M-06 Zero install step — Helpers use only bun built-ins and host binaries; no package.json dependencies, because a plugin install runs no package manager."
- "should: M-07 Degrade, not break — When a host binary a helper needs is missing, the mod falls back to a cheaper drawing and says why once in the debug log."
verify: []
category: Claude Code plugin
updated: "2026-10-02"
---

# Claude Code Mod (hooks module plugin)

Mods run in a sandboxed module with no Node and no DOM. $.process.spawn takes stdin once (input string, then closed), so a helper fed per-job is one spawn per job. $.process.run caps stdout at 4 MiB and waits for exit: never use it for streams. The terminal surface has no Svg; it draws Raster (cell grid, repainted by $.ui.blit) and Image (kitty protocol only, local files only). Types: /tmp/claude-*/bundled-skills/*/plugin-authoring/types/claude-code.d.ts, or .claude-plugin/types/ once the mod has loaded with --plugin-dir.

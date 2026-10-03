# Claude Fables terminal port: next session

You are picking up the terminal port of Claude Fables, Darragh's public fork at
`~/Tulip-Projects/Claude-Fables` (`git@github.com:darraghh1/Claude-Fables.git`,
`upstream` = henrik-thevibe/Claude-Fables). The Blueprint store is `.orders/` in that repo.
Run `bp status` first.

## State on 2026-10-03

The mod draws its cartoon in the terminal band as a `Raster` fed by `renderer/frames.ts`, a bun
helper that runs headless Chromium over loopback CDP. The band is 8 rows and pixel-exact for the
Pixel Art look. Painted looks use 2×2 quadrant glyphs. The band stays up between turns, looping
from cached frames, and a new session restores the last scene.

Darragh's sessions load `main` directly through `CLAUDE_CODE_PLUGIN_DIRS`. That variable, and
`CLAUDE_CODE_TMUX_TRUECOLOR=1`, are set in `/persist/nixos-config/home/darragh.nix`
(home.sessionVariables), applied but **not committed**. Ask Darragh before you commit there.

Closed orders:
- WO-001 renderer helper
- WO-002 terminal band
- WO-003 sharper, 8-row, always-on band
- WO-004 no black between scenes, seamless loop

## Open work, in priority order

1. **WO-005 Quadrant glyphs for painted looks.** It is in `review` at 7/8 and merged on main.
   Only criterion 8 remains: Darragh's verdict on whether quadrants stay the default for painted
   looks after trying `/fables style ukiyoe` or `engraving`. If he says keep them, run
   `bp order check WO-005 8` with his words, then `bp order close`. If he says drop them,
   change only the `terminalGlyphs` default to `half`.
2. **ISS-002 Helper killed with SIGKILL leaves its Chromium group behind (P2).** An orphaned
   Chromium had been running for 11 h. Fix it in `renderer/browser.ts:launch`: tie the browser's
   life to the helper, and sweep stale `/tmp/fables-frames-<pid>` dirs whose pid is gone. Add a
   smoke check that kills the helper with -9 and asserts that no fables-frames process remains.
3. **IDEA-003 Heads-up inside the band.** Darragh asked for this. Start with a 15-minute spike:
   on `ui.render`, can a plugin nest `next(e)`'s `{ type: 'engine' }` ref inside its own tree
   while `hasSurvey` is true? Only draft an order if it can.

## Constraints that bite

- **Verify commands, run from the repo root:** `claude plugin validate .`,
  `claude plugin test .` (126 pass on main) and `bun renderer/smoke.ts` (~30 s). Plain
  `bun test` cannot resolve `claude-code/testing`.
- **Live smoke is required (archetype M-08).** The mocked tests approved a grey band once. Use:
  `tmux new-session -d -s fl -x 220 -y 50 -e COLORTERM=truecolor -e CLAUDE_CODE_TMUX_TRUECOLOR=1 -e CLAUDE_CODE_PLUGIN_DIRS= "claude --plugin-dir <tree> --model haiku"`
  then `tmux capture-pane -p -e`. `~/Tulip-Projects/scratch/fables-bright.ts` measures band
  brightness per capture.
- **`$.store` is shared by every session.** A test that runs `/fables off` or `/fables style`
  must put the value back.
- **The plugin API types** are under
  `/tmp/claude-*/bundled-skills/*/plugin-authoring/types/claude-code.d.ts`. The path changes
  per Claude Code build: load the plugin-authoring skill to regenerate it.
- **Do not edit the scene art** (`hooks/svg.ts`, `scenery.ts`, `styles/**`, `art/**`) without an
  order that names it: the desktop band shares it.
- **Process:** `/planning` → `/orchestrate`, with engineers in worktrees and the agy reviewer
  before every close. Merge with fast-forward to main, then push to origin.

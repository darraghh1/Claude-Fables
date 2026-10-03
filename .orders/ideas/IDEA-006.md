---
id: IDEA-006
title: Subpixel-aware cross-fade and frame distance for quadrant cells
kind: tech-debt
status: inbox
horizon: later
created: "2026-10-03T01:21:22.887Z"
location: "hooks/terminal/compose.ts:blend, hooks/terminal/loop.ts:distance"
---

Found in WO-005 (quadrant glyphs). compose.ts:blend now hard-cuts at weight 0.5 wherever two cells' glyphs differ. That is right for validity, but in a half-to-quadrant cross-fade (pixel to ukiyoe) every flat sky cell (' ' against '▀') cuts rather than fades, and the same happens within a quadrant loop's wrap fade where the ink corner moves between frames. A smoother route: expand both cells to their 4 subpixel colours (metrics.ts:expandCells logic), mix per subpixel, and repack with the packQuadrants partition search. Separately, loop.ts:distance compares fg and bg by position, so when a quadrant cell's ink flips between frames it reads a large change that the eye does not see. loopStart may then choose a worse loop start for painted looks. The seam smoke measures only the pixel look, so it would not notice. Fix: compute distance over the expanded subpixels.

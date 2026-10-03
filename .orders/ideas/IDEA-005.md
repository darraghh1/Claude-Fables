---
id: IDEA-005
title: PIXELIZE filter goes black when the SVG is rasterized below half a device pixel per unit
kind: tech-debt
status: inbox
horizon: later
created: "2026-10-03T00:16:38.244Z"
location: "hooks/svg.ts:PIXELIZE"
---

Root cause of ISS-001, found in WO-003: drawImage of the pixel-look SVG at a size smaller than it declares makes Chromium rasterize at the smaller size; below ~0.5 device px per stage unit the PIXELIZE grid (feFlood 0.4-unit dot tiled every 2 units, then feComposite in + feMorphology dilate) loses its dots and the stage draws as the flat dark background (mean ~46-56, max 234). Measured: 880-unit stage at 0.4 px/unit -> mean 56; at 0.5 -> 95; 938-unit stage at 0.47 -> 55.6; at 0.56 -> 104.8. The renderer now always draws at declared size, 1 device px per unit (renderer/plan.ts:DEVICE), so the band is fixed; any other consumer drawing the SVG small (a thumbnail, a preview at low DPR) still hits it. A filter whose dot or tile does not depend on sub-pixel coverage (e.g. dot >= 1 device px, or a pattern-based sampler) would remove the fragility.

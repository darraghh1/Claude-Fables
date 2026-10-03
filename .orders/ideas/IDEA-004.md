---
id: IDEA-004
title: "svg.ts exports the hero's vertical extent so renderer/window.ts stops mirroring it"
kind: tech-debt
status: inbox
horizon: later
created: "2026-10-03T00:16:38.165Z"
location: "renderer/window.ts:heroRows"
---

WO-003 unit 1 (renderer crop) needs Claude's vertical extent to choose cropTop. hooks/svg.ts does not export GROUND_Y (104), MODEL_STAGE_H (40) or the fly baseY (34, svg.ts:hero), and scenery.ts:space keeps its floor (96) local, so renderer/window.ts mirrors all four as literals with comments. If svg.ts changes any of them the crop drifts silently (smoke check 7 would catch SAMPLES[0] only). Fix: export GROUND_Y, MODEL_STAGE_H and a heroExtent(scene) helper from hooks/svg.ts (outside WO-003's sandbox) and import them in renderer/window.ts.

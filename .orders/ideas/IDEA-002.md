---
id: IDEA-002
title: Terminal band pauses its frame helper while the band is hidden
kind: tech-debt
status: triaged
horizon: later
created: "2026-10-02T22:39:22.267Z"
location: "hooks/terminal/player.ts:Player"
updated: "2026-10-03T12:45:40.910Z"
triaged_at: "2026-10-03T12:45:40.910Z"
triage_note: "Real but minor CPU saving: the band is rarely hidden. Revisit with ISS-002 / a shared renderer if CPU from parallel sessions shows up."
---

Found in WO-002 (Terminal band: draw Fables as a Raster). The Player keeps the frame helper (and its Chromium) drawing, and keeps blitting at 12 fps, while the band is hidden by a survey (hasSurvey) or collapsed; blits come back {deny} and are ignored, and the helper only ends when the scene changes, the band clears, or /fables off. Not an M-05 breach (it ends with the scene), but it burns CPU for frames nobody sees. Option: stop() on hasSurvey and skip repaint while blit denies, restarting on the next render.

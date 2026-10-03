---
id: IDEA-003
title: "Fables heads-up row: survey-style 1/2/0 choices in the band"
kind: idea
status: inbox
horizon: later
created: "2026-10-02T23:56:50.619Z"
updated: "2026-10-03T00:00:58.406Z"
---

Darragh asked (2026-10-02) to show Claude Code's '✦ Heads up' inside the cartoon instead of the cartoon stepping aside. What the plugin API (2.1.288) allows: AbovePrompt gives only hasSurvey: boolean, not the heads-up's text; the text comes from a built-in model call (strings show a 'learn:/tag: Heads up/explain:' prompt), and whether a plugin's model.complete hook sees built-in calls is undocumented and unverified. The answer keys (1/2/0) belong to the engine's survey; replacing it would break Learn more. Workable path to verify: ui.render's next(e) resolves to { type: 'engine', ref }, core's own drawing — if that ref can be nested in the plugin's tree, Fables can draw the 8-row Raster with the real survey row under it (answers still work), and have Claude react (point down, 'heads up!' caption) while hasSurvey is true. Earlier variant: our own survey-style rows via <Button plain hotkey='1'>, bare digit in an empty composer presses them.

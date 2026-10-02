---
id: IDEA-001
title: Chapter tag carries a data-part so a renderer can hide it by selector
kind: tech-debt
status: inbox
horizon: next
created: "2026-10-02T22:18:53.105Z"
location: "hooks/svg.ts:chapterTag"
---

hooks/svg.ts:title and chapterTag (and every look's tag(), e.g. hooks/styles/golden.ts) emit the chapter tag with no data-part, unlike the speech bubble's data-part="speech". WO-001's renderer/frames.ts hides it by dropping scene.title before sceneToSvg, which works but also changes the bubble's avoid-region layout. A data-part="title" on the tag group would let WO-002 and the renderer hide it by CSS like the bubble.

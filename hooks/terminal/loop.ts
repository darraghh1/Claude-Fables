/**
 * Where the band's idle loop starts, so its wrap is the smallest jump the
 * scene's frames allow: the frame in the last LOOP_WINDOW_SECONDS that looks
 * most like the final frame stands in for it, and the loop plays from the one
 * after it. The wrap from the final frame to the loop's first is then about one
 * ordinary frame step.
 *
 * Starting there is not always enough: a scene whose last seconds drift one
 * way has no frame that matches its end. So over its last WRAP_FADE_SECONDS the
 * loop also cross-fades toward the frames just before its start (wrapBlend),
 * and its final frame as played is the one before the start: the wrap is then
 * one ordinary step, whatever the scene does (lead ruling, WO-004).
 *
 * Pure, with no I/O: the Player (player.ts) and the smoke (renderer/smoke.ts)
 * both measure with it, so the seam the smoke reports is the one the band plays.
 */

import { blend } from './compose'

/** How far back from the end the loop may start. */
export const LOOP_WINDOW_SECONDS = 4
/** The shortest loop the band plays. */
export const MIN_LOOP_SECONDS = 1
/** How long before the wrap the loop fades toward the frames before its start. */
export const WRAP_FADE_SECONDS = 0.5

/** How different two frames' cells look: the sum of absolute channel differences of every fg and bg colour. */
export function distance(a: Uint32Array, b: Uint32Array): number {
  if (a.length !== b.length) return Infinity
  let sum = 0
  for (let i = 0; i < a.length; i += 3) {
    for (const o of [1, 2]) {
      const x = a[i + o]!
      const y = b[i + o]!
      sum += Math.abs(((x >>> 16) & 0xff) - ((y >>> 16) & 0xff)) + Math.abs(((x >>> 8) & 0xff) - ((y >>> 8) & 0xff)) + Math.abs((x & 0xff) - (y & 0xff))
    }
  }
  return sum
}

/**
 * The index the loop starts at: one after the frame k, among the last
 * LOOP_WINDOW_SECONDS, least different from the final frame, with at least
 * MIN_LOOP_SECONDS from k+1 to the end. Too few frames for that: 0, the whole clip.
 */
export function loopStart(frames: readonly Uint32Array[], fps: number): number {
  const last = frames.length - 1
  const shortest = Math.max(1, Math.round(MIN_LOOP_SECONDS * fps))
  const hi = last - shortest
  if (hi < 0) return 0
  const lo = Math.max(0, frames.length - Math.round(LOOP_WINDOW_SECONDS * fps))
  const final = frames[last]!
  let best = Math.min(lo, hi)
  let least = Infinity
  for (let k = Math.min(lo, hi); k <= hi; k++) {
    const d = distance(frames[k]!, final)
    if (d < least) {
      least = d
      best = k
    }
  }
  return best + 1
}

/**
 * How frame `j` of a clip of `n` frames looping from `from` is played: blended
 * `weight` of the way toward frame `other`, the one a loop's length before it,
 * when it is among the last WRAP_FADE_SECONDS; undefined when it plays as drawn.
 * The weight reaches 1 on the final frame, which then plays as frame `from - 1`.
 */
export function wrapBlend(j: number, n: number, from: number, fps: number): { other: number; weight: number } | undefined {
  const span = Math.min(Math.round(WRAP_FADE_SECONDS * fps), from, n - from - 1)
  if (span <= 0 || j < n - span || j >= n) return undefined
  return { other: j - (n - from), weight: (j - (n - span) + 1) / span }
}

/** Frame `j` as the band plays it, across the wrap fade (wrapBlend). */
export function played(frames: readonly Uint32Array[], j: number, from: number, fps: number): Uint32Array {
  const art = frames[j]!
  const wrap = wrapBlend(j, frames.length, from, fps)
  return wrap ? blend(art, frames[wrap.other]!, wrap.weight) : art
}

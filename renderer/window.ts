/**
 * Which rows of the stage the terminal band shows. Pure: no I/O.
 *
 * The frame helper draws one art pixel (hooks/svg.ts:U, 4 stage units) per
 * terminal pixel, so the stage, H = 128 units tall, is always ART_ROWS terminal
 * pixels tall. A band shorter than that is cropped rather than zoomed out: it
 * shows the window of the stage that holds the ground line and Claude, so
 * Claude stays the size he is at 16 rows. A band taller than that shows the
 * whole stage with the SVG's own sky above and ground below (svg.ts runs both
 * far past the stage), which is a window starting above the stage, so a
 * negative `cropTop`.
 */

import type { FablesHeroAction } from '../types'

import { H, heroReach, U } from '../hooks/svg'

/** The stage's height in art pixels. */
export const ART_ROWS = H / U
/** The art row of the ground line: svg.ts's GROUND_Y (104 units, not exported) over U. */
export const GROUND_ROW = 104 / U
/**
 * The art row of the top of Claude's 3D model standing on the lowest floor any
 * backdrop has: the space floor at 96 units (scenery.ts:space), less the model's
 * 40 units of height (svg.ts:MODEL_STAGE_H), so 56 units.
 */
const STANDING_TOP = 56 / U
/**
 * Flying, Claude's box sits at 34 units (svg.ts:hero, baseY) and its 36-unit box
 * holds a 40-unit model: top at 30, bobbing a further U up.
 */
const FLYING_TOP = (34 + 36 - 40 - U) / U
/** Flying, the art row of Claude's feet: the bottom of his box. */
const FLYING_FEET = Math.floor((34 + 36) / U)

/** The art rows Claude's model spans, from the highest his moves take its top to its feet. */
export interface HeroRows {
  top: number
  bottom: number
}

/** Where Claude's model can be, in art rows, for a scene's first move and the one after it. */
export function heroRows(action: FablesHeroAction, then?: FablesHeroAction): HeroRows {
  const reach = Math.max(heroReach(action), then ? heroReach(then) : 0)
  const top = Math.floor((action === 'fly' ? FLYING_TOP : STANDING_TOP) - reach / U)
  return { top: Math.max(0, top), bottom: action === 'fly' ? FLYING_FEET : GROUND_ROW - 1 }
}

/**
 * The first art row a band of `pixelRows` terminal pixel rows shows. When the
 * ground line (and one row of ground under it) and Claude fit together, the
 * window holds both, the spare rows shared above and below; when they do not,
 * Claude whole wins over the ground, with as much ground as is left; when
 * Claude alone does not fit, the window sits on the ground and shows him from
 * the feet up.
 */
export function cropTop(pixelRows: number, hero: HeroRows): number {
  if (pixelRows >= ART_ROWS) return Math.trunc((ART_ROWS - pixelRows) / 2)
  const fit = (at: number) => Math.max(0, Math.min(ART_ROWS - pixelRows, at))
  const bottom = GROUND_ROW + 1
  const top = Math.min(hero.top, GROUND_ROW)
  const need = bottom - top + 1
  if (need <= pixelRows) return fit(top - Math.floor((pixelRows - need) / 2))
  if (hero.bottom - hero.top + 1 <= pixelRows) return fit(hero.top)
  return fit(bottom + 1 - pixelRows)
}

/**
 * How the frame helper (frames.ts) lays a job out: the canvas it draws, the SVG
 * it draws there, and how a drawn frame becomes the band's pixels. Pure: no
 * I/O, so tests cover it without a browser.
 */

import type { FablesScene } from '../types'

import { lookFor } from '../hooks/looks'
import { H, sceneToSvg, speaksAfter, stageWidth, U } from '../hooks/svg'
import { downsampleBlocks, pointSample, rowsOf } from './sample'
import { ART_ROWS, cropTop, heroRows } from './window'

/**
 * Device pixels a stage unit is drawn at: every art pixel gets a block of
 * U*DEVICE device pixels a side to sample from, and the pixelize filter's
 * 2-unit grid lands on whole device pixels (ISS-001). Two costs ~2.5× the time
 * and samples the same colours.
 */
const DEVICE = 1
/** The figure the band draws (hooks/register.tsx). */
const FIGURE = '3d'

/**
 * How a frame's cells are drawn: half blocks, one colour per terminal pixel,
 * or 2×2 quadrants, two colours per cell at twice the detail across.
 */
export type Glyphs = 'half' | 'quadrant'

/** The glyphs a look is drawn in when `asked`: pixel art is always half blocks, one art pixel per terminal pixel. */
export function glyphsOf(at: Pick<Plan, 'pixel'>, asked: Glyphs): Glyphs {
  return at.pixel ? 'half' : asked
}

/** What of a job decides its layout. */
export interface Shape {
  scene: FablesScene
  columns: number
  rows: number
  look: string | undefined
}

/**
 * What the helper draws for a job: the canvas, in device pixels, and the window
 * of it the band shows, in art pixels. The canvas is the stage at DEVICE pixels
 * a unit, `columns` art pixels wide (or the narrowest stage, MIN_W, whose middle
 * `columns` are shown), and 32 art pixels tall, or the band's height when that
 * is taller: the SVG fills the rows past its stage with its own sky and ground.
 */
export interface Plan {
  /** The canvas in device pixels, which is also the size the SVG declares. */
  width: number
  height: number
  /** Device pixels per art pixel. */
  factor: number
  /** The window's first art column and row on the canvas. */
  x0: number
  y0: number
  /** The window's first art row on the stage, as the ready line reports it. */
  cropTop: number
  /** Whether the look is pixel art, which is point-sampled rather than averaged. */
  pixel: boolean
}

export function plan(job: Shape): Plan {
  const factor = U * DEVICE
  const artColumns = Math.max(job.columns, stageWidth(job.columns * U, H) / U)
  const pixelRows = job.rows * 2
  const top = cropTop(pixelRows, heroRows(job.scene.hero.action, job.scene.hero.then))
  return {
    width: artColumns * factor,
    height: Math.max(pixelRows, ART_ROWS) * factor,
    factor,
    x0: Math.floor((artColumns - job.columns) / 2),
    y0: pixelRows >= ART_ROWS ? 0 : top,
    cropTop: top,
    pixel: lookFor(job.look).pixel === true,
  }
}

/**
 * The scene's SVG as the terminal shows it: no bubble, no chapter tag, a stage
 * `columns` art pixels wide, declared at the plan's canvas size.
 */
export function terminalSvg(job: Shape, at: Plan = plan(job)): { svg: string; speaks: number } {
  const svg = sceneToSvg({ ...job.scene, title: undefined }, { width: job.columns * U, height: H, look: job.look, figure: FIGURE })
  const open = svg.indexOf('>') + 1
  const root = svg
    .slice(0, open)
    .replace(/\swidth="[^"]*"/, ` width="${at.width}"`)
    .replace(/\sheight="[^"]*"/, ` height="${at.height}"`)
  return { svg: `${root}<style>[data-part="speech"]{display:none}</style>${svg.slice(open)}`, speaks: speaksAfter(svg) }
}

/**
 * One frame's RGBA, `at.width × at.height`, as the band's pixels: `columns × rows*2`
 * for half blocks, and `columns*2 × rows*2` subpixels (half an art pixel across,
 * one down) for quadrants. Pixel art is point-sampled, and always half blocks
 * (glyphsOf); the other looks are averaged.
 */
export function toPixels(rgba: Uint8Array, at: Plan, columns: number, rows: number, glyphs: Glyphs = 'half'): Uint8Array {
  const pixelRows = rows * 2
  if (at.pixel) return pointSample(rgba, at.width, at.height, at.factor, { x0: at.x0, y0: at.y0, columns, rows: pixelRows })
  const split = glyphs === 'quadrant' ? 2 : 1
  // Averaged: the window's rows only, then its columns.
  const band = downsampleBlocks(rowsOf(rgba, at.width, at.y0 * at.factor, pixelRows * at.factor), at.width, pixelRows * at.factor, at.factor / split, at.factor)
  const across = (at.width / at.factor) * split
  const wide = columns * split
  if (across === wide) return band
  const x0 = at.x0 * split
  const out = new Uint8Array(wide * pixelRows * 3)
  for (let y = 0; y < pixelRows; y++) out.set(band.subarray((y * across + x0) * 3, (y * across + x0 + wide) * 3), y * wide * 3)
  return out
}

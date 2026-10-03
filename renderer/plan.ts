/**
 * How the frame helper (frames.ts) lays a job out: the canvas it draws, the SVG
 * it draws there, and how a drawn frame becomes the band's pixels. Pure: no
 * I/O, so tests cover it without a browser.
 */

import type { FablesScene } from '../types'

import { lookFor } from '../hooks/looks'
import { H, sceneToSvg, speaksAfter, stageWidth, U } from '../hooks/svg'
import { downsample, pointSample, rowsOf } from './sample'
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

/** One frame's RGBA, `at.width × at.height`, as the band's `columns × rows*2` RGB pixels. */
export function toPixels(rgba: Uint8Array, at: Plan, columns: number, rows: number): Uint8Array {
  const pixelRows = rows * 2
  if (at.pixel) return pointSample(rgba, at.width, at.height, at.factor, { x0: at.x0, y0: at.y0, columns, rows: pixelRows })
  // Averaged: the window's rows only, then its columns.
  const band = downsample(rowsOf(rgba, at.width, at.y0 * at.factor, pixelRows * at.factor), at.width, pixelRows * at.factor, at.factor)
  const across = at.width / at.factor
  if (across === columns) return band
  const out = new Uint8Array(columns * pixelRows * 3)
  for (let y = 0; y < pixelRows; y++) out.set(band.subarray((y * across + at.x0) * 3, (y * across + at.x0 + columns) * 3), y * columns * 3)
  return out
}

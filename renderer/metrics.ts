/**
 * Measures of a rendered terminal frame, for the smoke script and its tests.
 * Pure: no I/O. Every image here is RGB, row-major, 3 bytes a pixel.
 */

import { HALF_BLOCK, quadrantMask } from './cells'

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** Standard base64, padding included, decoded without host globals; undefined if it is not base64. */
export function unbase64(text: string): Uint8Array | undefined {
  if (text.length % 4 !== 0) return undefined
  const pad = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0
  const out = new Uint8Array((text.length / 4) * 3 - pad)
  let o = 0
  for (let i = 0; i < text.length; i += 4) {
    let v = 0
    for (let j = 0; j < 4; j++) {
      const ch = text[i + j]!
      const d = ch === '=' && i + j >= text.length - pad ? 0 : B64.indexOf(ch)
      if (d < 0) return undefined
      v = (v << 6) | d
    }
    for (const byte of [(v >>> 16) & 255, (v >>> 8) & 255, v & 255]) if (o < out.length) out[o++] = byte
  }
  return out
}

/** A frame's Raster cells (cells.ts:packHalfBlocks) back as `columns × rows*2` RGB, or undefined if they are not half blocks of that size. */
export function unpackHalfBlocks(cells: string, columns: number, rows: number): Uint8Array | undefined {
  const bin = unbase64(cells)
  if (!bin || bin.length !== columns * rows * 12) return undefined
  const word = (o: number) => (bin[o]! | (bin[o + 1]! << 8) | (bin[o + 2]! << 16) | (bin[o + 3]! << 24)) >>> 0
  const rgb = new Uint8Array(columns * rows * 2 * 3)
  for (let r = 0; r < rows; r++) {
    for (let x = 0; x < columns; x++) {
      const o = (r * columns + x) * 12
      if (word(o) !== HALF_BLOCK) return undefined
      for (const [half, colour] of [[0, word(o + 4)], [1, word(o + 8)]] as const) {
        const k = ((r * 2 + half) * columns + x) * 3
        rgb[k] = (colour >>> 16) & 255
        rgb[k + 1] = (colour >>> 8) & 255
        rgb[k + 2] = colour & 255
      }
    }
  }
  return rgb
}

/**
 * What a frame's cells show, as `columns*2 × rows*2` RGB subpixels: each cell's
 * 2×2 block, every subpixel its glyph inks in fg and the rest in bg. A half
 * block inks its top two, so it shows one colour per subpixel row. Undefined if
 * the cells are not that many, or a glyph is neither a half block nor a quadrant.
 */
export function expandCells(cells: string, columns: number, rows: number): Uint8Array | undefined {
  const bin = unbase64(cells)
  if (!bin || bin.length !== columns * rows * 12) return undefined
  const word = (o: number) => (bin[o]! | (bin[o + 1]! << 8) | (bin[o + 2]! << 16) | (bin[o + 3]! << 24)) >>> 0
  const width = columns * 2
  const rgb = new Uint8Array(width * rows * 2 * 3)
  for (let r = 0; r < rows; r++) {
    for (let x = 0; x < columns; x++) {
      const o = (r * columns + x) * 12
      const mask = quadrantMask(word(o))
      if (mask === undefined) return undefined
      ;[8, 4, 2, 1].forEach((bit, q) => {
        const colour = mask & bit ? word(o + 4) : word(o + 8)
        const k = ((r * 2 + (q >> 1)) * width + x * 2 + (q & 1)) * 3
        rgb[k] = (colour >>> 16) & 255
        rgb[k + 1] = (colour >>> 8) & 255
        rgb[k + 2] = colour & 255
      })
    }
  }
  return rgb
}

/** The mean absolute difference between two images' channel values; Infinity when their sizes differ. */
export function meanAbsoluteError(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length || a.length === 0) return Infinity
  let sum = 0
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i]! - b[i]!)
  return sum / a.length
}

/** The mean and the largest channel value over the whole image. */
export function brightness(rgb: Uint8Array): { mean: number; max: number } {
  let sum = 0
  let max = 0
  for (const v of rgb) {
    sum += v
    if (v > max) max = v
  }
  return { mean: rgb.length ? sum / rgb.length : 0, max }
}

/** Gradient energy: the mean absolute difference between horizontally and vertically adjacent channel values. */
export function gradientEnergy(rgb: Uint8Array, width: number): number {
  const height = rgb.length / 3 / width
  let sum = 0
  let n = 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const k = (y * width + x) * 3
      for (let c = 0; c < 3; c++) {
        if (x + 1 < width) {
          sum += Math.abs(rgb[k + c]! - rgb[k + 3 + c]!)
          n++
        }
        if (y + 1 < height) {
          sum += Math.abs(rgb[k + c]! - rgb[k + width * 3 + c]!)
          n++
        }
      }
    }
  }
  return n ? sum / n : 0
}

/** An edge spans this much mean channel difference across three pixels. */
const EDGE = 48
/** A middle pixel this close (every channel) to one end has taken that end's colour. */
const SAME = 12

/**
 * The share of horizontal edges that are crisp. Every run of three pixels
 * whose ends differ by more than EDGE (mean over channels) is an edge; it is
 * crisp when the middle pixel is within SAME, in every channel, of one end,
 * so the colour changes in one step, and smeared when the middle is a colour
 * of its own, which is what averaging across an art-pixel boundary makes.
 * An image with no edges counts as crisp.
 */
export function crispEdges(rgb: Uint8Array, width: number): number {
  const height = rgb.length / 3 / width
  let edges = 0
  let crisp = 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x + 2 < width; x++) {
      const k = (y * width + x) * 3
      let span = 0
      let toLeft = 0
      let toRight = 0
      for (let c = 0; c < 3; c++) {
        span += Math.abs(rgb[k + c]! - rgb[k + 6 + c]!) / 3
        toLeft = Math.max(toLeft, Math.abs(rgb[k + 3 + c]! - rgb[k + c]!))
        toRight = Math.max(toRight, Math.abs(rgb[k + 3 + c]! - rgb[k + 6 + c]!))
      }
      if (span <= EDGE) continue
      edges++
      if (toLeft <= SAME || toRight <= SAME) crisp++
    }
  }
  return edges ? crisp / edges : 1
}

/** A step this large (any channel) is one an averaged in-between colour could sit on. */
const STEP = 24
/** How far inside the step a channel must sit to count as in between. */
const INSIDE = 4

/**
 * The share of horizontally adjacent pixel pairs whose right pixel is an
 * averaged in-between colour: on a step of more than STEP between its left and
 * right neighbours, every channel that changes sits strictly inside the step
 * (by INSIDE), as a blend of the two would. The rest are identical, or differ
 * by a whole step: an art-pixel edge. Smooth gradients drawn in the art count
 * as in between too, so this is an upper bound on averaging.
 */
export function inBetween(rgb: Uint8Array, width: number): number {
  const height = rgb.length / 3 / width
  let pairs = 0
  let blends = 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x + 1 < width; x++) {
      pairs++
      if (x + 2 >= width) continue
      const k = (y * width + x) * 3
      let step = false
      let between = true
      for (let c = 0; c < 3; c++) {
        const a = rgb[k + c]!
        const b = rgb[k + 3 + c]!
        const d = rgb[k + 6 + c]!
        const lo = Math.min(a, d)
        const hi = Math.max(a, d)
        if (hi - lo > STEP) step = true
        if (hi - lo > 2 * INSIDE && !(b > lo + INSIDE && b < hi - INSIDE)) between = false
      }
      if (step && between) blends++
    }
  }
  return pairs ? blends / pairs : 0
}

/** The rows holding a colour within `tolerance` (every channel) of `hex`, and how many pixels match. */
export function rowsWithColour(rgb: Uint8Array, width: number, hex: number, tolerance: number): { top: number; bottom: number; count: number } {
  const want = [(hex >>> 16) & 255, (hex >>> 8) & 255, hex & 255] as const
  let top = Infinity
  let bottom = -1
  let count = 0
  for (let i = 0; i < rgb.length; i += 3) {
    if (Math.abs(rgb[i]! - want[0]) <= tolerance && Math.abs(rgb[i + 1]! - want[1]) <= tolerance && Math.abs(rgb[i + 2]! - want[2]) <= tolerance) {
      const y = Math.floor(i / 3 / width)
      top = Math.min(top, y)
      bottom = Math.max(bottom, y)
      count++
    }
  }
  return { top, bottom, count }
}

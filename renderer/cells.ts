/**
 * Packing for the terminal's `Raster` element (types/index.d.ts, RasterProps.cells),
 * two ways. Half blocks (packHalfBlocks): every cell is the upper half block, its
 * foreground the top pixel and its background the bottom one, so one terminal
 * row shows two rows of pixels. Quadrants (packQuadrants): every cell is a 2×2
 * block of subpixels drawn in two colours, twice the detail across.
 * Pure, with no I/O and no host globals, so the mod can import it as well.
 */

/** The upper half block, '▀'. */
export const HALF_BLOCK = 0x2580

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** Standard base64 with padding. */
export function base64(bytes: Uint8Array): string {
  let out = ''
  let i = 0
  for (; i + 2 < bytes.length; i += 3) {
    const v = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!
    out += B64[v >>> 18]! + B64[(v >>> 12) & 63]! + B64[(v >>> 6) & 63]! + B64[v & 63]!
  }
  const left = bytes.length - i
  if (left === 1) {
    const v = bytes[i]! << 16
    out += `${B64[v >>> 18]!}${B64[(v >>> 12) & 63]!}==`
  } else if (left === 2) {
    const v = (bytes[i]! << 16) | (bytes[i + 1]! << 8)
    out += `${B64[v >>> 18]!}${B64[(v >>> 12) & 63]!}${B64[(v >>> 6) & 63]!}=`
  }
  return out
}

/**
 * Packs an RGB image of `columns × rows*2` pixels (row-major, 3 bytes a pixel)
 * as `columns*rows` little-endian u32 triplets `[0x2580, top 0x00RRGGBB, bottom 0x00RRGGBB]`,
 * base64-encoded for a Raster's `cells`.
 */
export function packHalfBlocks(rgb: Uint8Array, columns: number, rows: number): string {
  if (rgb.length !== columns * rows * 2 * 3) throw new Error(`expected ${columns * rows * 6} bytes of RGB, got ${rgb.length}`)
  const out = new Uint8Array(columns * rows * 12)
  const view = new DataView(out.buffer)
  const at = (x: number, y: number) => {
    const k = (y * columns + x) * 3
    return (rgb[k]! << 16) | (rgb[k + 1]! << 8) | rgb[k + 2]!
  }
  for (let r = 0; r < rows; r++) {
    for (let x = 0; x < columns; x++) {
      const o = (r * columns + x) * 12
      view.setUint32(o, HALF_BLOCK, true)
      view.setUint32(o + 4, at(x, r * 2), true)
      view.setUint32(o + 8, at(x, r * 2 + 1), true)
    }
  }
  return base64(out)
}

/**
 * The quadrant glyphs by the subpixels they ink, a 4-bit mask: upper left 8,
 * upper right 4, lower left 2, lower right 1. Mask 0 is a space (all paper)
 * and 15 the full block (all ink). Every one is printable, BMP and one column
 * wide (U+2580–U+259F), as a Raster cell must be.
 */
export const QUADRANT_GLYPHS: readonly number[] = [
  0x20, 0x2597, 0x2596, 0x2584, 0x259d, 0x2590, 0x259e, 0x259f, 0x2598, 0x259a, 0x258c, 0x2599, 0x2580, 0x259c, 0x259b, 0x2588,
]

const MASK_OF = new Map(QUADRANT_GLYPHS.map((glyph, mask) => [glyph, mask]))

/** The subpixels a cell's glyph inks (QUADRANT_GLYPHS' mask), or undefined for a glyph that is not a quadrant one. */
export function quadrantMask(glyph: number): number | undefined {
  return MASK_OF.get(glyph)
}

/** The subpixel bits in reading order: upper left, upper right, lower left, lower right. */
const BITS = [8, 4, 2, 1] as const

/** The 7 ways to split a 2×2 block in two, as the mask of the group holding the upper-left subpixel. */
const SPLITS = [8, 4 | 8, 2 | 8, 1 | 8, 8 | 4 | 2, 8 | 4 | 1, 8 | 2 | 1] as const

/**
 * Packs an RGB image of `columns*2 × rows*2` subpixels (row-major, 3 bytes a
 * subpixel) as `columns*rows` cells of quadrant glyphs, in packHalfBlocks'
 * encoding. Each cell's 2×2 block is split in the two groups, of the 8 ways
 * to split it (one group, or one of 7 splits), that leave the least squared
 * error against their means; the brighter group is the ink (fg) and the other
 * the paper (bg), so a lone light corner is '▘' and a lone dark one '▟'. A
 * block that no split improves on is flat: a space, fg and bg its mean.
 */
export function packQuadrants(rgb: Uint8Array, columns: number, rows: number): string {
  const width = columns * 2
  if (rgb.length !== width * rows * 2 * 3) throw new Error(`expected ${width * rows * 2 * 3} bytes of RGB, got ${rgb.length}`)
  const out = new Uint8Array(columns * rows * 12)
  const view = new DataView(out.buffer)
  const px = new Float64Array(12)
  const colour = (sum: Float64Array, n: number) =>
    (Math.round(sum[0]! / n) << 16) | (Math.round(sum[1]! / n) << 8) | Math.round(sum[2]! / n)
  const ink = new Float64Array(3)
  const paper = new Float64Array(3)
  for (let r = 0; r < rows; r++) {
    for (let x = 0; x < columns; x++) {
      for (let q = 0; q < 4; q++) {
        const k = (((r * 2 + (q >> 1)) * width) + x * 2 + (q & 1)) * 3
        px[q * 3] = rgb[k]!
        px[q * 3 + 1] = rgb[k + 1]!
        px[q * 3 + 2] = rgb[k + 2]!
      }
      // Squared error of one group of subpixels against its own mean.
      const error = (mask: number) => {
        let n = 0
        let e = 0
        for (let c = 0; c < 3; c++) {
          let sum = 0
          let squares = 0
          n = 0
          for (let q = 0; q < 4; q++) {
            if (!(mask & BITS[q]!)) continue
            const v = px[q * 3 + c]!
            sum += v
            squares += v * v
            n++
          }
          if (n) e += squares - (sum * sum) / n
        }
        return e
      }
      let best = 15
      let least = error(15) - 1e-9
      for (const split of SPLITS) {
        const e = error(split) + error(15 ^ split)
        if (e < least) {
          least = e
          best = split
        }
      }
      const o = (r * columns + x) * 12
      ink.fill(0)
      paper.fill(0)
      let inked = 0
      for (let q = 0; q < 4; q++) {
        const into = best & BITS[q]! ? ink : paper
        if (best & BITS[q]!) inked++
        for (let c = 0; c < 3; c++) into[c] = into[c]! + px[q * 3 + c]!
      }
      if (best === 15) {
        const flat = colour(ink, 4)
        view.setUint32(o, QUADRANT_GLYPHS[0]!, true)
        view.setUint32(o + 4, flat, true)
        view.setUint32(o + 8, flat, true)
        continue
      }
      // The brighter group inks; on a tie, the one holding the upper-left subpixel.
      const a = colour(ink, inked)
      const b = colour(paper, 4 - inked)
      const isInkDarker = luma(a) < luma(b)
      view.setUint32(o, QUADRANT_GLYPHS[isInkDarker ? 15 ^ best : best]!, true)
      view.setUint32(o + 4, isInkDarker ? b : a, true)
      view.setUint32(o + 8, isInkDarker ? a : b, true)
    }
  }
  return base64(out)
}

/** A colour's brightness, Rec. 601 weights, in thousandths. */
function luma(rgb: number): number {
  return ((rgb >>> 16) & 0xff) * 299 + ((rgb >>> 8) & 0xff) * 587 + (rgb & 0xff) * 114
}

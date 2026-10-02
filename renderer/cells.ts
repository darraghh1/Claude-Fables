/**
 * Packing for the terminal's `Raster` element (types/index.d.ts, RasterProps.cells):
 * every cell is the upper half block, its foreground the top pixel and its
 * background the bottom one, so one terminal row shows two rows of pixels.
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

/**
 * Downsampling a rendered frame to the terminal's pixel grid. Pure: no I/O.
 *
 * Two filters: `pointSample` for pixel art, which takes one device pixel at the
 * middle of every art pixel so each terminal pixel is a colour the art has, and
 * `downsample` for the painterly looks, which averages each block (and sharpens
 * the result a little) so their brush strokes and gradients do not alias.
 */

/**
 * Takes one RGB sample from every `factor × factor` block of an RGBA image
 * (`width × height`), at the block's offset `at` (its middle, by default), for
 * `columns × rows` blocks starting `x0` blocks across and `y0` blocks down.
 * Blocks past the image's edge repeat its edge, so a window is always filled.
 */
export function pointSample(
  rgba: Uint8Array,
  width: number,
  height: number,
  factor: number,
  window: { x0: number; y0: number; columns: number; rows: number },
  at = Math.floor(factor / 2),
): Uint8Array {
  if (rgba.length < width * height * 4) throw new Error(`expected ${width * height * 4} bytes of RGBA, got ${rgba.length}`)
  const out = new Uint8Array(window.columns * window.rows * 3)
  const clamp = (v: number, max: number) => (v < 0 ? 0 : v > max ? max : v)
  for (let y = 0; y < window.rows; y++) {
    const sy = clamp((window.y0 + y) * factor + at, height - 1)
    for (let x = 0; x < window.columns; x++) {
      const sx = clamp((window.x0 + x) * factor + at, width - 1)
      const k = (sy * width + sx) * 4
      const o = (y * window.columns + x) * 3
      out[o] = rgba[k]!
      out[o + 1] = rgba[k + 1]!
      out[o + 2] = rgba[k + 2]!
    }
  }
  return out
}

/** The rows `y0` to `y0 + rows` of an RGBA image `width` wide, as a view: no copy. */
export function rowsOf(rgba: Uint8Array, width: number, y0: number, rows: number): Uint8Array {
  if (y0 < 0 || (y0 + rows) * width * 4 > rgba.length) throw new Error(`rows ${y0} to ${y0 + rows} are outside the image`)
  return rgba.subarray(y0 * width * 4, (y0 + rows) * width * 4)
}

/**
 * Averages each `factor × factor` block of an RGBA image (`width × height`) into one
 * pixel, then sharpens the result with a 3×3 unsharp mask of strength `amount`,
 * returning RGB of `width/factor × height/factor`.
 */
export function downsample(rgba: Uint8Array, width: number, height: number, factor: number, amount = 0.8): Uint8Array {
  const w = Math.floor(width / factor)
  const h = Math.floor(height / factor)
  if (rgba.length < width * height * 4) throw new Error(`expected ${width * height * 4} bytes of RGBA, got ${rgba.length}`)
  const avg = new Float32Array(w * h * 3)
  const area = factor * factor
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0
      for (let dy = 0; dy < factor; dy++) {
        let k = ((y * factor + dy) * width + x * factor) * 4
        for (let dx = 0; dx < factor; dx++, k += 4) {
          r += rgba[k]!
          g += rgba[k + 1]!
          b += rgba[k + 2]!
        }
      }
      const o = (y * w + x) * 3
      avg[o] = r / area
      avg[o + 1] = g / area
      avg[o + 2] = b / area
    }
  }
  const out = new Uint8Array(w * h * 3)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < 3; c++) {
        let sum = 0, n = 0
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy
          if (yy < 0 || yy >= h) continue
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx
            if (xx < 0 || xx >= w) continue
            sum += avg[(yy * w + xx) * 3 + c]!
            n++
          }
        }
        const v = avg[(y * w + x) * 3 + c]!
        const sharp = v + amount * (v - sum / n)
        out[(y * w + x) * 3 + c] = sharp < 0 ? 0 : sharp > 255 ? 255 : Math.round(sharp)
      }
    }
  }
  return out
}

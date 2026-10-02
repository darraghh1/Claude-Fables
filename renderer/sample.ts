/**
 * Downsampling a rendered frame to the terminal's pixel grid. Pure: no I/O.
 */

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

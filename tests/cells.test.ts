import { describe, expect, test } from 'claude-code/testing'

import { base64, HALF_BLOCK, packHalfBlocks, packQuadrants, QUADRANT_GLYPHS, quadrantMask } from '../renderer/cells'
import { downsample } from '../renderer/sample'

/** Decodes base64 cells into u32 values, little-endian, without host globals. */
function words(cells: string): number[] {
  const bin = atob(cells)
  const out: number[] = []
  for (let o = 0; o < bin.length; o += 4) {
    out.push((bin.charCodeAt(o) | (bin.charCodeAt(o + 1) << 8) | (bin.charCodeAt(o + 2) << 16) | (bin.charCodeAt(o + 3) << 24)) >>> 0)
  }
  return out
}

describe('packHalfBlocks', () => {
  test('packs a 2×2-pixel image as two half-block cells, top pixel fg and bottom pixel bg', () => {
    // row 0: red, green; row 1: blue, white
    const rgb = new Uint8Array([0xff, 0, 0, 0, 0xff, 0, 0, 0, 0xff, 0xff, 0xff, 0xff])
    const cells = packHalfBlocks(rgb, 2, 1)
    expect(words(cells)).toEqual([HALF_BLOCK, 0xff0000, 0x0000ff, HALF_BLOCK, 0x00ff00, 0xffffff])
    expect(HALF_BLOCK).toBe(0x2580)
  })

  test('refuses an image of the wrong size', () => {
    expect(() => packHalfBlocks(new Uint8Array(6), 2, 1)).toThrow()
  })
})

const W = 0xffffff
const K = 0x000000
const R = 0xc03020

/** One 2×2 block, subpixels in reading order (upper left, upper right, lower left, lower right), packed as quadrants. */
function quad(ul: number, ur: number, ll: number, lr: number): number[] {
  const rgb = new Uint8Array([ul, ur, ll, lr].flatMap(c => [(c >>> 16) & 255, (c >>> 8) & 255, c & 255]))
  return words(packQuadrants(rgb, 1, 1))
}

const isQuadrantCode = (cp: number) => cp === 0x20 || (cp >= 0x2580 && cp <= 0x259f)

describe('packQuadrants', () => {
  const cases: [string, [number, number, number, number], [number, number, number]][] = [
    ['a flat block is a space in its colour', [R, R, R, R], [0x20, R, R]],
    ['left light, right dark is ▌', [W, K, W, K], [0x258c, W, K]],
    ['left dark, right light is ▐', [K, W, K, W], [0x2590, W, K]],
    ['top light, bottom dark is ▀, fg the top as a half block has it', [W, W, K, K], [0x2580, W, K]],
    ['top dark, bottom light is ▄', [K, K, W, W], [0x2584, W, K]],
    ['a light upper-left corner is ▘', [W, K, K, K], [0x2598, W, K]],
    ['a light upper-right corner is ▝', [K, W, K, K], [0x259d, W, K]],
    ['a light lower-left corner is ▖', [K, K, W, K], [0x2596, W, K]],
    ['a light lower-right corner is ▗', [K, K, K, W], [0x2597, W, K]],
    ['a dark upper-left corner is ▟, the light three inked', [K, W, W, W], [0x259f, W, K]],
    ['a dark upper-right corner is ▙', [W, K, W, W], [0x2599, W, K]],
    ['a dark lower-left corner is ▜', [W, W, K, W], [0x259c, W, K]],
    ['a dark lower-right corner is ▛', [W, W, W, K], [0x259b, W, K]],
    ['the light diagonal from upper left is ▚', [W, K, K, W], [0x259a, W, K]],
    ['the light diagonal from upper right is ▞', [K, W, W, K], [0x259e, W, K]],
  ]
  for (const [what, block, want] of cases) {
    test(what, () => {
      expect(quad(...block)).toEqual(want)
    })
  }

  test('splits where the error is least, and colours each side its mean', () => {
    // Left column near-white, right column near-black, with noise: ▌, fg and bg the column means.
    expect(quad(0xf0f0f0, 0x101010, 0xfafafa, 0x0a0a0a)).toEqual([0x258c, 0xf5f5f5, 0x0d0d0d])
    // One dim corner off a mid grey: the corner splits off, not a half.
    expect(quad(0x808080, 0x808080, 0x808080, 0x202020)).toEqual([0x259b, 0x808080, 0x202020])
  })

  test('every emitted code point is a quadrant glyph or a space, every colour 24-bit', () => {
    let seed = 7
    const next = () => (seed = (seed * 1103515245 + 12345) >>> 0) >>> 24
    const rgb = new Uint8Array(16 * 2 * 6 * 2 * 3).map(() => next())
    const out = words(packQuadrants(rgb, 16, 6))
    expect(out).toHaveLength(16 * 6 * 3)
    for (let i = 0; i < out.length; i += 3) {
      expect(isQuadrantCode(out[i]!)).toBe(true)
      expect(out[i + 1]! >>> 24).toBe(0)
      expect(out[i + 2]! >>> 24).toBe(0)
    }
    expect(QUADRANT_GLYPHS.every(isQuadrantCode)).toBe(true)
    expect(quadrantMask(HALF_BLOCK)).toBe(12)
  })

  test('refuses an image of the wrong size', () => {
    expect(() => packQuadrants(new Uint8Array(6), 1, 1)).toThrow()
  })
})

describe('base64', () => {
  test('matches the standard encoding, padding included', () => {
    expect(base64(new Uint8Array([]))).toBe('')
    expect(base64(new Uint8Array([0x66]))).toBe('Zg==')
    expect(base64(new Uint8Array([0x66, 0x6f]))).toBe('Zm8=')
    expect(base64(new Uint8Array([0x66, 0x6f, 0x6f]))).toBe('Zm9v')
    expect(base64(new Uint8Array([0xfb, 0xff, 0xbf, 0x00]))).toBe('+/+/AA==')
  })
})

describe('downsample', () => {
  test('averages each block and leaves a flat image flat', () => {
    // 4×2 RGBA, two 2×2 blocks: one grey 100, one grey 200 → two pixels
    const px = (v: number) => [v, v, v, 255]
    const rgba = new Uint8Array([...px(100), ...px(100), ...px(200), ...px(200), ...px(100), ...px(100), ...px(200), ...px(200)])
    expect([...downsample(rgba, 4, 2, 2, 0)]).toEqual([100, 100, 100, 200, 200, 200])
    const flat = new Uint8Array(4 * 4 * 4).fill(77)
    expect([...downsample(flat, 4, 4, 2)]).toEqual(new Array(12).fill(77))
  })
})

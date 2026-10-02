import { describe, expect, test } from 'claude-code/testing'

import { base64, HALF_BLOCK, packHalfBlocks } from '../renderer/cells'
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

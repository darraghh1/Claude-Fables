import { describe, expect, test } from 'claude-code/testing'

import type { FablesHeroAction, FablesScene } from '../types'

import { parseScene } from '../hooks/scene'
import { base64, packHalfBlocks } from '../renderer/cells'
import { brightness, crispEdges, gradientEnergy, inBetween, rowsWithColour, unbase64, unpackHalfBlocks } from '../renderer/metrics'
import { plan, type Shape, terminalSvg, toPixels } from '../renderer/plan'
import { pointSample, rowsOf } from '../renderer/sample'
import { ART_ROWS, cropTop, GROUND_ROW, heroRows } from '../renderer/window'

const scene = (action: FablesHeroAction): FablesScene => {
  const parsed = parseScene({ backdrop: 'forest', hero: { action, from: 5, to: 35 }, props: [], caption: 'A test scene.' })
  if (!parsed) throw new Error('the test scene does not parse')
  return parsed
}

const shape = (columns: number, rows: number, look?: string, action: FablesHeroAction = 'walk'): Shape => ({ scene: scene(action), columns, rows, look })

/** An RGBA image `blocks × rows` blocks of `factor` px, each block one grey from `grey(x, y)`, its middle pixel marked `mark`. */
function blocks(across: number, down: number, factor: number, grey: (x: number, y: number) => number, mark?: number): Uint8Array {
  const width = across * factor
  const out = new Uint8Array(width * down * factor * 4)
  for (let y = 0; y < down * factor; y++) {
    for (let x = 0; x < width; x++) {
      const bx = Math.floor(x / factor)
      const by = Math.floor(y / factor)
      const middle = x % factor === Math.floor(factor / 2) && y % factor === Math.floor(factor / 2)
      const v = middle && mark !== undefined ? mark : grey(bx, by)
      out.set([v, v, v, 255], (y * width + x) * 4)
    }
  }
  return out
}

const rgbRow = (...greys: number[]) => new Uint8Array(greys.flatMap(v => [v, v, v]))

describe('the crop window', () => {
  test('Claude standing reaches art row 14 at most and stands on the row above the ground line', () => {
    expect(heroRows('walk')).toEqual({ top: 14, bottom: GROUND_ROW - 1 })
    expect(heroRows('celebrate').top).toBe(10)
    expect(heroRows('think', 'jump').top).toBeLessThan(heroRows('think').top)
    expect(heroRows('fly')).toEqual({ top: 6, bottom: 17 })
  })

  test('an 8-row band (16 px) holds the ground line and Claude standing', () => {
    const top = cropTop(16, heroRows('walk'))
    expect(top).toBe(13)
    expect(top).toBeLessThanOrEqual(heroRows('walk').top)
    expect(top + 16).toBeGreaterThan(GROUND_ROW)
  })

  test('a full-height band starts at the stage top; a taller one starts above it, centred', () => {
    expect(cropTop(ART_ROWS, heroRows('walk'))).toBe(0)
    expect(cropTop(40, heroRows('walk'))).toBe(-4)
  })

  test('when ground and Claude do not both fit, Claude whole wins; when he does not fit, the window sits on the ground', () => {
    expect(cropTop(16, heroRows('fly'))).toBe(6)
    expect(cropTop(16, heroRows('celebrate'))).toBe(10)
    expect(cropTop(8, heroRows('walk'))).toBe(GROUND_ROW + 2 - 8)
  })

  test('every window stays on the stage, for every action and band height', () => {
    const actions: FablesHeroAction[] = ['walk', 'run', 'fly', 'dig', 'inspect', 'celebrate', 'think', 'jump', 'dance']
    for (const action of actions) {
      for (let pixelRows = 2; pixelRows < ART_ROWS; pixelRows += 2) {
        const top = cropTop(pixelRows, heroRows(action))
        expect(top).toBeGreaterThanOrEqual(0)
        expect(top + pixelRows).toBeLessThanOrEqual(ART_ROWS)
      }
    }
  })
})

describe('pointSample', () => {
  test('takes the middle pixel of each block, no averaging', () => {
    // 3×2 blocks of 4 px; every block's middle is 200 among 10s.
    const rgba = blocks(3, 2, 4, () => 10, 200)
    expect([...pointSample(rgba, 12, 8, 4, { x0: 0, y0: 0, columns: 3, rows: 2 })]).toEqual(new Array(18).fill(200))
  })

  test('takes a window of blocks, and repeats the edge past the image', () => {
    const rgba = blocks(3, 2, 4, (x, y) => 10 * (x + 3 * y + 1))
    expect([...pointSample(rgba, 12, 8, 4, { x0: 1, y0: 1, columns: 2, rows: 1 })]).toEqual([50, 50, 50, 60, 60, 60])
    expect([...pointSample(rgba, 12, 8, 4, { x0: 2, y0: 1, columns: 2, rows: 2 })]).toEqual([60, 60, 60, 60, 60, 60, 60, 60, 60, 60, 60, 60])
  })

  test('rowsOf views whole rows, and refuses rows past the image', () => {
    const rgba = blocks(1, 2, 2, (_x, y) => (y ? 9 : 1))
    expect([...rowsOf(rgba, 2, 2, 2)]).toEqual(new Array(16).fill(0).map((_, i) => (i % 4 === 3 ? 255 : 9)))
    expect(() => rowsOf(rgba, 2, 3, 2)).toThrow()
  })
})

describe('plan', () => {
  test('an 8-row band of 220 columns draws the whole stage at one art pixel per terminal pixel and crops it', () => {
    expect(plan(shape(220, 8, 'pixel'))).toEqual({ width: 880, height: 128, factor: 4, x0: 0, y0: 13, cropTop: 13, pixel: true })
  })

  test('a 16-row band shows the whole stage; a 20-row band shows it with sky and ground round it', () => {
    expect(plan(shape(200, 16))).toMatchObject({ width: 800, height: 128, y0: 0, cropTop: 0 })
    expect(plan(shape(200, 20))).toMatchObject({ height: 160, y0: 0, cropTop: -4 })
  })

  test('a band narrower than the narrowest stage shows its middle rather than shrinking it', () => {
    expect(plan(shape(60, 16))).toMatchObject({ width: 320, x0: 10 })
  })

  test('the pixel look, named or by default, is point-sampled; every other look is averaged', () => {
    expect(plan(shape(200, 8)).pixel).toBe(true)
    expect(plan(shape(200, 8, 'pixel')).pixel).toBe(true)
    expect(plan(shape(200, 8, 'original')).pixel).toBe(false)
    expect(plan(shape(200, 8, 'ukiyoe')).pixel).toBe(false)
  })

  test('the SVG declares exactly the canvas it is drawn on, a stage U units to the art pixel, without its speech', () => {
    for (const s of [shape(220, 8, 'pixel'), shape(200, 20, 'pixel'), shape(60, 16, 'original')]) {
      const at = plan(s)
      const { svg } = terminalSvg(s, at)
      const root = svg.slice(0, svg.indexOf('>') + 1)
      expect(root).toContain(` width="${at.width}"`)
      expect(root).toContain(` height="${at.height}"`)
      expect(root).toContain(`viewBox="0 0 ${Math.max(s.columns, 80) * 4} 128"`)
      expect(svg).toContain('[data-part="speech"]{display:none}')
    }
  })

  test('toPixels point-samples the pixel look in the window and averages the others', () => {
    const at = { width: 12, height: 8, factor: 4, x0: 1, y0: 0, cropTop: 0, pixel: true }
    const rgba = blocks(3, 2, 4, () => 10, 200)
    // One terminal row is two pixel rows: columns 1 and 2 of both block rows, each its middle pixel.
    expect([...toPixels(rgba, at, 2, 1)]).toEqual(new Array(12).fill(200))
    const averaged = toPixels(rgba, { ...at, y0: 0, x0: 0, pixel: false }, 3, 1)
    expect(averaged.length).toBe(18)
    expect(averaged.every(v => v > 10 && v < 200)).toBe(true)
  })
})

describe('metrics', () => {
  test('unbase64 undoes base64 at every padding, and refuses what is not base64', () => {
    for (const bytes of [[], [0x66], [0x66, 0x6f], [0x66, 0x6f, 0x6f], [0xfb, 0xff, 0xbf, 0x00]]) {
      expect([...(unbase64(base64(new Uint8Array(bytes))) ?? [-1])]).toEqual(bytes)
    }
    expect(unbase64('abc')).toBe(undefined)
    expect(unbase64('ab!=')).toBe(undefined)
  })

  test('unpackHalfBlocks undoes packHalfBlocks and refuses the wrong size', () => {
    const rgb = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
    expect([...(unpackHalfBlocks(packHalfBlocks(rgb, 2, 1), 2, 1) ?? [])]).toEqual([...rgb])
    expect(unpackHalfBlocks(packHalfBlocks(rgb, 2, 1), 1, 1)).toBe(undefined)
  })

  test('brightness and gradient energy', () => {
    expect(brightness(rgbRow(0, 100, 200))).toEqual({ mean: 100, max: 200 })
    expect(gradientEnergy(rgbRow(0, 100, 100), 3)).toBe(50)
  })

  test('a one-step edge is crisp; a two-step ramp is smeared', () => {
    expect(crispEdges(rgbRow(0, 0, 200, 200), 4)).toBe(1)
    expect(crispEdges(rgbRow(0, 100, 200), 3)).toBe(0)
    expect(crispEdges(rgbRow(50, 50, 50), 3)).toBe(1)
  })

  test('inBetween counts the pairs whose colour sits inside a step', () => {
    expect(inBetween(rgbRow(0, 0, 200, 200), 4)).toBe(0)
    expect(inBetween(rgbRow(0, 100, 200), 3)).toBe(0.5)
  })

  test('rowsWithColour finds a colour within the tolerance', () => {
    const rgb = new Uint8Array([0, 0, 0, 0, 0, 0, 0xd0, 0x70, 0x50, 0, 0, 0])
    expect(rowsWithColour(rgb, 2, 0xd97757, 24)).toEqual({ top: 1, bottom: 1, count: 1 })
  })
})

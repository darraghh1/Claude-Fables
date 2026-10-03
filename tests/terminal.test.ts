import { describe, expect, mock, test } from 'claude-code/testing'
import type { MockClock } from 'claude-code/testing'
import type { ModelCompleteResult, On, RenderPropsOf } from 'claude-code'

import type { FablesScene } from '../types'

import { LINGER_MS } from '../hooks/director'
import { DEFAULT_LOOK, LOOK_NAMES } from '../hooks/looks'
import { TYPE_SECONDS_PER_CHAR } from '../hooks/scene'
import { H, MAX_SVG, resumeAt, sceneToSvg } from '../hooks/svg'
import { blend, compose, DARK, decode, rowText, wrap } from '../hooks/terminal/compose'
import { loopStart, MIN_LOOP_SECONDS, played, WRAP_FADE_SECONDS, wrapBlend } from '../hooks/terminal/loop'
import { FPS, glyphsFor, parseGlyphs } from '../hooks/terminal/player'
import { readMs } from '../hooks/narrator'
import { ENTRANCE_SECONDS } from '../hooks/scene'
import { base64, HALF_BLOCK, QUADRANT_GLYPHS } from '../renderer/cells'

const SCENE: FablesScene = {
  backdrop: 'forest',
  palette: {},
  hero: { action: 'walk', from: 5, to: 35 },
  props: [],
  caption: 'And here we see the rare bug in its natural habitat. Quiet now, it is feeding.',
  title: 'field notes',
}
const OTHER: FablesScene = { ...SCENE, backdrop: 'city', caption: 'Pulled over: a color regex that accepts #zzzzzz.', title: undefined }

/** The AbovePrompt props a terminal raises, at a body width and a band height. */
function band(bodyColumns: number, maxRows: number): RenderPropsOf['AbovePrompt'] {
  return {
    hasSurvey: false,
    isWorking: true,
    maxRows,
    bodyColumns,
    scroll: { offset: 0, bodyRows: maxRows - 1 },
    view: {},
  }
}

/** One frame of solid colour, `columns × rows` half-block cells. */
function solid(columns: number, rows: number, rgb: number): string {
  const words = new Uint32Array(columns * rows * 3)
  for (let i = 0; i < words.length; i += 3) words.set([0x2580, rgb, rgb], i)
  return base64(new Uint8Array(words.buffer))
}

type Helper = (n: number, columns: number, rows: number, job: Record<string, unknown>) => AsyncGenerator<{ stream: 'stdout' | 'stderr'; text: string }, void>

/**
 * The world under the mod: a clock, a store, the band's state, a helper
 * standing in for renderer/frames.ts, and a record of what reached the host.
 */
function world(on: On, helper?: (clock: MockClock) => Helper, blitDeny?: string, start: { state?: Record<string, unknown>; store?: Record<string, unknown> } = {}) {
  const clock = mock.clock(on, { now: 1_000_000 })
  // The mod's own store, in memory, kept here so a test can read what the mod stored.
  const store: Record<string, unknown> = { ...start.store }
  on('store.get', async (_$, e) => ({ value: store[e.key] }))
  on('store.set', async (_$, e) => {
    store[e.key] = e.value
    return { value: undefined }
  })
  on('store.delete', async (_$, e) => {
    delete store[e.key]
    return { value: undefined }
  })
  on('store.keys', async () => ({ value: Object.keys(store) }))
  // The engine's own band, which the mod passes to until it has a picture.
  on('ui.render', ($, e) => $.ui.resolve(e).Text({ children: 'engine band' }))
  const state: Record<string, unknown> = { scene: SCENE, enabled: true, style: DEFAULT_LOOK, ...start.state }
  const events: string[] = []
  const blits: string[] = []
  /** When each blit landed, by the mock clock. */
  const blitAt: number[] = []
  const logs: { text: string; to: unknown }[] = []
  const jobs: Record<string, unknown>[] = []
  let versions = 1
  on('state.get', async (_$, e) => ({ value: { value: state[String(e.key)], version: versions } }))
  on('state.set', async (_$, e) => {
    state[String(e.key)] = e.value
    return { value: { isSet: true, version: ++versions } }
  })
  on('ui.blit', async (_$, e) => {
    if ('cells' in e) {
      blits.push(e.cells)
      blitAt.push(clock.now())
    }
    return { value: blitDeny === undefined ? {} : { deny: blitDeny } }
  })
  on('ui.log', async (_$, e) => {
    logs.push({ text: e.text, to: e.to })
    return { value: undefined }
  })
  const run = helper?.(clock)
  on('process.spawn', async function* (_$, e) {
    const n = jobs.length + 1
    const job: unknown = JSON.parse(e.input ?? '{}')
    jobs.push(typeof job === 'object' && job !== null ? { ...job, argv: e.argv, env: e.env } : {})
    events.push(`start ${n}`)
    try {
      const columns = Number(jobs[n - 1]?.columns)
      const rows = Number(jobs[n - 1]?.rows)
      if (run) yield* run(n, columns, rows, jobs[n - 1] ?? {})
    } finally {
      events.push(`end ${n}`)
    }
    return { value: { code: 0, signal: null } }
  })
  return { clock, state, store, events, blits, blitAt, logs, jobs }
}

/** A helper that is ready at once and draws a frame every twelfth of a second until it is stopped. */
const live =
  (speaksAfter = 1.2): ((clock: MockClock) => Helper) =>
  clock =>
    async function* (n, columns, rows) {
      yield { stream: 'stdout', text: `{"ready":true,"columns":${columns},"rows":${rows},` }
      yield { stream: 'stdout', text: `"speaksAfter":${speaksAfter}}\n` }
      for (let i = 0; i < 10_000; i++) {
        await clock.sleep(1000 / 12)
        yield { stream: 'stdout', text: `${JSON.stringify({ i, t: i / 12, cells: solid(columns, rows, (n * 0x101010 + i) & 0xffffff) })}\n` }
      }
    }

/** A helper that draws the frames its job asks for, one every twelfth of a second, and ends, as renderer/frames.ts does. */
const finite =
  (speaksAfter = 1.2): ((clock: MockClock) => Helper) =>
  clock =>
    async function* (_n, columns, rows, job) {
      yield { stream: 'stdout', text: `{"ready":true,"columns":${columns},"rows":${rows},"speaksAfter":${speaksAfter}}\n` }
      const count = Math.round(Number(job.fps) * Number(job.seconds))
      for (let i = 0; i < count; i++) {
        await clock.sleep(1000 / 12)
        yield { stream: 'stdout', text: `${JSON.stringify({ i, t: i / 12, cells: solid(columns, rows, (0x203040 + i * 0x010101) & 0xffffff) })}\n` }
      }
    }

const USAGE = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }

/** The engine's side of a session beneath the mod: it starts, registers the command, takes prompts, ends turns, and the model answers SCENE. */
function session(on: On): { asked: () => number } {
  let asked = 0
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('turn.complete', () => ({ text: 'done' }))
  on('model.complete', (): { value: ModelCompleteResult } => {
    asked++
    return { value: { isAnswered: true, text: JSON.stringify(SCENE), usage: USAGE } }
  })
  return { asked: () => asked }
}

/** The text inside the bubble's sides, row by row, of composed cells. */
function bubbleText(cells: string, columns: number, rows: number): string[] {
  const out: string[] = []
  for (let r = 0; r < rows; r++) {
    const m = /│ (.*) │/.exec(rowText(cells, columns, r))
    if (m) out.push(m[1]!.trimEnd())
  }
  return out
}

describe('the terminal band', () => {
  test('draws one Raster keyed fables, as wide as the body and 8 rows tall by default', async ($, on) => {
    const w = world(on, live())
    const ui = await $.ui.mount({ plugin: 'fables', surface: 'terminal', component: 'AbovePrompt', props: band(200, 30) })
    await w.clock.advance(200)
    await ui.redraw()
    const rasters = await ui.findAll({ type: 'Raster' })
    expect(rasters).toHaveLength(1)
    expect(rasters[0]?.key).toBe('fables')
    expect(rasters[0]?.props).toMatchObject({ columns: 200, rows: 8 })
    await w.clock.settle()
    expect(w.jobs[0]).toMatchObject({ columns: 200, rows: 8, fps: 12 })
    expect(w.jobs[0]?.argv).toEqual(['bun', expect.stringContaining('/renderer/frames.ts')])
    await $.command.run({ command: 'fables', args: 'off' })
    await ui.unmount()
  })

  test('asks the helper for every look as itself, pixel art included (ISS-001 is fixed in the helper)', async ($, on) => {
    const w = world(on, live())
    expect(DEFAULT_LOOK).toBe('pixel')
    const ui = await $.ui.mount({ plugin: 'fables', surface: 'terminal', component: 'AbovePrompt', props: band(200, 30) })
    await w.clock.settle()
    expect(w.jobs[0]?.look).toBe('pixel')
    w.state.style = 'ukiyoe'
    await ui.redraw()
    await w.clock.advance(500)
    expect(w.jobs[1]?.look).toBe('ukiyoe')
    await $.command.run({ command: 'fables', args: 'off' })
    await ui.unmount()
  })

  test('says once in the debug log when a frame is not painted', async ($, on) => {
    const w = world(on, live(), 'another size')
    const ui = await $.ui.mount({ plugin: 'fables', surface: 'terminal', component: 'AbovePrompt', props: band(200, 30) })
    await w.clock.advance(1000)
    const denied = w.logs.filter(l => l.to === 'debug' && l.text.includes('not painted'))
    expect(denied).toHaveLength(1)
    expect(denied[0]?.text).toContain('another size')
    await $.command.run({ command: 'fables', args: 'off' })
    await ui.unmount()
  })

  test('takes 8 rows whenever the band has room for 9, and one row less than the band has when it is short', async ($, on) => {
    const w = world(on, live())
    for (const [maxRows, rows] of [[9, 8], [10, 8], [40, 8], [8, 7], [5, 4]] as const) {
      const ui = await $.ui.mount({ plugin: 'fables', surface: 'terminal', component: 'AbovePrompt', props: band(200, maxRows) })
      await w.clock.advance(200)
      await ui.redraw()
      expect((await ui.find({ type: 'Raster', key: 'fables' }))?.props).toMatchObject({ columns: 200, rows })
      await ui.unmount()
    }
    await $.command.run({ command: 'fables', args: 'off' })
  })

  test('takes the config menu\'s terminalRows, and passes its chromiumPath to the helper', { options: { terminalRows: 12, chromiumPath: '/opt/chrome' } }, async ($, on) => {
    const w = world(on, live())
    const ui = await $.ui.mount({ plugin: 'fables', surface: 'terminal', component: 'AbovePrompt', props: band(200, 30) })
    await w.clock.advance(200)
    await ui.redraw()
    expect((await ui.find({ type: 'Raster', key: 'fables' }))?.props).toMatchObject({ rows: 12 })
    await w.clock.settle()
    expect(w.jobs[0]?.env).toEqual({ CHROMIUM: '/opt/chrome' })
    await $.command.run({ command: 'fables', args: 'off' })
    await ui.unmount()
  })

  test('with terminalGlyphs auto, asks the helper for quadrants for ukiyoe and half blocks for pixel art', async ($, on) => {
    const w = world(on, live())
    const ui = await $.ui.mount({ plugin: 'fables', surface: 'terminal', component: 'AbovePrompt', props: band(200, 30) })
    await w.clock.settle()
    expect(w.jobs[0]).toMatchObject({ look: 'pixel', glyphs: 'half' })
    w.state.style = 'ukiyoe'
    await ui.redraw()
    await w.clock.advance(500)
    expect(w.jobs[1]).toMatchObject({ look: 'ukiyoe', glyphs: 'quadrant' })
    expect(parseGlyphs(undefined)).toBe('auto')
    expect(parseGlyphs('sextant')).toBe('auto')
    for (const look of LOOK_NAMES) expect(glyphsFor(look, 'auto')).toBe(look === 'pixel' ? 'half' : 'quadrant')
    expect(glyphsFor('pixel', 'quadrant')).toBe('half')
    await $.command.run({ command: 'fables', args: 'off' })
    await ui.unmount()
  })

  test('with terminalGlyphs half, asks the helper for half blocks for every look', { options: { terminalGlyphs: 'half' } }, async ($, on) => {
    const w = world(on, live(), undefined, { state: { style: 'ukiyoe' } })
    const ui = await $.ui.mount({ plugin: 'fables', surface: 'terminal', component: 'AbovePrompt', props: band(200, 30) })
    await w.clock.settle()
    expect(w.jobs[0]).toMatchObject({ look: 'ukiyoe', glyphs: 'half' })
    expect(parseGlyphs('half')).toBe('half')
    for (const look of LOOK_NAMES) expect(glyphsFor(look, 'half')).toBe('half')
    await $.command.run({ command: 'fables', args: 'off' })
    await ui.unmount()
  })

  test('a blend across a change of glyph takes the from-cell whole below 0.5 and the to-cell from 0.5; matching glyphs mix', () => {
    const LL = 0x2596
    const UPPER = 0x2598
    // Cell 0: half block to quadrant. Cell 1: two quadrants inking different corners. Cell 2: space to half block.
    // Cell 3: the same quadrant at both ends. Cell 4: the same half block.
    const from = new Uint32Array([HALF_BLOCK, 0x102030, 0x405060, UPPER, 0xffffff, 0, 0x20, 0x808080, 0x808080, LL, 0x000000, 0xff0000, HALF_BLOCK, 0x204060, 0x000000])
    const to = new Uint32Array([LL, 0xa0b0c0, 0x010203, 0x259a, 0x00ff00, 0x0000ff, HALF_BLOCK, 0x111111, 0xeeeeee, LL, 0xffffff, 0x00ff00, HALF_BLOCK, 0x6080a0, 0x101010])
    const valid = new Set(QUADRANT_GLYPHS)
    const between = (c: number, a: number, b: number) =>
      [16, 8, 0].every(shift => {
        const v = (c >>> shift) & 255
        const lo = Math.min((a >>> shift) & 255, (b >>> shift) & 255)
        const hi = Math.max((a >>> shift) & 255, (b >>> shift) & 255)
        return v >= lo && v <= hi
      })
    for (const a of [0, 0.1, 0.25, 0.49, 0.4999, 0.5, 0.51, 0.75, 0.99, 1]) {
      const out = blend(from, to, a)
      for (let i = 0; i < out.length; i += 3) {
        expect(valid.has(out[i]!)).toBe(true)
        const cell = [...out.subarray(i, i + 3)]
        if (from[i] !== to[i]) {
          expect(cell).toEqual([...(a < 0.5 ? from : to).subarray(i, i + 3)])
        } else {
          expect(cell[0]).toBe(to[i])
          expect(between(cell[1]!, from[i + 1]!, to[i + 1]!)).toBe(true)
          expect(between(cell[2]!, from[i + 2]!, to[i + 2]!)).toBe(true)
        }
      }
    }
    // Matching glyphs really mix: half-way between black and white is mid grey.
    expect(blend(from, to, 0.5)[9 + 1]).toBe(0x808080)
    // The loop's wrap fade blends the same way (loop.ts:played).
    const frames = Array.from({ length: 24 }, (_, i) => (i % 2 ? from : to))
    const wrap = wrapBlend(22, 24, 12, 12)!
    expect(played(frames, 22, 12, 12)).toEqual(blend(frames[22]!, frames[wrap.other]!, wrap.weight))
  })

  test('leaves the desktop band as it was: the Svg the scene draws, and no helper', async ($, on) => {
    const w = world(on, live())
    const ui = await $.ui.mount({ plugin: 'fables', surface: 'desktop', component: 'AbovePrompt', props: band(200, 30) })
    const base = sceneToSvg(SCENE, { width: 200 * 8, height: Math.round(H * 1.5), look: DEFAULT_LOOK, figure: '3d' })
    const resumed = resumeAt(base, 0)
    const svg = await ui.find({ type: 'Svg' })
    expect(svg?.props).toMatchObject({
      source: resumed.length <= MAX_SVG ? resumed : base,
      alt: SCENE.caption,
      width: 1600,
      height: Math.round(H * 1.5),
    })
    expect(await ui.findAll({ type: 'Raster' })).toHaveLength(0)
    await w.clock.settle()
    expect(w.jobs).toHaveLength(0)
    await ui.unmount()
  })

  test('types the caption into the bubble only once Claude speaks, all of it, in order', async ($, on) => {
    const w = world(on, live(1.2))
    const ui = await $.ui.mount({ plugin: 'fables', surface: 'terminal', component: 'AbovePrompt', props: band(200, 30) })
    await w.clock.advance(1100)
    const early = w.blits.at(-1)
    expect(early).toBeDefined()
    const blank = bubbleText(early ?? '', 200, 8)
    expect(blank).toHaveLength(wrap(SCENE.caption).length)
    expect(blank.every(line => line.trim() === '')).toBe(true)
    await w.clock.advance(400 + Math.ceil(SCENE.caption.length * TYPE_SECONDS_PER_CHAR * 1000))
    const typed = bubbleText(w.blits.at(-1) ?? '', 200, 8)
    expect(typed).toEqual(wrap(SCENE.caption))
    expect(typed.join(' ')).toBe(SCENE.caption)
    expect(rowText(w.blits.at(-1) ?? '', 200, 0)).toContain(' field notes ')
    await $.command.run({ command: 'fables', args: 'off' })
    await ui.unmount()
  })

  test('a new scene ends the running helper before the next starts, and /fables off ends it (M-05)', async ($, on) => {
    const w = world(on, live())
    const ui = await $.ui.mount({ plugin: 'fables', surface: 'terminal', component: 'AbovePrompt', props: band(200, 30) })
    await w.clock.advance(500)
    expect(w.events).toEqual(['start 1'])
    w.state.scene = OTHER
    await ui.redraw()
    await w.clock.advance(500)
    expect(w.events).toEqual(['start 1', 'end 1', 'start 2'])
    await $.command.run({ command: 'fables', args: 'off' })
    await w.clock.advance(1000)
    expect(w.events).toEqual(['start 1', 'end 1', 'start 2', 'end 2'])
    expect(w.jobs).toHaveLength(2)
    await ui.unmount()
  })

  test('two identical frames in a row go up once, in the redraw that puts the Raster up, and are never blitted', async ($, on) => {
    const w = world(on, clock =>
      async function* (_n, columns, rows) {
        yield { stream: 'stdout', text: `{"ready":true,"columns":${columns},"rows":${rows},"speaksAfter":100}\n` }
        await clock.sleep(40)
        const same = solid(columns, rows, 0x336699)
        yield { stream: 'stdout', text: `${JSON.stringify({ i: 0, t: 0, cells: same })}\n${JSON.stringify({ i: 1, t: 1 / 12, cells: same })}\n` }
        await clock.sleep(5000)
      },
    )
    const ui = await $.ui.mount({ plugin: 'fables', surface: 'terminal', component: 'AbovePrompt', props: band(120, 30) })
    await w.clock.advance(250)
    await ui.redraw()
    expect(await ui.find({ type: 'Raster', key: 'fables' })).toBeDefined()
    expect(w.blits).toHaveLength(0)
    await $.command.run({ command: 'fables', args: 'off' })
    await ui.unmount()
  })

  test('falls back to the caption as text, and says why once in the debug log, when the helper cannot start (M-07)', async ($, on) => {
    const w = world(on, () =>
      // A spawn the host cannot start: its first pull rejects.
      async function* () {
        throw new Error('bun: not found')
      },
    )
    const ui = await $.ui.mount({ plugin: 'fables', surface: 'terminal', component: 'AbovePrompt', props: band(200, 30) })
    await w.clock.advance(200)
    expect(await ui.findAll({ type: 'Raster' })).toHaveLength(0)
    expect((await ui.find({ type: 'Box', key: 'fables' }))?.type).toBe('Box')
    expect(await ui.find({ type: 'Text', text: SCENE.caption })).toBeDefined()
    await w.clock.advance(6000)
    const debug = w.logs.filter(l => l.to === 'debug')
    expect(debug).toHaveLength(1)
    expect(debug[0]?.text).toContain('could not run')
    await ui.unmount()
  })

  test('falls back to text on the helper\'s error line, and when no frame comes within 5 s', async ($, on) => {
    const w = world(on, clock =>
      async function* (n) {
        if (n === 1) yield { stream: 'stderr', text: '{"error":"no browser"}\n' }
        // Chromium chatters on stderr while it hangs: a live child with no frame.
        else for (;;) yield (await clock.sleep(250), { stream: 'stderr' as const, text: 'warning: still starting\n' })
      },
    )
    const ui = await $.ui.mount({ plugin: 'fables', surface: 'terminal', component: 'AbovePrompt', props: band(200, 30) })
    await w.clock.advance(200)
    expect(await ui.find({ type: 'Text', text: SCENE.caption })).toBeDefined()
    expect(w.logs.filter(l => l.to === 'debug')[0]?.text).toContain('no browser')
    w.state.scene = OTHER
    await ui.redraw()
    await w.clock.advance(1000)
    // No picture has landed in this session: the engine's own band, not a dark one.
    expect(await ui.findAll({ type: 'Raster' })).toHaveLength(0)
    expect(await ui.find({ type: 'Text', text: 'engine band' })).toBeDefined()
    await w.clock.advance(4500)
    expect(await ui.find({ type: 'Text', text: OTHER.caption })).toBeDefined()
    expect(w.events).toContain('end 2')
    expect(w.logs.filter(l => l.to === 'debug')).toHaveLength(1)
    await ui.unmount()
  })

  test('keeps the last scene up and looping after the turn ends, with no helper and no model call, while the desktop band clears', async ($, on) => {
    const w = world(on, finite(), undefined, { state: { scene: null } })
    const engine = session(on)
    await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
    await $.prompt.submit({ text: 'look for bugs', wait: false, origin: { kind: 'composer' } })
    await w.clock.advance(1000)
    expect(w.state.scene).toMatchObject({ caption: SCENE.caption })
    expect(w.store.lastScene).toMatchObject({ caption: SCENE.caption })
    const ui = await $.ui.mount({ plugin: 'fables', surface: 'terminal', component: 'AbovePrompt', props: band(200, 30) })
    await $.turn.complete({ answer: 'done', durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer' })
    const askedAtEnd = engine.asked()
    expect(askedAtEnd).toBe(1)

    await w.clock.advance(LINGER_MS + 5000)
    // The Director has cleared the scene the desktop draws ...
    expect(w.state.scene).toBeNull()
    const desktop = await $.ui.mount({ plugin: 'fables', surface: 'desktop', component: 'AbovePrompt', props: band(200, 30) })
    expect(await desktop.findAll({ type: 'Svg' })).toHaveLength(0)
    await desktop.unmount()
    // ... the terminal band still draws it, from the one helper that has drawn it and ended ...
    await ui.redraw()
    expect((await ui.find({ type: 'Raster', key: 'fables' }))?.props).toMatchObject({ columns: 200, rows: 8 })
    expect(w.events).toEqual(['start 1', 'end 1'])
    // ... and it keeps moving, on the clock alone: no helper open, no model asked.
    const from = w.blits.length
    await w.clock.advance(3000)
    const idle = w.blits.slice(from)
    expect(idle.length).toBeGreaterThan(12)
    // The synthetic frames ramp one way: the shortest loop, 1 s, whose last 0.5 s fades back toward its
    // start (the wrap fade), so some pictures come round twice in a lap; it still moves throughout.
    expect(new Set(idle).size).toBeGreaterThan(5)
    expect(w.events).toEqual(['start 1', 'end 1'])
    expect(w.jobs).toHaveLength(1)
    expect(engine.asked()).toBe(askedAtEnd)

    // /fables off clears the band and stops the loop.
    await $.command.run({ command: 'fables', args: 'off' })
    await ui.redraw()
    expect(await ui.findAll({ type: 'Raster' })).toHaveLength(0)
    const after = w.blits.length
    await w.clock.advance(2000)
    expect(w.blits).toHaveLength(after)
    expect(w.store).not.toHaveProperty('lastScene')
    await ui.unmount()
  })

  test('a new session draws the stored last scene before any prompt, with one helper', async ($, on) => {
    const w = world(on, finite(), undefined, { state: { scene: null }, store: { lastScene: SCENE } })
    const engine = session(on)
    await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
    const ui = await $.ui.mount({ plugin: 'fables', surface: 'terminal', component: 'AbovePrompt', props: band(200, 30) })
    await w.clock.advance(1000)
    await ui.redraw()
    expect(await ui.find({ type: 'Raster', key: 'fables' })).toBeDefined()
    expect(w.jobs).toHaveLength(1)
    expect(w.jobs[0]).toMatchObject({ scene: { caption: SCENE.caption }, columns: 200, rows: 8, look: 'pixel' })
    expect(w.blits.length).toBeGreaterThan(0)
    expect(engine.asked()).toBe(0)
    // Long after, it is still up and looping from what the one helper drew.
    await w.clock.advance(LINGER_MS + 5000)
    await ui.redraw()
    expect(await ui.find({ type: 'Raster', key: 'fables' })).toBeDefined()
    expect(w.events).toEqual(['start 1', 'end 1'])
    await $.command.run({ command: 'fables', args: 'off' })
    await ui.unmount()
  })

  test('a desktop session leaves the stored scene off the desktop band', async ($, on) => {
    const w = world(on, finite(), undefined, { state: { scene: null }, store: { lastScene: SCENE } })
    session(on)
    await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
    const desktop = await $.ui.mount({ plugin: 'fables', surface: 'desktop', component: 'AbovePrompt', props: band(200, 30) })
    expect(await desktop.findAll({ type: 'Svg' })).toHaveLength(0)
    await w.clock.settle()
    expect(w.jobs).toHaveLength(0)
    await desktop.unmount()
  })

  test('composes a dark band with an empty bubble before any frame lands', () => {
    const cells = compose(undefined, 80, 12, { scene: SCENE, t: 0, speaksAfter: undefined })
    expect(bubbleText(cells, 80, 12).every(line => line.trim() === '')).toBe(true)
  })

  test('holds the last scene, art and caption, until the next scene\'s first frame lands, then swaps both, and never draws the dark band', async ($, on) => {
    const firstAt: Record<number, number> = {}
    const w = world(on, clock => async function* (n, columns, rows, job) {
      yield { stream: 'stdout', text: `{"ready":true,"columns":${columns},"rows":${rows},"speaksAfter":0.2}\n` }
      if (n === 2) await clock.sleep(1500)
      const count = Math.round(Number(job.fps) * Number(job.seconds))
      for (let i = 0; i < count; i++) {
        await clock.sleep(1000 / 12)
        if (i === 0) firstAt[n] = clock.now()
        yield { stream: 'stdout', text: `${JSON.stringify({ i, t: i / 12, cells: solid(columns, rows, n === 1 ? 0x204000 + i : 0x60a000 + i) })}\n` }
      }
    })
    const ui = await $.ui.mount({ plugin: 'fables', surface: 'terminal', component: 'AbovePrompt', props: band(200, 30) })
    await w.clock.advance(3000)
    const startedAt = w.clock.now()
    w.state.scene = OTHER
    await ui.redraw()
    await w.clock.advance(3000)
    const lands = firstAt[2]!
    expect(lands - startedAt).toBeGreaterThanOrEqual(1500)
    /** The art's colour in the band's bottom-right cell, clear of the bubble and the title. */
    const art = (cells: string) => decode(cells)![(8 * 200 - 1) * 3 + 1]! >>> 8
    const held = w.blits.filter((_, k) => w.blitAt[k]! >= startedAt && w.blitAt[k]! < lands)
    expect(held.length).toBeGreaterThan(6)
    for (const cells of held) {
      expect(art(cells)).toBe(0x2040)
      expect(rowText(cells, 200, 0)).toContain(' field notes ')
      expect(bubbleText(cells, 200, 8)).toHaveLength(wrap(SCENE.caption).length)
    }
    const k = w.blitAt.findIndex(at => at >= lands)
    const swapped = w.blits[k]!
    expect(art(swapped)).toBe(0x60a0)
    expect(rowText(swapped, 200, 0)).not.toContain(' field notes ')
    expect(bubbleText(swapped, 200, 8)).toHaveLength(wrap(OTHER.caption).length)
    for (const cells of w.blits) expect(decode(cells)!.some((word, i) => i % 3 !== 0 && word === DARK)).toBe(false)
    await $.command.run({ command: 'fables', args: 'off' })
    await ui.unmount()
  })

  test('at session start with a stored scene, passes to the engine\'s band until the first frame lands, then draws the Raster', async ($, on) => {
    const w = world(
      on,
      clock => async function* (_n, columns, rows) {
        yield { stream: 'stdout', text: `{"ready":true,"columns":${columns},"rows":${rows},"speaksAfter":1}\n` }
        await clock.sleep(2500)
        yield { stream: 'stdout', text: `${JSON.stringify({ i: 0, t: 0, cells: solid(columns, rows, 0x336699) })}\n` }
        await clock.sleep(60_000)
      },
      undefined,
      { state: { scene: null }, store: { lastScene: SCENE } },
    )
    session(on)
    await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
    const ui = await $.ui.mount({ plugin: 'fables', surface: 'terminal', component: 'AbovePrompt', props: band(200, 30) })
    await w.clock.advance(2000)
    await ui.redraw()
    expect(w.jobs).toHaveLength(1)
    expect(await ui.findAll({ type: 'Raster' })).toHaveLength(0)
    expect(await ui.find({ type: 'Text', text: 'engine band' })).toBeDefined()
    expect(w.blits).toHaveLength(0)
    await w.clock.advance(1000)
    await ui.redraw()
    const raster = await ui.find({ type: 'Raster', key: 'fables' })
    expect(raster?.props).toMatchObject({ columns: 200, rows: 8 })
    await $.command.run({ command: 'fables', args: 'off' })
    await ui.unmount()
  })

  test('cross-fades from the last picture on a backdrop change, and asks the helper for the scene without its entrance', async ($, on) => {
    const firstAt: Record<number, number> = {}
    const FROM = 0x204060
    const TO = 0xa0c0e0
    const w = world(on, clock => async function* (n, columns, rows, job) {
      yield { stream: 'stdout', text: `{"ready":true,"columns":${columns},"rows":${rows},"speaksAfter":0.2}\n` }
      if (n === 2) await clock.sleep(1500)
      const count = Math.round(Number(job.fps) * Number(job.seconds))
      for (let i = 0; i < count; i++) {
        await clock.sleep(1000 / 12)
        if (i === 0) firstAt[n] = clock.now()
        yield { stream: 'stdout', text: `${JSON.stringify({ i, t: i / 12, cells: solid(columns, rows, n === 1 ? FROM : TO) })}\n` }
      }
    })
    const ui = await $.ui.mount({ plugin: 'fables', surface: 'terminal', component: 'AbovePrompt', props: band(200, 30) })
    await w.clock.advance(3000)
    w.state.scene = { ...OTHER, enter: 'fade' }
    await ui.redraw()
    await w.clock.advance(1590)
    const lands = firstAt[2]!
    expect(lands).toBeDefined()
    const art = (cells: string) => decode(cells)![(8 * 200 - 1) * 3 + 1]!
    const between = (c: number) => [16, 8, 0].every(sh => ((c >>> sh) & 0xff) > ((FROM >>> sh) & 0xff) && ((c >>> sh) & 0xff) < ((TO >>> sh) & 0xff))
    // The midpoint, drawn at exactly half the entrance after the first frame went up.
    await w.clock.set(lands + (ENTRANCE_SECONDS * 1000) / 2)
    await ui.redraw()
    const mid = (await ui.find({ type: 'Raster', key: 'fables' }))?.props
    const midCells = typeof mid?.cells === 'string' ? mid.cells : ''
    expect(between(art(midCells))).toBe(true)
    const half = art(midCells)
    for (const sh of [16, 8, 0]) expect(Math.abs(((half >>> sh) & 0xff) - (((FROM >>> sh) & 0xff) + ((TO >>> sh) & 0xff)) / 2)).toBeLessThanOrEqual(2)
    await w.clock.advance(2000)
    const fading = w.blits.filter((_, k) => w.blitAt[k]! > lands + 50 && w.blitAt[k]! < lands + ENTRANCE_SECONDS * 1000 - 50)
    expect(fading.length).toBeGreaterThan(3)
    for (const cells of fading) expect(between(art(cells))).toBe(true)
    const after = w.blits.filter((_, k) => w.blitAt[k]! > lands + ENTRANCE_SECONDS * 1000 + 100)
    expect(after.length).toBeGreaterThan(0)
    for (const cells of after) expect(art(cells)).toBe(TO)
    expect(w.jobs[1]?.scene).toMatchObject({ backdrop: 'city', caption: OTHER.caption })
    expect(w.jobs[1]?.scene).not.toHaveProperty('enter')
    await $.command.run({ command: 'fables', args: 'off' })
    await ui.unmount()
  })

  test('loops from the frame after the one least different from the last, fades toward the frames before it over the last 0.5 s, and never loops less than 1 s', async ($, on) => {
    const count = FPS * Math.max(1, Math.ceil(readMs(SCENE) / 1000))
    const k = count - 30
    const colour = (i: number) => (i === k ? 0x0f0000 + (count - 1) : 0x0f0000 + i) * 0x100
    const firstAt: number[] = []
    const w = world(on, clock => async function* (_n, columns, rows) {
      yield { stream: 'stdout', text: `{"ready":true,"columns":${columns},"rows":${rows},"speaksAfter":0.2}\n` }
      for (let i = 0; i < count; i++) {
        await clock.sleep(1000 / 12)
        if (i === 0) firstAt.push(clock.now())
        yield { stream: 'stdout', text: `${JSON.stringify({ i, t: i / 12, cells: solid(columns, rows, colour(i) & 0xffffff) })}\n` }
      }
    })
    const ui = await $.ui.mount({ plugin: 'fables', surface: 'terminal', component: 'AbovePrompt', props: band(200, 30) })
    await w.clock.advance(count * 100 + 1000)
    const art = async (frame: number) => {
      await w.clock.set(firstAt[0]! + ((frame + 0.5) * 1000) / FPS)
      await ui.redraw()
      const props = (await ui.find({ type: 'Raster', key: 'fables' }))?.props
      return decode(typeof props?.cells === 'string' ? props.cells : '')![(8 * 200 - 1) * 3 + 1]!
    }
    const loop = count - k - 1
    // Inside the wrap fade, the band plays the frame blended toward the one a loop before it (lead ruling, WO-004).
    const span = Math.round(WRAP_FADE_SECONDS * FPS)
    const j = count - 3
    const weight = (j - (count - span) + 1) / span
    const green = (await art(count + 3 * loop - 3)) >>> 8
    expect(green).toBe(Math.round(j - loop * weight))
    // The last frame, then the wrap: the frame after k, not the 2 s-back frame the old loop took. The final
    // frame plays as frame k, the one before the loop start, which here equals the final frame drawn.
    expect(await art(count + 3 * loop - 1)).toBe(colour(count - 1) & 0xffffff)
    expect(await art(count + 3 * loop)).toBe(colour(k + 1) & 0xffffff)
    // Pure: the loop starts right after k; a match inside the last second is not taken.
    const frame = (c: number) => new Uint32Array([0x2580, c, c])
    const synthetic = Array.from({ length: 60 }, (_, i) => frame(i * 3))
    synthetic[40] = frame(59 * 3)
    expect(loopStart(synthetic, 12)).toBe(41)
    synthetic[55] = frame(59 * 3)
    expect(loopStart(synthetic, 12)).toBe(41)
    expect(60 - loopStart(synthetic, 12)).toBeGreaterThanOrEqual(MIN_LOOP_SECONDS * 12)
    expect(loopStart(synthetic.slice(0, 8), 12)).toBe(0)
    // The wrap fade: none before the last 0.5 s, half-way through it a blend, and the final frame plays as the one before the start.
    expect(wrapBlend(53, 60, 41, 12)).toBeUndefined()
    expect(wrapBlend(56, 60, 41, 12)).toEqual({ other: 37, weight: 3 / 6 })
    expect(played(synthetic, 59, 41, 12)).toEqual(synthetic[40])
    expect(played(synthetic, 30, 41, 12)).toBe(synthetic[30])
    await $.command.run({ command: 'fables', args: 'off' })
    await ui.unmount()
  })
})

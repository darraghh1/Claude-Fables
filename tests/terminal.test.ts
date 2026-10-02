import { describe, expect, mock, test } from 'claude-code/testing'
import type { MockClock } from 'claude-code/testing'
import type { On, RenderPropsOf } from 'claude-code'

import type { FablesScene } from '../types'

import { DEFAULT_LOOK } from '../hooks/looks'
import { TYPE_SECONDS_PER_CHAR } from '../hooks/scene'
import { H, MAX_SVG, resumeAt, sceneToSvg } from '../hooks/svg'
import { compose, rowText, wrap } from '../hooks/terminal/compose'
import { base64 } from '../renderer/cells'

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

type Helper = (n: number, columns: number, rows: number) => AsyncGenerator<{ stream: 'stdout' | 'stderr'; text: string }, void>

/**
 * The world under the mod: a clock, a store, the band's state, a helper
 * standing in for renderer/frames.ts, and a record of what reached the host.
 */
function world(on: On, helper?: (clock: MockClock) => Helper, blitDeny?: string) {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  const state: Record<string, unknown> = { scene: SCENE, enabled: true, style: DEFAULT_LOOK }
  const events: string[] = []
  const blits: string[] = []
  const logs: { text: string; to: unknown }[] = []
  const jobs: Record<string, unknown>[] = []
  let versions = 1
  on('state.get', async (_$, e) => ({ value: { value: state[String(e.key)], version: versions } }))
  on('state.set', async (_$, e) => {
    state[String(e.key)] = e.value
    return { value: { isSet: true, version: ++versions } }
  })
  on('ui.blit', async (_$, e) => {
    if ('cells' in e) blits.push(e.cells)
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
      if (run) yield* run(n, columns, rows)
    } finally {
      events.push(`end ${n}`)
    }
    return { value: { code: 0, signal: null } }
  })
  return { clock, state, events, blits, logs, jobs }
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
  test('draws one Raster keyed fables, as wide as the body and terminalRows tall', async ($, on) => {
    const w = world(on, live())
    const ui = await $.ui.mount({ plugin: 'fables', surface: 'terminal', component: 'AbovePrompt', props: band(200, 30) })
    const rasters = await ui.findAll({ type: 'Raster' })
    expect(rasters).toHaveLength(1)
    expect(rasters[0]?.key).toBe('fables')
    expect(rasters[0]?.props).toMatchObject({ columns: 200, rows: 16 })
    await w.clock.settle()
    expect(w.jobs[0]).toMatchObject({ columns: 200, rows: 16, fps: 12 })
    expect(w.jobs[0]?.argv).toEqual(['bun', expect.stringContaining('/renderer/frames.ts')])
    await $.command.run({ command: 'fables', args: 'off' })
    await ui.unmount()
  })

  test('asks the helper for the original look when the band is in pixel art (ISS-001), and for any other look as itself', async ($, on) => {
    const w = world(on, live())
    expect(DEFAULT_LOOK).toBe('pixel')
    const ui = await $.ui.mount({ plugin: 'fables', surface: 'terminal', component: 'AbovePrompt', props: band(200, 30) })
    await w.clock.settle()
    expect(w.jobs[0]?.look).toBe('original')
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

  test('takes one row less than the band has when the band is short', async ($, on) => {
    world(on, live())
    const ui = await $.ui.mount({ plugin: 'fables', surface: 'terminal', component: 'AbovePrompt', props: band(200, 10) })
    expect((await ui.find({ type: 'Raster', key: 'fables' }))?.props).toMatchObject({ columns: 200, rows: 9 })
    await $.command.run({ command: 'fables', args: 'off' })
    await ui.unmount()
  })

  test('takes the config menu\'s terminalRows, and passes its chromiumPath to the helper', { options: { terminalRows: 12, chromiumPath: '/opt/chrome' } }, async ($, on) => {
    const w = world(on, live())
    const ui = await $.ui.mount({ plugin: 'fables', surface: 'terminal', component: 'AbovePrompt', props: band(200, 30) })
    expect((await ui.find({ type: 'Raster', key: 'fables' }))?.props).toMatchObject({ rows: 12 })
    await w.clock.settle()
    expect(w.jobs[0]?.env).toEqual({ CHROMIUM: '/opt/chrome' })
    await $.command.run({ command: 'fables', args: 'off' })
    await ui.unmount()
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
    const blank = bubbleText(early ?? '', 200, 16)
    expect(blank).toHaveLength(wrap(SCENE.caption).length)
    expect(blank.every(line => line.trim() === '')).toBe(true)
    await w.clock.advance(400 + Math.ceil(SCENE.caption.length * TYPE_SECONDS_PER_CHAR * 1000))
    const typed = bubbleText(w.blits.at(-1) ?? '', 200, 16)
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

  test('two identical frames in a row repaint the band once', async ($, on) => {
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
    expect(w.blits).toHaveLength(1)
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
    expect(await ui.find({ type: 'Raster', key: 'fables' })).toBeDefined()
    await w.clock.advance(4500)
    expect(await ui.find({ type: 'Text', text: OTHER.caption })).toBeDefined()
    expect(w.events).toContain('end 2')
    expect(w.logs.filter(l => l.to === 'debug')).toHaveLength(1)
    await ui.unmount()
  })

  test('composes a dark band with an empty bubble before any frame lands', () => {
    const cells = compose(undefined, 80, 12, { scene: SCENE, t: 0, speaksAfter: undefined })
    expect(bubbleText(cells, 80, 12).every(line => line.trim() === '')).toBe(true)
  })
})

/**
 * The terminal band's player, one per session: it follows the scene up now,
 * runs the frame helper (renderer/frames.ts) for it at the band's size, keeps
 * the frames it streams, and repaints the band's Raster at 12 frames a second
 * with the caption and title written over them (compose.ts).
 *
 * One helper at a time: a new scene, a new box, `/fables off` and the module
 * unloading each end the running one first (M-05). When the helper cannot run
 * (no bun, no Chromium, an error line, no frame within 5 s) the band falls back
 * to text (M-07), and the reason goes to the debug log once.
 */

import type { HookStream, ProcessSpawnChunk, ProcessSpawnRequest, ProcessSpawnResult, RasterBlitArgs, Timer, UiBlitResult } from 'claude-code'
import type { FablesScene } from '../../types'

import { readMs } from '../narrator'
import { compose } from './compose'

/** Frames a second the helper draws and the band plays. */
export const FPS = 12
/** How long the first frame may take before the band falls back to text. */
export const NO_FRAME_MS = 5000
/** Seconds at the end of the scene that loop once the frames run out. */
export const LOOP_SECONDS = 2
/** How long a new helper waits for the old one's loop to end before it starts anyway. */
const END_WAIT_MS = 2000
/** The Raster's key in the band's tree. */
export const RASTER_KEY = 'fables'

export type PlayerConfig = { chromiumPath: string }

/**
 * What the player reaches the host through, built in register.tsx from the
 * hook's `$` (a hooks module spells every host call `$.noun.event(...)`).
 */
export type PlayerHost = {
  now: () => Promise<number>
  every: (ms: number, fn: () => void) => Timer
  after: (ms: number, fn: () => void) => Timer
  spawn: (request: ProcessSpawnRequest) => HookStream<ProcessSpawnChunk, ProcessSpawnResult>
  blit: (args: RasterBlitArgs) => Promise<UiBlitResult>
  /** One line to the debug log. */
  log: (text: string) => void
  /** Draws the band again. */
  invalidate: () => void
  /** The mod's folder, which holds renderer/frames.ts. */
  root: string
}

/** What the band asks the player for: this scene, in this box and style, drawn at this site. */
export type Want = { scene: FablesScene; columns: number; rows: number; look: string; requestId: string }

type Line = { ready: true; speaksAfter: number } | { i: number; cells: string } | { error: string }

/**
 * The style the helper draws a look in. Pixel art (the default) pixelizes the
 * stage with an SVG filter that Chromium draws as a flat, near-black stage
 * when the frame helper decodes it as an image (ISS-001);
 * the terminal's half blocks are pixels already, so it draws the original
 * look, which pixel art is made from. Every other look draws as itself.
 */
export const terminalLook = (look: string): string => (look === 'pixel' ? 'original' : look)

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/** One NDJSON line from the helper, or undefined for one this player does not read. */
function parseLine(text: string): Line | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isRecord(value)) return undefined
  if (typeof value.error === 'string') return { error: value.error }
  if (value.ready === true && typeof value.speaksAfter === 'number') return { ready: true, speaksAfter: value.speaksAfter }
  if (typeof value.i === 'number' && typeof value.cells === 'string') return { i: value.i, cells: value.cells }
  return undefined
}

export class Player {
  private want?: Want
  private wantKey = ''
  private sceneKey = ''
  private shownAt = 0
  private frames: string[] = []
  private count = 0
  private speaks?: number
  private failure?: string
  private hasLogged = false
  private hasLoggedDeny = false
  private generation = 0
  private stream?: HookStream<ProcessSpawnChunk, ProcessSpawnResult>
  private loopEnded: Promise<void> = Promise.resolve()
  private timers: Timer[] = []
  private lastBlit?: string

  constructor(private readonly config: PlayerConfig) {}

  /** Why the helper could not draw this scene, if it could not: the band draws text then. */
  get failed(): string | undefined {
    return this.failure
  }

  /**
   * Plays `want`: nothing to do when it is what plays already; otherwise the
   * running helper ends, then one starts for the new scene or box. A new scene
   * starts its clock; a new box keeps it, so the scene carries on.
   */
  async follow(host: PlayerHost, want: Want): Promise<void> {
    const sceneKey = JSON.stringify(want.scene)
    const wantKey = `${want.columns}x${want.rows}|${want.look}|${want.requestId}|${sceneKey}`
    if (wantKey === this.wantKey) return
    const now = await host.now()
    const ended = this.end()
    if (sceneKey !== this.sceneKey) {
      this.shownAt = now
      this.failure = undefined
    }
    this.want = want
    this.wantKey = wantKey
    this.sceneKey = sceneKey
    this.frames = []
    this.speaks = undefined
    this.count = FPS * Math.max(1, Math.ceil(readMs(want.scene) / 1000))
    this.lastBlit = undefined
    const generation = this.generation
    this.loopEnded = this.run(host, want, generation, ended)
    this.timers.push(host.every(Math.round(1000 / FPS), () => void this.repaint(host, generation)))
  }

  /** Ends the running helper and the playback; the band is left as it was last drawn. */
  stop(): Promise<void> {
    this.want = undefined
    this.wantKey = ''
    this.sceneKey = ''
    return this.end()
  }

  /** The band's cells at `now`: the frame due (or the newest in), with the title and bubble over it. */
  cellsAt(now: number): string | undefined {
    const want = this.want
    if (!want) return undefined
    const t = (now - this.shownAt) / 1000
    const frame = this.frames.length > 0 ? this.frames[Math.min(this.frameIndex(t), this.frames.length - 1)] : undefined
    return compose(frame, want.columns, want.rows, { scene: want.scene, t, speaksAfter: this.speaks })
  }

  /** The cells drawn into the tree, so the next repaint does not send them again. */
  drawn(cells: string): void {
    this.lastBlit = cells
  }

  /** The frame due `t` seconds in; past the end, the last LOOP_SECONDS play round again. */
  private frameIndex(t: number): number {
    const i = Math.max(0, Math.floor(t * FPS))
    if (i < this.count) return i
    const from = Math.max(0, this.count - LOOP_SECONDS * FPS)
    return from + ((i - from) % Math.max(1, this.count - from))
  }

  private end(): Promise<void> {
    this.generation++
    for (const timer of this.timers.splice(0)) timer.cancel()
    const stream = this.stream
    this.stream = undefined
    if (stream) void stream.return({ code: null, signal: 'SIGTERM' }).catch(() => undefined)
    return this.loopEnded
  }

  private async repaint(host: PlayerHost, generation: number): Promise<void> {
    if (generation !== this.generation || this.failure !== undefined || !this.want) return
    const cells = this.cellsAt(await host.now())
    if (cells === undefined || cells === this.lastBlit || generation !== this.generation) return
    this.lastBlit = cells
    const result = await host.blit({ requestId: this.want.requestId, key: RASTER_KEY, cells }).catch((error: unknown) => ({
      deny: error instanceof Error ? error.message : String(error),
    }))
    if (result.deny !== undefined && !this.hasLoggedDeny) {
      this.hasLoggedDeny = true
      host.log(`fables: a terminal frame was not painted: ${result.deny}`)
    }
  }

  /** Falls back to text for this scene: the helper ends, the reason is logged once, the band is drawn again. */
  private fail(host: PlayerHost, generation: number, reason: string): void {
    if (generation !== this.generation) return
    this.failure = reason
    void this.end()
    if (!this.hasLogged) {
      this.hasLogged = true
      host.log(`fables: the terminal band draws the caption as text: ${reason}`)
    }
    host.invalidate()
  }

  /** Waits for the last helper's loop to end, then runs one for `want` and reads its frames. */
  private async run(host: PlayerHost, want: Want, generation: number, previous: Promise<void>): Promise<void> {
    const waits: Timer[] = []
    const timedOut = new Promise<boolean>(resolve => void waits.push(host.after(END_WAIT_MS, () => resolve(false))))
    const isPreviousEnded = await Promise.race([previous.then(() => true), timedOut])
    for (const wait of waits) wait.cancel()
    if (!isPreviousEnded) host.log('fables: the last frame helper had not ended; starting the next')
    if (generation !== this.generation) return
    const job = { scene: want.scene, columns: want.columns, rows: want.rows, look: terminalLook(want.look), fps: FPS, seconds: this.count / FPS }
    const stream = host.spawn({
      argv: ['bun', `${host.root}/renderer/frames.ts`],
      input: JSON.stringify(job),
      env: { CHROMIUM: this.config.chromiumPath },
    })
    this.stream = stream
    this.timers.push(
      host.after(NO_FRAME_MS, () => {
        if (this.frames.length === 0) this.fail(host, generation, `no frame within ${NO_FRAME_MS / 1000} s`)
      }),
    )
    let out = ''
    let err = ''
    try {
      for await (const chunk of stream) {
        if (generation !== this.generation) break
        if (chunk.stream === 'stderr') {
          err += chunk.text
          const line = parseLine(err.split('\n').find(l => l.includes('"error"')) ?? '')
          if (line && 'error' in line) return this.fail(host, generation, `the frame helper failed: ${line.error}`)
          continue
        }
        out += chunk.text
        let nl: number
        while ((nl = out.indexOf('\n')) >= 0) {
          const line = parseLine(out.slice(0, nl))
          out = out.slice(nl + 1)
          if (!line) continue
          if ('ready' in line) this.speaks = line.speaksAfter
          else if ('cells' in line && line.i === this.frames.length) this.frames.push(line.cells)
        }
      }
      if (generation === this.generation && this.frames.length === 0) this.fail(host, generation, 'the frame helper ended without a frame')
    } catch (error) {
      this.fail(host, generation, `the frame helper could not run: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      if (this.stream === stream) this.stream = undefined
    }
  }
}

/**
 * The terminal band's player, one per session: it follows the scene up now,
 * runs the frame helper (renderer/frames.ts) for it at the band's size, keeps
 * the frames it streams, and repaints the band's Raster at 12 frames a second
 * with the caption and title written over them (compose.ts).
 *
 * Once the helper has drawn the scene and ended, the band keeps playing: its
 * last LOOP_SECONDS loop from the frames kept, on the clock alone, with no
 * helper running, until a new scene, a new box or `/fables off`.
 *
 * One helper at a time: a new scene, a new box, `/fables off` and the module
 * unloading each end the running one first (M-05). When the helper cannot run
 * (no bun, no Chromium, an error line, no frame within 5 s) the band falls back
 * to text (M-07), and the reason goes to the debug log once.
 */

import type { HookStream, ProcessSpawnChunk, ProcessSpawnRequest, ProcessSpawnResult, RasterBlitArgs, Timer, UiBlitResult } from 'claude-code'
import type { FablesScene } from '../../types'

import { readMs } from '../narrator'
import { ENTRANCE_SECONDS } from '../scene'
import { blend, compose, decode, fit } from './compose'
import { loopStart } from './loop'

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

/**
 * One scene in one box, as the player keeps it: the frames its helper sent,
 * when its clock started (the moment its first frame went up), where its idle
 * loop starts once all its frames are in, and the picture it fades in from.
 */
type Clip = {
  scene: FablesScene
  sceneKey: string
  columns: number
  rows: number
  frames: string[]
  /** Frames the helper was asked for. */
  count: number
  speaks?: number
  /** When its first frame went up; undefined until then. */
  shownAt?: number
  /** A clock to carry on with instead of starting one: the same scene in a new box. */
  keepClock?: number
  /** Where the idle loop starts, once every frame is in (or the helper ended early). */
  loopFrom?: number
  /** The art it cross-fades in from over ENTRANCE_SECONDS, in its own box. */
  fadeFrom?: Uint32Array
}

export class Player {
  private want?: Want
  private wantKey = ''
  /** The clip on the band, which keeps playing (its loop, its bubble) until the next one's first frame lands. */
  private showing?: Clip
  /** The clip the running helper fills. */
  private incoming?: Clip
  private failure?: string
  private hasLogged = false
  private hasLoggedDeny = false
  private generation = 0
  private stream?: HookStream<ProcessSpawnChunk, ProcessSpawnResult>
  private loopEnded: Promise<void> = Promise.resolve()
  private timers: Timer[] = []
  private lastBlit?: string
  /** Whether the band's tree holds the Raster, so a blit has somewhere to land. */
  private isDrawn = false

  constructor(private readonly config: PlayerConfig) {}

  /** Why the helper could not draw this scene, if it could not: the band draws text then. */
  get failed(): string | undefined {
    return this.failure
  }

  /**
   * Plays `want`: nothing to do when it is what plays already; otherwise the
   * running helper ends, then one starts for the new scene or box. The band
   * keeps the picture it has until the new one's first frame lands; a new box
   * keeps the scene's clock, so the scene carries on.
   */
  async follow(host: PlayerHost, want: Want): Promise<void> {
    const sceneKey = JSON.stringify(want.scene)
    const wantKey = `${want.columns}x${want.rows}|${want.look}|${want.requestId}|${sceneKey}`
    if (wantKey === this.wantKey) return
    const ended = this.end()
    if (sceneKey !== this.incoming?.sceneKey) this.failure = undefined
    const held = this.showing
    this.want = want
    this.wantKey = wantKey
    this.incoming = {
      scene: want.scene,
      sceneKey,
      columns: want.columns,
      rows: want.rows,
      frames: [],
      count: FPS * Math.max(1, Math.ceil(readMs(want.scene) / 1000)),
      keepClock: held?.sceneKey === sceneKey ? held.shownAt : undefined,
    }
    this.lastBlit = undefined
    const generation = this.generation
    this.loopEnded = this.run(host, want, this.incoming, generation, ended)
    this.timers.push(host.every(Math.round(1000 / FPS), () => void this.repaint(host, generation)))
  }

  /** Ends the running helper and the playback; the band draws nothing of the mod's until a scene is followed again. */
  stop(): Promise<void> {
    this.want = undefined
    this.wantKey = ''
    this.showing = undefined
    this.incoming = undefined
    return this.end()
  }

  /**
   * The band's cells at `now`: the art due in the clip on the band (cross-faded
   * in from the last scene's over the entrance, resized to the band's box), with
   * the clip's title and bubble over it; undefined while no picture has landed.
   */
  cellsAt(now: number): string | undefined {
    const want = this.want
    const clip = this.showing
    if (!want || !clip) return undefined
    const t = (now - (clip.shownAt ?? now)) / 1000
    const art = this.artAt(clip, now)
    if (!art) return undefined
    return compose(fit(art, clip.columns, clip.rows, want.columns, want.rows), want.columns, want.rows, { scene: clip.scene, t, speaksAfter: clip.speaks })
  }

  /** The cells drawn into the tree (undefined: the engine's band, no Raster), so the next repaint does not send them again. */
  drawn(cells: string | undefined): void {
    this.lastBlit = cells
    this.isDrawn = cells !== undefined
  }

  /** A clip's art at `now`, in its own box, without the text: the frame due, blended over its entrance. */
  private artAt(clip: Clip, now: number): Uint32Array | undefined {
    if (clip.frames.length === 0) return undefined
    const t = (now - (clip.shownAt ?? now)) / 1000
    const art = decode(clip.frames[this.frameIndex(clip, t)]!)
    if (!art || !clip.fadeFrom || t >= ENTRANCE_SECONDS) return art
    return blend(clip.fadeFrom, art, Math.max(0, t) / ENTRANCE_SECONDS)
  }

  /**
   * The frame due `t` seconds in. Past the end, the frames from the clip's
   * loop start play round again; while frames are still coming, the newest in
   * stands in for one not yet drawn.
   */
  private frameIndex(clip: Clip, t: number): number {
    const i = Math.max(0, Math.floor(t * FPS))
    const n = clip.frames.length
    if (clip.loopFrom !== undefined) return i < n ? i : clip.loopFrom + ((i - n) % Math.max(1, n - clip.loopFrom))
    if (i < clip.count) return Math.min(i, n - 1)
    const from = Math.max(0, clip.count - LOOP_SECONDS * FPS)
    return Math.min(n - 1, from + ((i - from) % Math.max(1, clip.count - from)))
  }

  /** Every frame of a clip is in (or no more will come): its loop start is fixed. */
  private settle(clip: Clip): void {
    if (clip.loopFrom !== undefined || clip.frames.length === 0) return
    const frames = clip.frames.slice(0, clip.count).map(f => decode(f) ?? new Uint32Array(0))
    clip.frames = clip.frames.slice(0, clip.count)
    clip.loopFrom = loopStart(frames, FPS)
  }

  /**
   * A clip's first frame is in: it goes up in place of the one on the band, art
   * and caption together, starting its clock (or carrying on the one it keeps),
   * and fading in from the last picture when its scene enters with a fade.
   */
  private swap(host: PlayerHost, clip: Clip, now: number): void {
    const held = this.showing
    clip.shownAt = clip.keepClock ?? now
    if (held && clip.keepClock === undefined && clip.scene.enter === 'fade') {
      const from = this.artAt(held, now)
      if (from) clip.fadeFrom = fit(from, held.columns, held.rows, clip.columns, clip.rows)
    }
    this.showing = clip
    this.lastBlit = undefined
    // Nothing of the mod's was on the band: draw it again, so the Raster goes up.
    if (!held || !this.isDrawn) host.invalidate()
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
    if (generation !== this.generation || this.failure !== undefined || !this.want || !this.isDrawn) return
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
  private async run(host: PlayerHost, want: Want, clip: Clip, generation: number, previous: Promise<void>): Promise<void> {
    const waits: Timer[] = []
    const timedOut = new Promise<boolean>(resolve => void waits.push(host.after(END_WAIT_MS, () => resolve(false))))
    const isPreviousEnded = await Promise.race([previous.then(() => true), timedOut])
    for (const wait of waits) wait.cancel()
    if (!isPreviousEnded) host.log('fables: the last frame helper had not ended; starting the next')
    if (generation !== this.generation) return
    // The helper draws the scene without its entrance: the band cross-fades it in from the last picture itself.
    const scene: FablesScene = { ...want.scene }
    delete scene.enter
    const job = { scene, columns: want.columns, rows: want.rows, look: want.look, fps: FPS, seconds: clip.count / FPS }
    const stream = host.spawn({
      argv: ['bun', `${host.root}/renderer/frames.ts`],
      input: JSON.stringify(job),
      env: { CHROMIUM: this.config.chromiumPath },
    })
    this.stream = stream
    this.timers.push(
      host.after(NO_FRAME_MS, () => {
        if (clip.frames.length === 0) this.fail(host, generation, `no frame within ${NO_FRAME_MS / 1000} s`)
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
          if ('ready' in line) clip.speaks = line.speaksAfter
          else if ('cells' in line && line.i === clip.frames.length && clip.loopFrom === undefined) {
            clip.frames.push(line.cells)
            if (clip.frames.length === 1) {
              const now = await host.now()
              if (generation !== this.generation) break
              this.swap(host, clip, now)
            }
            if (clip.frames.length >= clip.count) this.settle(clip)
          }
        }
      }
      if (generation === this.generation && clip.frames.length === 0) this.fail(host, generation, 'the frame helper ended without a frame')
    } catch (error) {
      this.fail(host, generation, `the frame helper could not run: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      if (this.stream === stream) this.stream = undefined
      // Ended, cut short or not: what it drew is all there will be, and the loop plays from that.
      this.settle(clip)
    }
  }
}

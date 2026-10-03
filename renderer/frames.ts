/**
 * Turns one Fables scene into a stream of terminal frames.
 *
 *   bun renderer/frames.ts < job.json
 *
 * Reads one JSON job from stdin, `{ scene, columns, rows, look, fps, seconds }`,
 * and writes NDJSON to stdout: first
 * `{"ready":true,"columns","rows","speaksAfter","scale","cropTop"}`, then one
 * `{"i","t","cells"}` line per frame, `cells` in the Raster encoding (cells.ts).
 * On failure: one `{"error"}` line on stderr and exit 1.
 *
 * The scene is drawn as the band draws it (the 3D figure, the job's look)
 * without the speech bubble and the chapter tag, which the mod draws as text,
 * at one art pixel (hooks/svg.ts:U) per terminal pixel, so `scale` is always 1.
 * The stage is `columns` art pixels wide and 32 tall; a band of fewer than 32
 * pixel rows shows the window of it from art row `cropTop` that holds the
 * ground and Claude (window.ts), so a short band crops the scene rather than
 * shrinking it. Each frame is the SVG with its clock moved to `t`
 * (svg.ts:resumeAt), decoded as an image in a page and drawn to a canvas at
 * exactly the size the SVG declares, DEVICE pixels to a stage unit. Pixel art
 * then takes one device pixel at the middle of every art pixel; the painterly
 * looks average each art pixel's block (sample.ts). Several pages, each its
 * own renderer process, draw frames side by side.
 *
 * Drawn smaller than it declares, Chromium rasterizes an SVG image at the
 * smaller size, and below half a device pixel per stage unit the pixel look's
 * pixelize filter (svg.ts:PIXELIZE, a 2-unit grid of 0.4-unit dots) loses its
 * grid and draws a flat dark stage (ISS-001). Declared and drawn sizes are
 * therefore always equal here, at a whole number of device pixels per unit.
 *
 * The browser is this process's alone: it ends, and its profile is deleted, on
 * normal exit, SIGTERM, SIGINT, or once stdout is closed.
 */

import type { FablesScene } from '../types'

import { parseScene } from '../hooks/scene'
import { resumeAt } from '../hooks/svg'
import { type Browser, launch } from './browser'
import { packHalfBlocks } from './cells'
import { plan, terminalSvg, toPixels } from './plan'

/** Pages drawing at once. Measured on tulip (6 cores, 12 threads): 4 is past the knee. */
const WORKERS = 4
interface Job {
  scene: FablesScene
  columns: number
  rows: number
  look: string | undefined
  fps: number
  seconds: number
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

const isWhole = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max

const isPositive = (value: unknown, max: number): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= max

/** Validates the job, or throws saying what is wrong with it. */
export function parseJob(input: unknown): Job {
  if (!isRecord(input)) throw new Error('job must be a JSON object')
  const scene = parseScene(input.scene)
  if (!scene) throw new Error('job.scene is not a valid scene')
  if (!isWhole(input.columns, 1, 1000)) throw new Error('job.columns must be an integer from 1 to 1000')
  if (!isWhole(input.rows, 1, 200)) throw new Error('job.rows must be an integer from 1 to 200')
  if (!isPositive(input.fps, 60)) throw new Error('job.fps must be a number above 0, at most 60')
  if (!isPositive(input.seconds, 600)) throw new Error('job.seconds must be a number above 0, at most 600')
  if (input.look !== undefined && typeof input.look !== 'string') throw new Error('job.look must be a string')
  return { scene, columns: input.columns, rows: input.rows, look: input.look, fps: input.fps, seconds: input.seconds }
}

/**
 * Defined in each page: decodes one SVG as an image, draws it to a `w × h`
 * canvas and returns the RGBA as base64.
 */
const GRAB = `window.__grab = async (svg, w, h) => {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
  try {
    const img = new Image()
    img.src = url
    await img.decode()
    const g = new OffscreenCanvas(w, h).getContext('2d', { willReadFrequently: true })
    g.fillStyle = '#000'
    g.fillRect(0, 0, w, h)
    g.drawImage(img, 0, 0, w, h)
    return new Uint8Array(g.getImageData(0, 0, w, h).data.buffer).toBase64()
  } finally {
    URL.revokeObjectURL(url)
  }
}`

/** Opens one page in its own browser context (so its own renderer process) and defines the grabber. */
async function openPage(browser: Browser): Promise<string> {
  const context = await browser.send('Target.createBrowserContext')
  if (!isRecord(context) || typeof context.browserContextId !== 'string') throw new Error('no browser context')
  const target = await browser.send('Target.createTarget', { url: 'about:blank', browserContextId: context.browserContextId })
  if (!isRecord(target) || typeof target.targetId !== 'string') throw new Error('no page target')
  const attached = await browser.send('Target.attachToTarget', { targetId: target.targetId, flatten: true })
  if (!isRecord(attached) || typeof attached.sessionId !== 'string') throw new Error('no page session')
  await evaluate(browser, attached.sessionId, GRAB)
  return attached.sessionId
}

async function evaluate(browser: Browser, session: string, expression: string): Promise<unknown> {
  const reply = await browser.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, session)
  if (!isRecord(reply)) throw new Error('no reply from page')
  if (isRecord(reply.exceptionDetails)) {
    const ex = reply.exceptionDetails
    const detail = isRecord(ex.exception) && typeof ex.exception.description === 'string' ? ex.exception.description : String(ex.text)
    throw new Error(`page error: ${detail}`)
  }
  return isRecord(reply.result) ? reply.result.value : undefined
}


let browser: Browser | undefined
let ending = false

/** Ends the browser and exits; the first caller wins. */
async function finish(code: number, message?: string): Promise<never> {
  if (!ending) {
    ending = true
    if (message !== undefined) process.stderr.write(`${JSON.stringify({ error: message })}\n`)
    await browser?.close()
    process.exit(code)
  }
  return new Promise<never>(() => {})
}

/** Writes one line; a closed stdout ends the run. */
function emit(line: unknown): Promise<void> {
  return new Promise(resolve => {
    try {
      process.stdout.write(`${JSON.stringify(line)}\n`, error => {
        if (error) void finish(0)
        else resolve()
      })
    } catch {
      void finish(0)
    }
  })
}

async function main(): Promise<void> {
  process.on('SIGTERM', () => void finish(143))
  process.on('SIGINT', () => void finish(130))
  process.on('SIGPIPE', () => void finish(0))
  process.stdout.on('error', () => void finish(0))

  let input: unknown
  try {
    input = JSON.parse(await Bun.stdin.text())
  } catch {
    throw new Error('stdin is not one JSON job')
  }
  const job = parseJob(input)
  const at = plan(job)
  const { svg, speaks } = terminalSvg(job, at)
  const count = Math.ceil(job.fps * job.seconds - 1e-9)

  const started = await launch(process.env.CHROMIUM || 'chromium')
  browser = started
  if (ending) return
  const sessions = await Promise.all(Array.from({ length: Math.min(WORKERS, count) }, () => openPage(started)))
  await emit({ ready: true, columns: job.columns, rows: job.rows, speaksAfter: speaks, scale: 1, cropTop: at.cropTop })

  // Workers take frames in order; finished frames are written in order as soon as each is next.
  const done = new Map<number, string>()
  let next = 0
  let written = 0
  let flushing = Promise.resolve()
  const flush = () =>
    (flushing = flushing.then(async () => {
      while (done.has(written)) {
        const cells = done.get(written)
        done.delete(written)
        await emit({ i: written, t: Number((written / job.fps).toFixed(4)), cells })
        written++
      }
    }))

  await Promise.all(
    sessions.map(async session => {
      for (let i = next++; i < count && !ending; i = next++) {
        const value = await evaluate(started, session, `__grab(${JSON.stringify(resumeAt(svg, i / job.fps))}, ${at.width}, ${at.height})`)
        if (typeof value !== 'string') throw new Error(`frame ${i}: page returned no pixels`)
        const rgba = new Uint8Array(Buffer.from(value, 'base64'))
        done.set(i, packHalfBlocks(toPixels(rgba, at, job.columns, job.rows), job.columns, job.rows))
        await flush()
      }
    }),
  )
  await flushing
}

if (import.meta.main) {
  main().then(
    () => finish(0),
    (error: unknown) => finish(1, error instanceof Error ? error.message : String(error)),
  )
}

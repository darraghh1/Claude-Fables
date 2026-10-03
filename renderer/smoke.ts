/**
 * The frame helper's verify script, run from the repo root as `bun renderer/smoke.ts`.
 *
 * 1. Renders SAMPLES[0] at 200×20 cells, 12 fps, 7 s: one ready line and 84 frames,
 *    every frame valid Raster cells, at least 10 distinct, all within 8 s of spawn.
 * 2. SIGTERMs a second helper 1 s into its render: within 2 s no process carrying its
 *    profile dir remains, and the dir is gone.
 * 3. With CHROMIUM=/nonexistent the helper exits 1 within 2 s with one JSON error line on stderr.
 * 4. Every look draws SAMPLES[0] lit, at 220×8 and 200×16: mean channel ≥ 60, max ≥ 200.
 * 5. The pixel look draws lit at every band size, rows 4–16 by columns 80–300 (ISS-001).
 * 6. Pixel-exact: at 200×16 the pixel look reports scale 1 and cropTop 0, and on SAMPLES[0],
 *    [3] and [5] at least 60% of its edges are crisp, changing colour in one pixel rather than
 *    smeared over two (metrics.ts:crispEdges); the share of averaged in-between pairs is printed.
 * 7. Cropped, not zoomed: at 220×8 the window holds the ground line (art row 26) and
 *    Claude's highest reach, and at t = 1 s Claude's colour is in the frame, clear of row 0.
 * 8. Sharpness: on SAMPLES[0], [3] and [5] at 220×8, the pixel look's crisp-edge share is at
 *    least 2× that of main@4e9ffca's helper with the original look; gradient energy is printed
 *    beside it. The baseline helper is extracted from git into a temp dir, once per machine.
 *
 * 9. Seamless loop: on SAMPLES[0], [3] and [5] at 220×8, rendered as the band asks (12 fps, its
 *    reading time, no entrance), the wrap from the final frame to the loop's start
 *    (hooks/terminal/loop.ts:loopStart) differs by at most 1.5× the median step between
 *    consecutive frames in the loop; both numbers are printed.
 *
 * Exits 0 when all hold; otherwise prints every failure and exits 1.
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { LOOK_NAMES } from '../hooks/looks'
import { readMs } from '../hooks/narrator'
import { decode } from '../hooks/terminal/compose'
import { distance, loopStart } from '../hooks/terminal/loop'
import { parseScene } from '../hooks/scene'
import { SAMPLES } from '../scripts/samples'
import { HALF_BLOCK } from './cells'
import { profilePrefix } from './browser'
import { brightness, crispEdges, gradientEnergy, inBetween, rowsWithColour, unpackHalfBlocks } from './metrics'
import { ART_ROWS, GROUND_ROW, heroRows } from './window'

const HELPER = join(import.meta.dir, 'frames.ts')
const COLUMNS = 200
const ROWS = 20
const FPS = 12
const SECONDS = 7
const FRAMES = FPS * SECONDS
const BUDGET_MS = 8000

const failures: string[] = []
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`)
  if (!ok) failures.push(what)
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

const job = JSON.stringify({ scene: SAMPLES[0], columns: COLUMNS, rows: ROWS, fps: FPS, seconds: SECONDS })

/** Starts a helper (this one, unless another is named) with a job on stdin. */
function start(env: Record<string, string | undefined> = process.env, input = job, helper = HELPER) {
  const child = spawn(process.execPath, [helper], { stdio: ['pipe', 'pipe', 'pipe'], env })
  child.stdin.end(input)
  return child
}

/** Collects a child's stdout lines and stderr, resolving with its exit code. */
function run(child: ReturnType<typeof start>, onLine: (line: string) => void = () => {}) {
  let rest = ''
  let stderr = ''
  child.stdout.on('data', (chunk: Buffer) => {
    rest += chunk.toString()
    let nl: number
    while ((nl = rest.indexOf('\n')) >= 0) {
      onLine(rest.slice(0, nl))
      rest = rest.slice(nl + 1)
    }
  })
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
  return new Promise<{ code: number | null; stderr: string }>(resolve => child.on('close', code => resolve({ code, stderr })))
}

// ---------------------------------------------------------------- 1. a full render

async function fullRender() {
  const begun = performance.now()
  const lines: string[] = []
  let lastFrameAt = 0
  const { code, stderr } = await run(start(), line => {
    lines.push(line)
    lastFrameAt = performance.now()
  })
  const elapsed = lastFrameAt - begun
  console.log(`timing: spawn to last frame ${(elapsed / 1000).toFixed(2)} s for ${FRAMES} frames (${(elapsed / FRAMES).toFixed(1)} ms/frame), Chromium launch included`)

  check(code === 0, `helper exits 0 (got ${code}${stderr ? `, stderr ${stderr.trim()}` : ''})`)
  const parsed: unknown[] = lines.map(l => JSON.parse(l))
  const ready = parsed[0]
  check(isRecord(ready) && ready.ready === true && ready.columns === COLUMNS && ready.rows === ROWS && typeof ready.speaksAfter === 'number' && ready.scale === 1 && typeof ready.cropTop === 'number', `first line is the ready line, with scale 1 and a cropTop (${JSON.stringify(ready)})`)
  const frames = parsed.slice(1)
  check(parsed.length === FRAMES + 1, `exactly ${FRAMES} frame lines plus one ready line (got ${parsed.length} lines)`)

  const bytes = COLUMNS * ROWS * 12
  let sized = 0
  let inOrder = 0
  let badGlyph = 0
  let badColour = 0
  const distinct = new Set<string>()
  frames.forEach((frame, k) => {
    if (!isRecord(frame) || typeof frame.cells !== 'string') return
    if (frame.i === k && typeof frame.t === 'number' && Math.abs(frame.t - k / FPS) < 1e-3) inOrder++
    distinct.add(frame.cells)
    const raw = Buffer.from(frame.cells, 'base64')
    if (raw.length !== bytes) return
    sized++
    for (let o = 0; o < raw.length; o += 12) {
      if (raw.readUInt32LE(o) !== HALF_BLOCK) badGlyph++
      if (raw.readUInt32LE(o + 4) >>> 24 !== 0 || raw.readUInt32LE(o + 8) >>> 24 !== 0) badColour++
    }
  })
  check(sized === FRAMES, `every frame's cells decode to ${bytes} bytes (${sized}/${FRAMES})`)
  check(inOrder === FRAMES, `frames carry i and t = i/fps in order (${inOrder}/${FRAMES})`)
  check(distinct.size >= 10, `at least 10 distinct frames (${distinct.size})`)
  check(badGlyph === 0, `every cell's code point is 0x2580 (${badGlyph} not)`)
  check(badColour === 0, `every colour has bits 24-31 clear (${badColour} cells not)`)
  check(elapsed <= BUDGET_MS, `spawn to last frame within ${BUDGET_MS / 1000} s (${(elapsed / 1000).toFixed(2)} s)`)
}

// ---------------------------------------------------------------- 2. SIGTERM mid-render

const pgrep = (pattern: string) => spawnSync('pgrep', ['-f', '--', pattern]).stdout.toString().trim()

async function terminated() {
  const child = start()
  const done = run(child)
  await Bun.sleep(1000)
  const prefix = profilePrefix(child.pid ?? -1)
  const base = prefix.slice(dirname(prefix).length + 1)
  const dirs = readdirSync(dirname(prefix)).filter(name => name.startsWith(base))
  const profile = dirs[0] === undefined ? undefined : join(dirname(prefix), dirs[0])
  check(dirs.length === 1 && profile !== undefined, `the helper made one profile dir by 1 s (${dirs.length})`)
  if (!profile) {
    child.kill('SIGKILL')
    return
  }
  check(pgrep(`--user-data-dir=${profile}`) !== '', 'its browser is running at 1 s')
  const sent = performance.now()
  child.kill('SIGTERM')
  let gone = false
  while (performance.now() - sent < 2000) {
    if (pgrep(`--user-data-dir=${profile}`) === '' && !existsSync(profile)) {
      gone = true
      break
    }
    await Bun.sleep(50)
  }
  const after = ((performance.now() - sent) / 1000).toFixed(2)
  check(gone, `within 2 s of SIGTERM no process has ${profile} and the dir is deleted (${after} s)`)
  const { code } = await done
  check(code === 143, `the helper exits 143 on SIGTERM (got ${code})`)
}

// ---------------------------------------------------------------- 3. a missing browser

async function missingBrowser() {
  const begun = performance.now()
  const { code, stderr } = await run(start({ ...process.env, CHROMIUM: '/nonexistent' }))
  const elapsed = performance.now() - begun
  const lines = stderr.trim().split('\n')
  let error: unknown
  try {
    error = JSON.parse(lines[0] ?? '')
  } catch {
    error = undefined
  }
  check(code === 1, `CHROMIUM=/nonexistent exits 1 (got ${code})`)
  check(elapsed <= 2000, `and within 2 s (${(elapsed / 1000).toFixed(2)} s)`)
  check(lines.length === 1 && isRecord(error) && typeof error.error === 'string', `with one JSON error line on stderr (${stderr.trim()})`)
}

// ---------------------------------------------------------------- shared by 4 to 8

interface Render {
  ready: Record<string, unknown> | undefined
  /** Each frame as `columns × rows*2` RGB; undefined where its cells are not valid half blocks. */
  frames: (Uint8Array | undefined)[]
  code: number | null
  stderr: string
}

/** Renders one job to completion and decodes its frames. */
async function render(input: { scene: unknown; columns: number; rows: number; look?: string; fps: number; seconds: number }, helper = HELPER): Promise<Render> {
  const lines: string[] = []
  const { code, stderr } = await run(start(process.env, JSON.stringify(input), helper), line => lines.push(line))
  const parsed: unknown[] = lines.map(l => JSON.parse(l))
  const ready = isRecord(parsed[0]) && parsed[0].ready === true ? parsed[0] : undefined
  const frames = parsed.slice(1).map(f => (isRecord(f) && typeof f.cells === 'string' ? unpackHalfBlocks(f.cells, input.columns, input.rows) : undefined))
  return { ready, frames, code, stderr }
}

/** Runs `jobs` with at most `width` helpers at once, keeping their order. */
async function pool<T, R>(items: readonly T[], width: number, each: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(width, items.length) }, async () => {
      for (let i = next++; i < items.length; i = next++) out[i] = await each(items[i]!)
    }),
  )
  return out
}

const fixed = (n: number, d = 1) => n.toFixed(d)

/** Whether a render exited 0 with a ready line and every frame decoded. */
const rendered = (r: Render, frames: number) => r.code === 0 && r.ready !== undefined && r.frames.length === frames && r.frames.every(f => f !== undefined)

// ---------------------------------------------------------------- 4. every look, lit

const LIT_MEAN = 60
const LIT_MAX = 200

async function looksLit() {
  const sizes = [
    [220, 8],
    [200, 16],
  ] as const
  const jobs = LOOK_NAMES.flatMap(look => sizes.map(([columns, rows]) => ({ look, columns, rows })))
  const results = await pool(jobs, 3, j => render({ scene: SAMPLES[0], columns: j.columns, rows: j.rows, look: j.look, fps: 1, seconds: 1 }))
  jobs.forEach((j, k) => {
    const r = results[k]!
    const frame = r.frames[0]
    const lit = frame ? brightness(frame) : { mean: 0, max: 0 }
    check(rendered(r, 1) && lit.mean >= LIT_MEAN && lit.max >= LIT_MAX, `look ${j.look} at ${j.columns}×${j.rows} is lit: mean ${fixed(lit.mean)} ≥ ${LIT_MEAN}, max ${lit.max} ≥ ${LIT_MAX}${r.code === 0 ? '' : ` (exit ${r.code}: ${r.stderr.trim()})`}`)
  })
}

// ---------------------------------------------------------------- 5. the pixel look at every band size (ISS-001)

async function pixelEverySize() {
  const jobs = [4, 8, 12, 16].flatMap(rows => [80, 150, 220, 300].map(columns => ({ columns, rows })))
  const results = await pool(jobs, 3, j => render({ scene: SAMPLES[0], columns: j.columns, rows: j.rows, look: 'pixel', fps: 1, seconds: 1 }))
  const dark = jobs.filter((j, k) => {
    const frame = results[k]!.frames[0]
    const lit = frame ? brightness(frame) : { mean: 0, max: 0 }
    return !rendered(results[k]!, 1) || lit.mean < LIT_MEAN || lit.max < LIT_MAX
  })
  check(dark.length === 0, `the pixel look is lit at all ${jobs.length} sizes, rows 4–16 by columns 80–300 (dark: ${dark.map(j => `${j.columns}×${j.rows}`).join(', ') || 'none'})`)
}

// ---------------------------------------------------------------- 6. pixel-exact

const MIN_CRISP = 0.6

async function pixelExact() {
  const columns = 200
  const rows = 16
  const samples = [0, 3, 5]
  const results = await pool(samples, 3, sample => render({ scene: SAMPLES[sample], columns, rows, look: 'pixel', fps: 2, seconds: 2 }))
  samples.forEach((sample, k) => {
    const r = results[k]!
    const frames = r.frames.filter(f => f !== undefined)
    const crisp = frames.length ? Math.min(...frames.map(f => crispEdges(f, columns))) : 0
    const ramps = frames.length ? Math.max(...frames.map(f => inBetween(f, columns))) : 1
    check(rendered(r, 4) && r.ready?.scale === 1 && r.ready.cropTop === 0, `pixel-exact: SAMPLES[${sample}] at 200×16 reports scale 1 and cropTop 0 (scale ${String(r.ready?.scale)}, cropTop ${String(r.ready?.cropTop)}, exit ${r.code})`)
    check(crisp >= MIN_CRISP, `pixel-exact: SAMPLES[${sample}] at 200×16 has ≥ ${MIN_CRISP} crisp edges in every frame (least ${fixed(crisp, 3)}; most in-between pairs ${fixed(ramps * 100, 2)}%, for the record)`)
  })
}

// ---------------------------------------------------------------- 7. cropped, not zoomed

/** Claude's body colour (hooks/clawd3d.ts) and how far a lit, shaded pixel of it may stray. */
const CLAUDE = 0xd97757
const CLAUDE_TOLERANCE = 24

async function croppedNotZoomed() {
  const columns = 220
  const rows = 8
  const scene = parseScene(SAMPLES[0])
  const r = await render({ scene: SAMPLES[0], columns, rows, look: 'pixel', fps: 1, seconds: 2 })
  check(rendered(r, 2), `crop: 220×8 renders 2 frames (exit ${r.code})`)
  const top = r.ready?.cropTop
  const hero = scene ? heroRows(scene.hero.action, scene.hero.then) : undefined
  const window = typeof top === 'number' ? `art rows ${top}–${top + rows * 2 - 1}` : 'no cropTop'
  check(r.ready?.scale === 1, `crop: the ready line reports scale 1 (${String(r.ready?.scale)})`)
  check(
    typeof top === 'number' && hero !== undefined && top <= hero.top && top + rows * 2 > GROUND_ROW && top >= 0 && top + rows * 2 <= ART_ROWS,
    `crop: cropTop ${String(top)} shows ${window}, holding the ground line (row ${GROUND_ROW}) and Claude's highest reach (row ${hero?.top})`,
  )
  const at1 = r.frames[1]
  const claude = at1 ? rowsWithColour(at1, columns, CLAUDE, CLAUDE_TOLERANCE) : { top: Infinity, bottom: -1, count: 0 }
  check(claude.count >= 20 && claude.top > 0, `crop: at t = 1 s Claude's colour is in the frame and clear of row 0 (${claude.count} px, rows ${claude.top}–${claude.bottom})`)
}

// ---------------------------------------------------------------- 8. sharper than main@4e9ffca

const BASELINE = '4e9ffca'
const MIN_SHARPER = 2

/** main@4e9ffca's helper, extracted from git once into a temp dir; undefined (and why) when git cannot. */
function baselineHelper(): { helper?: string; why?: string } {
  const dir = join(tmpdir(), `fables-baseline-${BASELINE}`)
  const helper = join(dir, 'renderer', 'frames.ts')
  if (existsSync(helper)) return { helper }
  const staging = `${dir}.${process.pid}`
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(staging, { recursive: true })
  const archive = spawnSync('git', ['-C', join(import.meta.dir, '..'), 'archive', BASELINE, 'hooks', 'renderer', 'types', 'scripts'])
  if (archive.status !== 0) return { why: `git archive ${BASELINE} failed: ${archive.stderr.toString().trim()}` }
  const tar = spawnSync('tar', ['-x', '-C', staging], { input: archive.stdout })
  if (tar.status !== 0) return { why: `tar failed: ${tar.stderr.toString().trim()}` }
  try {
    renameSync(staging, dir)
  } catch {
    rmSync(staging, { recursive: true, force: true })
  }
  return existsSync(helper) ? { helper } : { why: `no ${helper} after extraction` }
}

async function sharper() {
  const { helper: baseline, why } = baselineHelper()
  check(baseline !== undefined, `sharpness: main@${BASELINE}'s helper is at hand${why ? ` (${why})` : ''}`)
  if (!baseline) return
  const columns = 220
  const rows = 8
  const samples = [0, 3, 5]
  const jobs = samples.flatMap(sample => [
    { sample, helper: HELPER, look: 'pixel' },
    { sample, helper: baseline, look: 'original' },
  ])
  const results = await pool(jobs, 3, j => render({ scene: SAMPLES[j.sample], columns, rows, look: j.look, fps: 2, seconds: 2 }, j.helper))
  const mean = (frames: (Uint8Array | undefined)[], measure: (f: Uint8Array) => number) => {
    const ok = frames.filter(f => f !== undefined)
    return ok.length ? ok.reduce((sum, f) => sum + measure(f), 0) / ok.length : 0
  }
  samples.forEach((sample, k) => {
    const now = results[k * 2]!
    const then = results[k * 2 + 1]!
    const crisp = [mean(now.frames, f => crispEdges(f, columns)), mean(then.frames, f => crispEdges(f, columns))] as const
    const energy = [mean(now.frames, f => gradientEnergy(f, columns)), mean(then.frames, f => gradientEnergy(f, columns))] as const
    console.log(
      `sharpness SAMPLES[${sample}] at 220×8: crisp edges ${fixed(crisp[0], 3)} (pixel, now) vs ${fixed(crisp[1], 3)} (original, main@${BASELINE}) = ${fixed(crisp[0] / crisp[1], 2)}×; ` +
        `gradient energy ${fixed(energy[0], 2)} vs ${fixed(energy[1], 2)} = ${fixed(energy[0] / energy[1], 2)}×`,
    )
    check(rendered(now, 4) && rendered(then, 4) && crisp[0] >= MIN_SHARPER * crisp[1], `sharpness: SAMPLES[${sample}] crisp-edge share is ≥ ${MIN_SHARPER}× main@${BASELINE}'s (${fixed(crisp[0] / crisp[1], 2)}×)`)
  })
}

// ---------------------------------------------------------------- 9. a seamless loop

const MAX_SEAM = 1.5

async function seamlessLoop() {
  const columns = 220
  const rows = 8
  const samples = [0, 3, 5]
  const results = await pool(samples, 3, async sample => {
    const scene = parseScene(SAMPLES[sample])
    const seconds = scene ? Math.max(1, Math.ceil(readMs({ caption: scene.caption }) / 1000)) : 1
    const lines: string[] = []
    const { code, stderr } = await run(start(process.env, JSON.stringify({ scene: { ...scene, enter: undefined }, columns, rows, look: 'pixel', fps: FPS, seconds })), line => lines.push(line))
    const frames = lines
      .map(l => JSON.parse(l) as unknown)
      .filter(isRecord)
      .flatMap(f => (typeof f.cells === 'string' ? [decode(f.cells)] : []))
      .filter(f => f !== undefined)
    return { code, stderr, frames, count: FPS * seconds }
  })
  samples.forEach((sample, k) => {
    const { code, stderr, frames, count } = results[k]!
    if (code !== 0 || frames.length !== count) {
      check(false, `seam: SAMPLES[${sample}] renders ${count} frames (got ${frames.length}, exit ${code}${stderr ? `: ${stderr.trim()}` : ''})`)
      return
    }
    const from = loopStart(frames, FPS)
    const seam = distance(frames[count - 1]!, frames[from]!)
    const steps = frames.slice(from + 1).map((f, i) => distance(frames[from + i]!, f)).sort((a, b) => a - b)
    const median = steps.length ? steps[Math.floor(steps.length / 2)]! : 0
    console.log(`seam SAMPLES[${sample}] at 220×8: loop frames ${from}–${count - 1} of ${count}; seam ${seam} vs median step ${median} (${median ? fixed(seam / median, 2) : '—'}×)`)
    check(seam <= MAX_SEAM * median, `seam: SAMPLES[${sample}] wraps within ${MAX_SEAM}× its median frame step (seam ${seam}, median ${median})`)
  })
}

await fullRender()
await terminated()
await missingBrowser()
await looksLit()
await pixelEverySize()
await pixelExact()
await croppedNotZoomed()
await sharper()
await seamlessLoop()
if (failures.length) {
  console.log(`\n${failures.length} failed`)
  process.exit(1)
}
console.log('\nsmoke passed')

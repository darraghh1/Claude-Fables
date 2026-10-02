/**
 * The frame helper's verify script, run from the repo root as `bun renderer/smoke.ts`.
 *
 * 1. Renders SAMPLES[0] at 200×20 cells, 12 fps, 7 s: one ready line and 84 frames,
 *    every frame valid Raster cells, at least 10 distinct, all within 8 s of spawn.
 * 2. SIGTERMs a second helper 1 s into its render: within 2 s no process carrying its
 *    profile dir remains, and the dir is gone.
 * 3. With CHROMIUM=/nonexistent the helper exits 1 within 2 s with one JSON error line on stderr.
 *
 * Exits 0 when all hold; otherwise prints every failure and exits 1.
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { SAMPLES } from '../scripts/samples'
import { HALF_BLOCK } from './cells'
import { profilePrefix } from './browser'

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

/** Starts a helper with the job on stdin. */
function start(env: Record<string, string | undefined> = process.env) {
  const child = spawn(process.execPath, [HELPER], { stdio: ['pipe', 'pipe', 'pipe'], env })
  child.stdin.end(job)
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
  check(isRecord(ready) && ready.ready === true && ready.columns === COLUMNS && ready.rows === ROWS && typeof ready.speaksAfter === 'number', 'first line is the ready line')
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

await fullRender()
await terminated()
await missingBrowser()
if (failures.length) {
  console.log(`\n${failures.length} failed`)
  process.exit(1)
}
console.log('\nsmoke passed')

/**
 * The terminal band's picture, cell by cell: a frame from the helper
 * (renderer/frames.ts), or a dark one until the first lands, with the chapter
 * tag and the caption's bubble written over it as text cells.
 *
 * Pure, with no I/O and no host globals: the Player (player.ts) and the tests
 * call it with a frame and a time.
 */

import type { FablesScene } from '../../types'

import { base64 } from '../../renderer/cells'
import { TYPE_SECONDS_PER_CHAR } from '../scene'

/** The bubble's ink and paper, the desktop caption's. */
export const INK = 0x222222
export const PAPER = 0xf4efe2
/** The band before a frame lands. */
export const DARK = 0x101010
/** Characters a bubble line holds before it wraps. */
export const WRAP = 36
/** The widest and tallest Raster the engine takes (RasterProps). */
export const MAX_COLUMNS = 512
export const MAX_ROWS = 256

/** What a scene's text overlay needs: its caption, its title, where Claude ends up, and when it speaks. */
export type Overlay = {
  scene: FablesScene
  /** Seconds since the scene went up. */
  t: number
  /** Seconds into the scene the caption starts typing; undefined while unknown (no bubble text yet). */
  speaksAfter: number | undefined
}

/** The band's box in cells: the body's width (at most a Raster's), and the configured rows, one short of the band's limit. */
export function bandBox(bodyColumns: number, maxRows: number, terminalRows: number): { columns: number; rows: number } {
  const columns = Math.max(1, Math.min(MAX_COLUMNS, Math.floor(Number.isFinite(bodyColumns) ? bodyColumns : 80)))
  const room = Number.isFinite(maxRows) ? Math.floor(maxRows) - 1 : terminalRows
  const rows = Math.max(1, Math.min(MAX_ROWS, Math.floor(terminalRows), room))
  return { columns, rows }
}

/**
 * One character a Raster cell takes: printable, BMP, one column wide. Anything
 * else (an emoji, a CJK ideograph, a combining mark, a control) becomes '?',
 * because one refused code point refuses the whole tree.
 */
export function cellCode(ch: string): number {
  const cp = ch.codePointAt(0) ?? 0x3f
  const isNarrow =
    (cp >= 0x20 && cp < 0x7f) ||
    (cp >= 0xa0 && cp < 0x300) ||
    (cp >= 0x370 && cp < 0x1100) ||
    (cp >= 0x2000 && cp < 0x200b) ||
    (cp >= 0x2010 && cp < 0x2028) ||
    (cp >= 0x2030 && cp < 0x205f) ||
    (cp >= 0x20a0 && cp < 0x20c0) ||
    (cp >= 0x2190 && cp < 0x2600)
  return isNarrow ? cp : 0x3f
}

/** Words wrapped into lines of at most `width` characters; a longer word is cut. */
export function wrap(text: string, width: number = WRAP): string[] {
  const lines: string[] = []
  let line = ''
  for (const word of text.split(/\s+/).filter(Boolean)) {
    let rest = [...word]
    while (rest.length > 0) {
      const room = line ? width - [...line].length - 1 : width
      if (rest.length <= room) {
        line = line ? `${line} ${rest.join('')}` : rest.join('')
        rest = []
      } else if (line) {
        lines.push(line)
        line = ''
      } else {
        lines.push(rest.slice(0, width).join(''))
        rest = rest.slice(width)
      }
    }
  }
  if (line) lines.push(line)
  return lines
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const B64_INDEX = new Map([...B64].map((c, i) => [c, i]))

/** Standard padded base64 to bytes; undefined when it is not. */
function unbase64(text: string): Uint8Array | undefined {
  const clean = text.replace(/=+$/, '')
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4))
  let o = 0
  for (let i = 0; i < clean.length; i += 4) {
    let v = 0
    let n = 0
    for (let k = 0; k < 4 && i + k < clean.length; k++, n++) {
      const d = B64_INDEX.get(clean[i + k]!)
      if (d === undefined) return undefined
      v |= d << (18 - 6 * k)
    }
    if (n > 1) out[o++] = (v >>> 16) & 0xff
    if (n > 2) out[o++] = (v >>> 8) & 0xff
    if (n > 3) out[o++] = v & 0xff
  }
  return out
}

/** A frame's cells as words `[codePoint, fg, bg]` per cell; a dark band when there is no frame, or it is not this box's. */
function decodeCells(cells: string | undefined, columns: number, rows: number): Uint32Array {
  const size = columns * rows * 3
  const bytes = cells === undefined ? undefined : unbase64(cells)
  if (bytes && bytes.length === size * 4) {
    const words = new Uint32Array(size)
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    for (let i = 0; i < size; i++) words[i] = view.getUint32(i * 4, true)
    return words
  }
  const words = new Uint32Array(size)
  for (let i = 0; i < size; i += 3) {
    words[i] = 0x20
    words[i + 1] = DARK
    words[i + 2] = DARK
  }
  return words
}

function encodeCells(words: Uint32Array): string {
  const bytes = new Uint8Array(words.length * 4)
  const view = new DataView(bytes.buffer)
  for (let i = 0; i < words.length; i++) view.setUint32(i * 4, words[i]!, true)
  return base64(bytes)
}

/** Writes `text` from (x, y), clipped to the box. */
function put(words: Uint32Array, columns: number, rows: number, x: number, y: number, text: string, fg: number, bg: number) {
  if (y < 0 || y >= rows) return
  let cx = x
  for (const ch of text) {
    if (cx >= 0 && cx < columns) {
      const o = (y * columns + cx) * 3
      words[o] = cellCode(ch)
      words[o + 1] = fg
      words[o + 2] = bg
    }
    cx++
  }
}

/** The bubble's place: beside Claude's final position, on the side with room, inside the band. */
export function bubbleAt(scene: FablesScene, columns: number, rows: number): { x: number; y: number; lines: string[]; width: number } {
  const lines = wrap(scene.caption)
  const inner = Math.max(1, ...lines.map(l => [...l].length))
  const width = inner + 4
  const height = lines.length + 2
  const hero = Math.round((Math.max(0, Math.min(100, scene.hero.to)) / 100) * columns)
  let x = hero + 4
  if (x + width > columns) x = hero - 4 - width
  x = Math.max(0, Math.min(columns - width, x))
  const y = Math.max(0, Math.min(1, rows - height))
  return { x, y, lines, width }
}

/** How many of the caption's characters have been typed `t` seconds in. */
export function typedChars(t: number, speaksAfter: number | undefined): number {
  if (speaksAfter === undefined || t < speaksAfter) return 0
  return Math.floor((t - speaksAfter) / TYPE_SECONDS_PER_CHAR)
}

/**
 * The cells the band shows: `frame` (or a dark band) with the title top-left
 * and the bubble beside Claude, its caption typed out so far.
 */
export function compose(frame: string | undefined, columns: number, rows: number, overlay: Overlay): string {
  const words = decodeCells(frame, columns, rows)
  const { scene } = overlay
  const { x, y, lines, width } = bubbleAt(scene, columns, rows)
  put(words, columns, rows, x, y, `╭${'─'.repeat(width - 2)}╮`, INK, PAPER)
  let left = typedChars(overlay.t, overlay.speaksAfter)
  lines.forEach((line, i) => {
    const chars = [...line]
    const shown = chars.slice(0, Math.max(0, left)).join('')
    left -= chars.length + 1
    put(words, columns, rows, x, y + 1 + i, `│ ${shown.padEnd(width - 4)} │`, INK, PAPER)
  })
  put(words, columns, rows, x, y + 1 + lines.length, `╰${'─'.repeat(width - 2)}╯`, INK, PAPER)
  if (scene.title) put(words, columns, rows, 1, 0, ` ${scene.title} `, PAPER, INK)
  return encodeCells(words)
}

/** The text of one row of composed cells (tests read the bubble with it). */
export function rowText(cells: string, columns: number, row: number): string {
  const words = decodeCells(cells, columns, Math.floor((unbase64(cells)?.length ?? 0) / (columns * 12)))
  let out = ''
  for (let x = 0; x < columns; x++) out += String.fromCodePoint(words[(row * columns + x) * 3] ?? 0x20)
  return out
}

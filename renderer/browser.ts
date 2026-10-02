/**
 * A headless Chromium this process starts, owns and ends, driven over the
 * DevTools protocol on loopback only. The browser runs in its own process
 * group with its own temporary profile, so `close()` can end every process it
 * started and delete the profile.
 */

import { type ChildProcess, spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** How long Chromium gets to print its DevTools endpoint. */
const LAUNCH_TIMEOUT_MS = 10_000
/** The only endpoint prefix accepted: the browser's own loopback listener. */
const LOOPBACK = 'ws://127.0.0.1:'

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

export interface Browser {
  /** The profile directory, unique to this browser; also how its processes are found. */
  readonly profile: string
  /** Sends one DevTools command, on a page session when `session` is given. */
  send(method: string, params?: Record<string, unknown>, session?: string): Promise<unknown>
  /** Ends every browser process and deletes the profile; safe to call more than once. */
  close(): Promise<void>
}

/** The prefix of every profile directory this helper makes, so a caller can find one by pid. */
export const profilePrefix = (pid: number) => join(tmpdir(), `fables-frames-${pid}-`)

export async function launch(binary: string): Promise<Browser> {
  const profile = mkdtempSync(profilePrefix(process.pid))
  let child: ChildProcess | undefined
  let socket: WebSocket | undefined
  let closed: Promise<void> | undefined
  const pending = new Map<number, Pending>()
  let nextId = 0

  const close = () =>
    (closed ??= (async () => {
      socket?.close()
      const pid = child?.pid
      if (pid !== undefined && child?.exitCode === null && child.signalCode === null) {
        const exited = new Promise<void>(resolve => child?.once('exit', () => resolve()))
        try {
          // The whole process group: the browser and every renderer, GPU and zygote process it forked.
          process.kill(-pid, 'SIGKILL')
        } catch {
          // already gone
        }
        await Promise.race([exited, Bun.sleep(1000)])
      }
      for (const p of pending.values()) p.reject(new Error('browser closed'))
      pending.clear()
      rmSync(profile, { recursive: true, force: true })
    })())

  try {
    const endpoint = await new Promise<string>((resolve, reject) => {
      const proc = spawn(
        binary,
        [
          '--headless=new',
          '--no-sandbox',
          '--no-first-run',
          '--no-default-browser-check',
          '--disable-extensions',
          '--disable-background-networking',
          '--disable-component-update',
          '--disable-sync',
          '--mute-audio',
          '--remote-debugging-address=127.0.0.1',
          '--remote-debugging-port=0',
          `--user-data-dir=${profile}`,
          'about:blank',
        ],
        { detached: true, stdio: ['ignore', 'ignore', 'pipe'] },
      )
      child = proc
      const timer = setTimeout(() => reject(new Error(`chromium printed no DevTools endpoint within ${LAUNCH_TIMEOUT_MS} ms`)), LAUNCH_TIMEOUT_MS)
      let seen = ''
      let found = false
      proc.once('error', error => {
        clearTimeout(timer)
        reject(new Error(`cannot start chromium (${binary}): ${error.message}`))
      })
      proc.once('exit', code => {
        clearTimeout(timer)
        reject(new Error(`chromium exited (${code}) before it was ready`))
      })
      // Read stderr to the end, always: a full pipe would stall the browser.
      proc.stderr?.on('data', (chunk: Buffer) => {
        if (found) return
        seen += chunk.toString()
        const line = seen.split('\n').find(l => l.startsWith('DevTools listening on '))
        if (!line) return
        found = true
        seen = ''
        clearTimeout(timer)
        const url = line.slice('DevTools listening on '.length).trim()
        if (url.startsWith(LOOPBACK)) resolve(url)
        else reject(new Error(`chromium is listening off loopback: ${url}`))
      })
    })

    const ws = new WebSocket(endpoint)
    socket = ws
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve()
      ws.onerror = () => reject(new Error('cannot connect to chromium DevTools'))
    })
    ws.onmessage = event => {
      const reply: unknown = JSON.parse(String(event.data))
      if (!isRecord(reply) || typeof reply.id !== 'number') return
      const waiter = pending.get(reply.id)
      if (!waiter) return
      pending.delete(reply.id)
      if (isRecord(reply.error)) waiter.reject(new Error(typeof reply.error.message === 'string' ? reply.error.message : 'DevTools error'))
      else waiter.resolve(reply.result)
    }
    ws.onclose = () => {
      for (const p of pending.values()) p.reject(new Error('DevTools connection closed'))
      pending.clear()
    }
  } catch (error) {
    await close()
    throw error
  }

  const send = (method: string, params: Record<string, unknown> = {}, session?: string) =>
    new Promise<unknown>((resolve, reject) => {
      if (!socket || socket.readyState !== WebSocket.OPEN) return reject(new Error('DevTools connection is not open'))
      const id = ++nextId
      pending.set(id, { resolve, reject })
      socket.send(JSON.stringify(session ? { id, method, params, sessionId: session } : { id, method, params }))
    })

  return { profile, send, close }
}

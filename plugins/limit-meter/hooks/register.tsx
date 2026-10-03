import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { ChatUse, ContextFill, Density, Peer, Role, Snapshot, Win } from '../types'

type $ = EngineInterface

/** One chat's file under `sessions/`: what the other chats of a project read. */
type Rec = {
  sid: string
  project: string
  projectName: string
  label: string
  role: Role
  used: ChatUse
  startedAt: number
  updatedAt: number
  /** When this chat last took a credit reading; absent before its first. */
  lastCreditAt?: number
  /** The conversation, kept across a resume that hands it a new session id. */
  key?: string
  /** The session that resumed this conversation and took its record over. */
  supersededBy?: string
}

/** The last account-wide reading of each window any chat took. */
type Ledger = Record<string, { pct: number; resetsAt?: string; at: number }>

type Ctx = { dir: string; sid: string; key: string; project: string; projectName: string }

const snapshot = atom({ plugin: 'limit-meter', key: 'snapshot' } as const, null)
const density = atom({ plugin: 'limit-meter', key: 'density' } as const, 'medium')
const contextFill = atom({ plugin: 'limit-meter', key: 'fill' } as const, null)
/** The current minute: writing it redraws the band, so reset countdowns move. */
const tick = atom({ plugin: 'limit-meter', key: 'tick' } as const, 0)

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const SAME_WINDOW_MS = 5 * 60_000
const LEDGER_STALE_MS = 10 * 60_000
const FETCH_GAP_MS = 15_000
/** Context and the countdown: a local read, no network. */
const FAST_MS = 5_000
/** Limits: one usage call a minute, shared by every open chat through `reading.json`. */
const POLL_MS = 60_000
const SHARED_FRESH_MS = 25_000
/** How long the last good reading stands in when the usage endpoint fails. */
const CACHED_MAX_MS = 10 * 60_000
/** Idle for this long, a chat polls the limits only every fifth minute. */
const IDLE_MS = 10 * 60_000
const IDLE_POLL_EVERY = 5
const PEER_MAX_AGE_MS = 8 * 24 * 3_600_000
const PEERS_SHOWN = 3

/** `five_hour`, `seven_day` and the per-model weeks (`seven_day_<model>`). */
const isWindowKind = (kind: string) =>
  kind === 'five_hour' || kind === 'seven_day' || /^seven_day_[a-z0-9]+$/.test(kind)

const round1 = (n: number) => Math.round(n * 10) / 10

const sameWindow = (a?: string, b?: string) =>
  a === undefined || b === undefined
    ? a === b
    : Math.abs(Date.parse(a) - Date.parse(b)) < SAME_WINDOW_MS

const baseName = (path: string) => path.replace(/\/+$/, '').split('/').pop() || path

const readJson = async <T,>($: $, path: string): Promise<T | undefined> => {
  try {
    return JSON.parse(await $.fs.read(path)) as T
  } catch {
    return undefined
  }
}

const writeJson = ($: $, path: string, value: unknown) =>
  $.fs.write(path, JSON.stringify(value, null, 2))

/** Per process; a reload starts it over, which only costs one more fetch. */
const mem: {
  ctx?: Ctx
  source: Snapshot['source']
  lastFetch?: { at: number; wins: Win[] }
  chain: Promise<void>
  isTurnActive: boolean
  isDebug: boolean
  lastActiveAt: number
  polls: number
} = {
  source: 'oauth',
  chain: Promise.resolve(),
  isTurnActive: false,
  isDebug: false,
  lastActiveAt: 0,
  polls: 0,
}

const context = async ($: $): Promise<Ctx> => {
  if (mem.ctx) {
    return mem.ctx
  }
  const home = (await $.env.get('HOME')) ?? '~'
  const repo = await $.session.repo().catch(() => null)
  const project = repo?.root ?? (await $.session.root())
  // The desktop app's own id survives a resume; elsewhere, the first launch does.
  const host = await $.env.get('CLAUDE_CODE_HOST_SESSION_ID')
  const key = host ? `host:${host}` : `start:${(await $.session.usage()).startedAt}`
  mem.ctx = {
    dir: `${home}/.claude/limit-meter`,
    sid: await $.session.id(),
    key,
    project,
    projectName: baseName(project),
  }

  return mem.ctx
}

const recPath = (c: Ctx, sid = c.sid) => `${c.dir}/sessions/${sid}.json`

const loadRec = async ($: $): Promise<Rec> => {
  const c = await context($)
  const held = await readJson<Rec>($, recPath(c))
  if (held) {
    return held
  }
  const now = await $.clock.now()

  return {
    sid: c.sid,
    key: c.key,
    project: c.project,
    projectName: c.projectName,
    label: '',
    role: 'chat',
    used: {},
    startedAt: now,
    updatedAt: now,
  }
}

const saveRec = async ($: $, rec: Rec) => {
  const c = await context($)
  await writeJson($, recPath(c), { ...rec, key: c.key, updatedAt: await $.clock.now() })
}

/**
 * A resumed conversation runs under a new session id: take over the record
 * its earlier session left (points, label, role) and mark that one done.
 */
const adoptEarlier = async ($: $) => {
  const c = await context($)
  const entries = await $.fs.list(`${c.dir}/sessions`).catch(() => [])
  for (const f of entries) {
    if (f.kind !== 'file' || !f.name.endsWith('.json') || f.name === `${c.sid}.json`) {
      continue
    }
    const old = await readJson<Rec>($, `${c.dir}/sessions/${f.name}`)
    if (!old || old.supersededBy || old.key !== c.key || old.project !== c.project) {
      continue
    }
    const rec = await loadRec($)
    const used: ChatUse = { ...rec.used }
    for (const [kind, u] of Object.entries(old.used)) {
      const mine = used[kind]
      used[kind] =
        mine && sameWindow(mine.resetsAt, u.resetsAt)
          ? { pct: round1(mine.pct + u.pct), resetsAt: mine.resetsAt }
          : (mine ?? u)
    }
    await saveRec($, {
      ...rec,
      used,
      label: old.label || rec.label,
      role: old.role === 'thread' ? 'thread' : rec.role,
      lastCreditAt: Math.max(old.lastCreditAt ?? 0, rec.lastCreditAt ?? 0) || undefined,
    })
    await writeJson($, `${c.dir}/sessions/${f.name}`, { ...old, supersededBy: c.sid })
  }
}

/** The account's windows from the usage endpoint the app's usage card reads. */
/** Why the usage endpoint failed, never its body: kept whatever `debug` says. */
const noteFailure = async ($: $, cause: string) => {
  const c = await context($)
  await writeJson($, `${c.dir}/last-error.json`, {
    at: new Date(await $.clock.now()).toISOString(),
    cause,
  }).catch(() => undefined)
}

const fetchOauth = async ($: $): Promise<Win[] | null> => {
  const auth = await $.session.authorize()
  if (!auth || auth.kind !== 'bearer') {
    await noteFailure($, 'no-auth')
    return null
  }
  const res = await $.http.fetch(USAGE_URL, {
    headers: { 'anthropic-beta': 'oauth-2025-04-20' },
    auth: auth.handle,
  })
  if (!res.ok) {
    await noteFailure($, `http ${res.status}`)
    return null
  }
  const body = JSON.parse(res.text) as Record<string, unknown>
  const wins: Win[] = []
  for (const [kind, value] of Object.entries(body)) {
    const w = value as { utilization?: unknown; resets_at?: unknown } | null
    if (isWindowKind(kind) && w && typeof w.utilization === 'number') {
      wins.push({
        kind,
        pct: round1(w.utilization),
        resetsAt: typeof w.resets_at === 'string' ? w.resets_at : undefined,
      })
    }
  }

  // Per-model weeks (Fable) arrive only in `limits`, as `weekly_scoped` with the
  // model's display name; whole percents, as the app's usage card shows them.
  type Limit = {
    kind?: unknown
    percent?: unknown
    resets_at?: unknown
    scope?: { model?: { display_name?: unknown } | null } | null
  }
  const limits = Array.isArray(body.limits) ? (body.limits as Limit[]) : []
  for (const l of limits) {
    const name = l.scope?.model?.display_name
    if (l.kind !== 'weekly_scoped' || typeof name !== 'string' || typeof l.percent !== 'number') {
      continue
    }
    const kind = `seven_day_${name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`
    if (wins.some(w => w.kind === kind)) {
      continue
    }
    wins.push({
      kind,
      label: name,
      pct: round1(l.percent),
      resetsAt: typeof l.resets_at === 'string' ? l.resets_at : undefined,
    })
  }

  return wins.length > 0 ? wins : null
}

/** The windows the last API response of this session reported. */
const headerWins = async ($: $): Promise<Win[]> =>
  (await $.session.usage()).rateLimits.map(r => ({
    kind: r.kind,
    pct: round1(r.percentUsed),
    resetsAt: r.resetsAt,
  }))

const readWindows = async ($: $, isFresh: boolean): Promise<Win[]> => {
  const now = await $.clock.now()
  if (!isFresh && mem.lastFetch && now - mem.lastFetch.at < FETCH_GAP_MS) {
    return mem.lastFetch.wins
  }
  const wins = await fetchOauth($).catch(async (err: unknown) => {
    await noteFailure($, `threw ${err instanceof Error ? err.name : 'error'}`)
    return null
  })
  if (wins) {
    mem.source = 'oauth'
    mem.lastFetch = { at: now, wins }
    const c = await context($)
    await writeJson($, `${c.dir}/reading.json`, { at: now, wins })

    return wins
  }
  // This read alone falls back, to the last good reading while it is recent
  // (headers carry no per-model week); the next read tries the endpoint again.
  const c = await context($)
  const last = await readJson<{ at: number; wins: Win[] }>($, `${c.dir}/reading.json`)
  if (last && now - last.at < CACHED_MAX_MS && last.wins.length > 0) {
    mem.source = 'cached'

    return last.wins
  }
  mem.source = 'headers'

  return headerWins($)
}

/** A reading another chat took under a minute ago, else a fetch of our own. */
const readShared = async ($: $): Promise<Win[]> => {
  const c = await context($)
  const shared = await readJson<{ at: number; wins: Win[] }>($, `${c.dir}/reading.json`)
  if (shared && (await $.clock.now()) - shared.at < SHARED_FRESH_MS && shared.wins.length > 0) {
    mem.source = 'oauth'

    return shared.wins
  }

  return readWindows($, false)
}

/** With LIMIT_METER_DEBUG=1, appends one line to `events.log` (the last 40 kept). */
const logEvent = async ($: $, line: string) => {
  if (!mem.isDebug) {
    return
  }
  const c = await context($)
  const path = `${c.dir}/events.log`
  const held = await $.fs.read(path).catch(() => '')
  const stamp = new Date(await $.clock.now()).toISOString().slice(11, 19)
  const lines = [...held.split('\n').filter(Boolean), `${stamp} ${c.sid.slice(0, 8)} ${line}`]
  await $.fs.write(path, `${lines.slice(-40).join('\n')}\n`)
}

/**
 * Moves the shared ledger to `wins`. `credit` gives the points the account
 * gained since the last reading to this chat; `absorb` gives them to nobody
 * and only when no chat read for a while (usage outside these chats).
 */
const settle = async ($: $, wins: Win[], mode: 'credit' | 'absorb' | 'look') => {
  const c = await context($)
  const ledgerPath = `${c.dir}/ledger.json`
  const ledger = (await readJson<Ledger>($, ledgerPath)) ?? {}
  const rec = await loadRec($)
  const now = await $.clock.now()
  const gains: string[] = []

  for (const w of wins) {
    const held = ledger[w.kind]
    const isSame = held !== undefined && sameWindow(held.resetsAt, w.resetsAt)
    const isStale = held === undefined || !isSame || now - held.at > LEDGER_STALE_MS
    const gain = isSame ? Math.max(0, w.pct - held.pct) : 0

    const mine = rec.used[w.kind]
    const base = mine && sameWindow(mine.resetsAt, w.resetsAt) ? mine.pct : 0
    const credited = mode === 'credit' ? gain : 0
    if (gain > 0) {
      gains.push(`${w.kind}+${round1(gain)}${credited > 0 ? '' : ' (unattributed)'}`)
    }
    rec.used[w.kind] = { pct: round1(base + credited), resetsAt: w.resetsAt }

    if (mode === 'credit' || (mode === 'absorb' && isStale) || !isSame) {
      ledger[w.kind] = {
        pct: isSame ? Math.max(held.pct, w.pct) : w.pct,
        resetsAt: w.resetsAt,
        at: now,
      }
    }
  }

  if (mode !== 'look') {
    await writeJson($, ledgerPath, ledger)
  }
  if (mode === 'credit') {
    rec.lastCreditAt = now
  }
  await saveRec($, rec)
  if (mode !== 'look') {
    await logEvent($, `${mode} (${mem.source}) ${gains.join(', ') || 'no change'}`)
  }

  return rec
}

const readPeers = async ($: $, wins: Win[]): Promise<Peer[]> => {
  const c = await context($)
  const now = await $.clock.now()
  const entries = await $.fs.list(`${c.dir}/sessions`).catch(() => [])
  const fresh = entries.filter(
    f =>
      f.kind === 'file' &&
      f.name.endsWith('.json') &&
      f.name !== `${c.sid}.json` &&
      now - f.mtimeMs < PEER_MAX_AGE_MS,
  )
  const recs = await Promise.all(
    fresh.map(f => readJson<Rec>($, `${c.dir}/sessions/${f.name}`)),
  )
  const peers: Peer[] = []
  for (const rec of recs) {
    if (!rec || rec.project !== c.project || rec.supersededBy || rec.key === c.key) {
      continue
    }
    const used: ChatUse = {}
    for (const w of wins) {
      const u = rec.used[w.kind]
      if (u && u.pct > 0 && sameWindow(u.resetsAt, w.resetsAt)) {
        used[w.kind] = u
      }
    }
    if (Object.keys(used).length > 0) {
      peers.push({ sid: rec.sid, label: rec.label || 'chat', role: rec.role, used })
    }
  }

  return peers.sort(
    (a, b) => (b.used.five_hour?.pct ?? 0) - (a.used.five_hour?.pct ?? 0),
  )
}

/** The context window's fill, as the status line has it; free to read. */
const readFill = async ($: $) => {
  const live = (await $.session.usage()).context
  const next: ContextFill = { tokens: live.tokens, window: live.window, percent: live.percent }
  const held = await read($, contextFill)
  if (held?.tokens !== next.tokens || held?.window !== next.window || held?.percent !== next.percent) {
    await update($, contextFill, () => next)
  }
}

const refresh = async ($: $, mode: 'credit' | 'absorb' | 'look', isFresh: boolean) => {
  try {
    await readFill($)
    // Credit reads its own response's effect, so it never takes another chat's reading.
    const wins = mode === 'look' && !isFresh ? await readShared($) : await readWindows($, isFresh)
    if (wins.length === 0) {
      return
    }
    // Only a live reading moves the ledger: a stale one would hand this chat's
    // points to whoever reads next, and headers mix decimals into whole points.
    const rec = await settle($, wins, mem.source === 'oauth' ? mode : 'look')
    const peers = await readPeers($, wins)
    const c = await context($)
    const next: Snapshot = {
      windows: wins,
      mine: rec.used,
      role: rec.role,
      projectName: c.projectName,
      peers,
      source: mem.source,
      at: await $.clock.now(),
    }
    const held = await read($, snapshot)
    const isSame =
      held !== null &&
      JSON.stringify({ ...held, at: 0 }) === JSON.stringify({ ...next, at: 0 })
    if (!isSame) {
      await update($, snapshot, () => next)
    }
  } catch (err) {
    const c = await context($).catch(() => undefined)
    if (c) {
      await writeJson($, `${c.dir}/last-error.json`, { error: String(err) }).catch(
        () => undefined,
      )
    }
  }
}

/** Runs background work one job at a time, so session-file writes never interleave. */
const queue = (fn: () => Promise<void>) => {
  mem.chain = mem.chain.then(fn).catch(() => undefined)

  return mem.chain
}

const later = ($: $, fn: () => Promise<void>) => {
  $.clock.after(1, () => queue(fn))
}

/** Every few seconds: the context fill, and a redraw when the minute turns. */
const fastTick = async ($: $) => {
  await readFill($)
  const minute = Math.floor((await $.clock.now()) / 60_000)
  if ((await read($, tick)) !== minute) {
    await update($, tick, () => minute)
  }
}

const markThread = async ($: $) => {
  const rec = await loadRec($)
  if (rec.role !== 'thread') {
    await saveRec($, { ...rec, role: 'thread' })
  }
}

const DENSITIES: readonly Density[] = ['small', 'medium', 'high']
const isDensity = (v: unknown): v is Density => DENSITIES.includes(v as Density)

// Mid-tone colors: an Svg is an image, not themed, so each reads on light and dark.
const TRACK = '#8A8A8A'
const NEUTRAL = '#8C96A8'
const AMBER = '#E0A030'
const CORAL = '#E5604D'
const BLUE = '#5B8DEF'

const tone = (pct: number) => (pct >= 90 ? CORAL : pct >= 70 ? AMBER : NEUTRAL)
const textTone = (pct: number) => (pct >= 70 ? tone(pct) : undefined)

const pctText = (n: number) =>
  n > 0 && n < 0.1 ? '<0.1%' : `${n < 10 && n % 1 !== 0 ? n.toFixed(1) : Math.round(n)}%`

const tokensText = (n: number) =>
  n >= 1_000_000
    ? `${n % 1_000_000 === 0 ? n / 1_000_000 : (n / 1_000_000).toFixed(1)}M`
    : `${Math.round(n / 1000)}k`

/** `105k / 1M` and its percent, or null before the window has a reading. */
const fillOf = (f: ContextFill | null) => {
  // Before the first response there is nothing to show yet.
  if (!f || f.window <= 0 || !f.tokens) {
    return null
  }
  const tokens = f.tokens
  const pct = round1(f.percent ?? (tokens / f.window) * 100)

  return { pct, text: `${tokensText(tokens)} / ${tokensText(f.window)}` }
}

const resetIn = (resetsAt: string | undefined, now: number) => {
  const ms = resetsAt === undefined ? NaN : Date.parse(resetsAt) - now
  if (!(ms > 0)) {
    return ''
  }
  const mins = Math.ceil(ms / 60_000)
  const days = Math.floor(mins / 1440)
  const hours = Math.floor((mins % 1440) / 60)

  return days > 0 ? `${days}d ${hours}h` : hours > 0 ? `${hours}h ${mins % 60}m` : `${mins}m`
}

/** A ring gauge as an Svg source; `label` is drawn in its middle. */
const ringSvg = (pct: number, size: number, stroke: number, label?: string) => {
  const c = size / 2
  const r = (size - stroke) / 2
  const len = 2 * Math.PI * r
  const fill = (len * Math.min(100, Math.max(0, pct))) / 100
  const arc =
    fill > 0.01
      ? `<circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${tone(pct)}" stroke-width="${stroke}" stroke-linecap="round" stroke-dasharray="${fill.toFixed(2)} ${len.toFixed(2)}" transform="rotate(-90 ${c} ${c})"/>`
      : ''
  const text = label
    ? `<text x="${c}" y="${c}" text-anchor="middle" dominant-baseline="central" font-family="system-ui, -apple-system, sans-serif" font-size="${Math.round(size * 0.26)}" font-weight="600" fill="${tone(pct)}">${label}</text>`
    : ''

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${TRACK}" stroke-opacity="0.3" stroke-width="${stroke}"/>${arc}${text}</svg>`
}

type Row = {
  kind: string
  short: string
  name: string
  pct: number
  chat: number
  project: number
  reset: string
}

const nameOf = (w: Win) =>
  w.kind === 'five_hour'
    ? '5-hour'
    : w.kind === 'seven_day'
      ? 'Weekly'
      : (w.label ?? w.kind.replace(/^seven_day_/, '').replace(/^./, ch => ch.toUpperCase()))

const shortOf = (w: Win) =>
  w.kind === 'five_hour' ? '5h' : w.kind === 'seven_day' ? 'W' : nameOf(w).charAt(0)

const orderOf = (kind: string) => (kind === 'five_hour' ? 0 : kind === 'seven_day' ? 1 : 2)

const rowsOf = (snap: Snapshot, now: number): Row[] =>
  [...snap.windows]
    .sort((a, b) => orderOf(a.kind) - orderOf(b.kind))
    .map(w => {
      const chat = snap.mine[w.kind]?.pct ?? 0

      return {
        kind: w.kind,
        short: shortOf(w),
        name: nameOf(w),
        pct: w.pct,
        chat,
        project: snap.peers.reduce((sum, p) => sum + (p.used[w.kind]?.pct ?? 0), chat),
        reset: resetIn(w.resetsAt, now),
      }
    })

/** `⤷ Checkout flow  3% / 1%`: a peer's first two windows. */
const peerLine = (p: Peer, rows: Row[]) =>
  `${p.role === 'thread' ? '⤷' : '·'} ${p.label}  ${rows
    .slice(0, 2)
    .map(r => pctText(p.used[r.kind]?.pct ?? 0))
    .join(' / ')}`

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    mem.ctx = undefined
    mem.lastActiveAt = await $.clock.now()
    mem.isDebug = (await $.env.get('LIMIT_METER_DEBUG')) === '1'
    await $.command.register({
      name: 'limit-meter',
      description: 'Size of the limits band: small, medium or high',
      argumentHint: 'small | medium | high',
    })
    const stored = await $.store.get('density')
    const chosen: Density = isDensity(stored)
      ? stored
      : isDensity(options.density)
        ? options.density
        : 'medium'
    await update($, density, () => chosen)
    later($, async () => {
      const c = await context($)
      const held = await readJson<Rec>($, recPath(c))
      const isFresh = held !== undefined && (await $.clock.now()) - held.updatedAt < LEDGER_STALE_MS
      await logEvent($, `session.start ${isFresh ? 'reload' : 'new'}`)
      await adoptEarlier($)
      await refresh($, isFresh ? 'look' : 'absorb', true)
      $.clock.every(FAST_MS, () => void fastTick($))
      $.clock.every(POLL_MS, () => {
        mem.polls += 1
        void queue(async () => {
          const isIdle = !mem.isTurnActive && (await $.clock.now()) - mem.lastActiveAt > IDLE_MS
          if (!isIdle || mem.polls % IDLE_POLL_EVERY === 0) {
            await refresh($, 'look', false)
          }
        })
      })
    })

    return next(e)
  })

  on('command.run', { command: 'limit-meter' }, async ($, e) => {
    const want = e.args.trim().toLowerCase()
    if (!isDensity(want)) {
      const current = await read($, density)

      return { text: `Limits band is ${current}. Usage: /limit-meter small | medium | high` }
    }
    await $.store.set('density', want)
    await update($, density, () => want)

    return { text: `Limits band: ${want}` }
  })

  on('prompt.submit', async ($, e, next) => {
    const kind = e.origin.kind
    const wasActive = mem.isTurnActive
    mem.isTurnActive = true
    mem.lastActiveAt = await $.clock.now()
    later($, async () => {
      if (kind === 'coordinator' || kind === 'projects-relay') {
        await markThread($)
      }
      if (kind === 'composer' || kind === 'bridge') {
        const rec = await loadRec($)
        if (!rec.label) {
          const line = e.text.trim().split('\n')[0] ?? ''
          const label = line.length > 22 ? `${line.slice(0, 21)}…` : line
          await saveRec($, { ...rec, label })
        }
      }
      // Points gained while this chat sat idle were spent elsewhere: give them
      // to nobody. Mid-turn, or soon after its last credit, they may be ours.
      const rec = await loadRec($)
      const isIdle =
        !wasActive && (await $.clock.now()) - (rec.lastCreditAt ?? rec.startedAt) > LEDGER_STALE_MS
      await refresh($, isIdle ? 'absorb' : 'look', true)
    })

    return next(e)
  })

  on('session.receive', async ($, e, next) => {
    if (e.origin.kind === 'projects-relay' || e.origin.kind === 'coordinator') {
      later($, () => markThread($))
    }

    return next(e)
  })

  // Credit is awaited in the hook, never left on a timer a reload would cancel.
  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      mem.isTurnActive = false
      mem.lastActiveAt = await $.clock.now()
      await queue(async () => {
        await logEvent($, 'turn.complete')
        await refresh($, 'credit', true)
      })
    }

    return next(e)
  })

  // This chat's own response moved a window a whole point: credit it now.
  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits')) {
      await queue(async () => {
        await logEvent($, `session.measure ${e.changed.join(',')}`)
        await refresh($, 'credit', true)
      })
    } else if (e.changed.includes('context')) {
      await readFill($)
    }

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const snap = await read($, snapshot)
    if (e.props.hasSurvey || !snap || snap.windows.length === 0) {
      return next(e)
    }
    const size = await read($, density)
    const rows = rowsOf(snap, await $.clock.now())
    const ctx = fillOf(await read($, contextFill))
    await read($, tick)
    const hasPeers = snap.peers.length > 0
    const showPeers = hasPeers && snap.role !== 'thread'
    const peers = snap.peers.slice(0, PEERS_SHOWN)
    const peerTitle = snap.peers.some(p => p.role === 'thread')
      ? `${snap.projectName} · threads`
      : `${snap.projectName} · other chats`

    // The terminal has no Svg: a monospace table, sized to the width it has.
    if (e.surface === 'terminal') {
      const { Box, Text } = $.ui.resolve(e)
      const columns = e.viewport?.columns ?? 80
      const hasProject = size === 'high' && hasPeers
      const peerRows = size === 'high' && showPeers ? peers : []
      const tableRows =
        rows.length + (ctx ? 1 : 0) + (peerRows.length > 0 ? peerRows.length + 1 : 0)
      const isTable = size !== 'small' && columns >= 40 && e.props.maxRows >= tableRows

      if (!isTable) {
        return (
          <Text wrap="truncate-end">
            {rows.map((r, i) => (
              <Text key={r.kind}>
                {i > 0 && <Text dimColor> · </Text>}
                <Text dimColor>{r.short} </Text>
                <Text bold color={textTone(r.pct)}>
                  {pctText(r.pct)}
                </Text>
                <Text color={BLUE}> {pctText(r.chat)}</Text>
              </Text>
            ))}
            {ctx && <Text dimColor> │ ctx </Text>}
            {ctx && (
              <Text bold color={textTone(ctx.pct)}>
                {pctText(ctx.pct)}
              </Text>
            )}
          </Text>
        )
      }

      // Cells per column; the bar takes what is left, minus room for the [-] control.
      const LABEL = 9
      const PCT = 5
      const MIDDLE = 14
      const CHAT = 17
      const PROJECT = 15
      const isWide = columns >= 60
      const fixed =
        LABEL + PCT + (isWide ? MIDDLE : 0) + CHAT + (hasProject ? PROJECT : 0) + 8
      const bar = isWide ? Math.max(8, Math.min(28, columns - fixed)) : 0

      const line = (
        id: string,
        label: string,
        pct: number,
        middle: string,
        chat?: number,
        project?: number,
      ) => {
        const filled = Math.min(bar, Math.round((bar * pct) / 100))

        return (
          <Box key={id} flexDirection="row">
            <Box width={LABEL}>
              <Text dimColor wrap="truncate-end">
                {label}
              </Text>
            </Box>
            {bar > 0 && (
              <Box width={bar + 1}>
                <Text>
                  <Text color={tone(pct)}>{'━'.repeat(filled)}</Text>
                  <Text dimColor>{'─'.repeat(bar - filled)}</Text>
                </Text>
              </Box>
            )}
            <Box width={PCT} justifyContent="flex-end">
              <Text bold color={textTone(pct)}>
                {pctText(pct)}
              </Text>
            </Box>
            {isWide && (
              <Box width={MIDDLE} paddingLeft={3}>
                <Text dimColor wrap="truncate-end">
                  {middle}
                </Text>
              </Box>
            )}
            <Box width={CHAT} paddingLeft={3}>
              {chat !== undefined ? (
                <Text color={BLUE} wrap="truncate-end">
                  this chat {pctText(chat)}
                </Text>
              ) : (
                !isWide && (
                  <Text dimColor wrap="truncate-end">
                    {middle}
                  </Text>
                )
              )}
            </Box>
            {hasProject && (
              <Box width={PROJECT}>
                {project !== undefined && (
                  <Text dimColor wrap="truncate-end">
                    project {pctText(project)}
                  </Text>
                )}
              </Box>
            )}
          </Box>
        )
      }

      return (
        <Box flexDirection="column">
          {rows.map(r => line(r.kind, r.name, r.pct, r.reset, r.chat, r.project))}
          {ctx && line('context', 'Context', ctx.pct, ctx.text)}
          {peerRows.length > 0 && (
            <Text dimColor wrap="truncate-end">
              {peerTitle}
            </Text>
          )}
          {peerRows.map(p => (
            <Text key={p.sid} dimColor wrap="truncate-end">
              {'  '}
              {peerLine(p, rows)}
            </Text>
          ))}
        </Box>
      )
    }

    const { Box, Text, Svg } = $.ui.resolve(e)
    const ring = size === 'small' ? 14 : size === 'medium' ? 30 : 52
    const stroke = size === 'small' ? 3 : size === 'medium' ? 4 : 5
    const isLabelled = size === 'high'
    const ruleHeight = size === 'small' ? 16 : size === 'medium' ? 36 : 56

    // Equal columns: each grows from zero, so text length never shifts a ring.
    const Cell = (props: { id: string; pct: number; name: string; children: RenderChildren }) => (
      <Box key={props.id} flexDirection="row" flexGrow={1} width={0} columnGap={1} alignItems="center">
        <Svg
          source={ringSvg(props.pct, ring, stroke, isLabelled ? pctText(props.pct) : undefined)}
          alt={`${props.name} ${pctText(props.pct)}`}
          width={ring}
          height={ring}
        />
        {props.children}
      </Box>
    )

    const windowCells = rows.map(r =>
      Cell({
        id: r.kind,
        pct: r.pct,
        name: r.name,
        children:
          size === 'small' ? (
            <Text>
              <Text dimColor>{r.short} </Text>
              <Text bold color={textTone(r.pct)}>
                {pctText(r.pct)}
              </Text>
              <Text color={BLUE}> {pctText(r.chat)}</Text>
            </Text>
          ) : size === 'medium' ? (
            <Box flexDirection="column">
              <Text>
                <Text dimColor>{r.name} </Text>
                <Text bold color={textTone(r.pct)}>
                  {pctText(r.pct)}
                </Text>
              </Text>
              <Text>
                <Text color={BLUE}>this chat {pctText(r.chat)}</Text>
                {r.reset !== '' && <Text dimColor> · {r.reset}</Text>}
              </Text>
            </Box>
          ) : (
            <Box flexDirection="column">
              <Text bold>{r.name}</Text>
              <Text color={BLUE}>this chat {pctText(r.chat)}</Text>
              <Text dimColor>
                {hasPeers ? `project ${pctText(r.project)}` : ''}
                {hasPeers && r.reset !== '' ? ' · ' : ''}
                {r.reset}
              </Text>
            </Box>
          ),
      }),
    )

    const contextCell =
      ctx &&
      Cell({
        id: 'context',
        pct: ctx.pct,
        name: 'Context',
        children:
          size === 'small' ? (
            <Text>
              <Text dimColor>ctx </Text>
              <Text bold color={textTone(ctx.pct)}>
                {pctText(ctx.pct)}
              </Text>
              <Text dimColor> {ctx.text}</Text>
            </Text>
          ) : size === 'medium' ? (
            <Box flexDirection="column">
              <Text>
                <Text dimColor>Context </Text>
                <Text bold color={textTone(ctx.pct)}>
                  {pctText(ctx.pct)}
                </Text>
              </Text>
              <Text dimColor>{ctx.text}</Text>
            </Box>
          ) : (
            <Box flexDirection="column">
              <Text bold>Context</Text>
              <Text dimColor>{ctx.text}</Text>
            </Box>
          ),
      })

    const ringRow = (
      <Box key="rings" flexDirection="row" columnGap={2} alignItems="center">
        {windowCells}
        {contextCell && (
          <Svg
            key="rule"
            source={`<svg xmlns="http://www.w3.org/2000/svg" width="1" height="${ruleHeight}" viewBox="0 0 1 ${ruleHeight}"><rect width="1" height="${ruleHeight}" fill="${TRACK}" fill-opacity="0.45"/></svg>`}
            alt="divider"
            width={1}
            height={ruleHeight}
          />
        )}
        {contextCell}
      </Box>
    )
    if (size !== 'high' || !showPeers) {
      return ringRow
    }

    // The project's other chats go under the rings, so the columns keep their width.
    return (
      <Box flexDirection="column" rowGap={1}>
        {ringRow}
        <Box flexDirection="row" flexWrap="wrap" columnGap={4}>
          <Text dimColor>{peerTitle}</Text>
          {peers.map(p => (
            <Text key={p.sid} dimColor wrap="truncate-end">
              {peerLine(p, rows)}
            </Text>
          ))}
          {snap.peers.length > peers.length && (
            <Text dimColor>+{snap.peers.length - peers.length} more</Text>
          )}
        </Box>
      </Box>
    )
  })
}

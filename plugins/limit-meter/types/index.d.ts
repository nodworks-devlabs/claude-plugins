/** One account-wide limit window: `five_hour`, `seven_day`, `seven_day_<model>` (with the model's name as `label`). */
export type Win = { kind: string; label?: string; pct: number; resetsAt?: string }

/** Points of each window credited to one chat, per window instance. */
export type ChatUse = Record<string, { pct: number; resetsAt?: string }>

export type Role = 'chat' | 'thread'

/** How much the band shows: one row, two, or rings with the project's chats. */
export type Density = 'small' | 'medium' | 'high'

/** Another chat in the same project, as its session file has it. */
export type Peer = { sid: string; label: string; role: Role; used: ChatUse }

/** The live context window: tokens the last response was answered over, of `window`. */
export type ContextFill = { tokens?: number; window: number; percent?: number }

export type Snapshot = {
  windows: Win[]
  mine: ChatUse
  role: Role
  projectName: string
  peers: Peer[]
  /** `cached`: the endpoint failed and the last good reading stands in. */
  source: 'oauth' | 'cached' | 'headers'
  at: number
}

declare module 'claude-code' {
  interface PluginState {
    'limit-meter': { snapshot: Snapshot | null; density: Density; fill: ContextFill | null; tick: number }
  }
}

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Hook, On, PluginOptions, Register, RenderInput } from 'claude-code'

import type { AgentCard, Architect, Bucket, Check, Gate, Layout, LogLine, Loop, Main, Roster, Turn, Usage, View } from '../types'
import type { AgentRun, Flow, Phase, PlannedTask, SavvyPanel } from '../types'
import {
  DEFAULT_ARCHITECT,
  DEFAULT_GATE,
  DEFAULT_MAIN,
  DEFAULT_ROSTER,
  DEFAULT_TURN,
  DEFAULT_USAGE,
  DEFAULT_VIEW,
  EDIT_TOOLS,
  SCHEMA_VERSION,
  afterCall,
  applyStep,
  bucketOf,
  cardTitle,
  titleLines,
  consultTimeline,
  describeInput,
  endConsult,
  fitLegend,
  fmtClock,
  fmtDuration,
  fmtTimer,
  fmtUsd,
  plural,
  gateSummary,
  gauge,
  isAdvising,
  isLoopActive,
  kTokens,
  lanes,
  limitLabel,
  listOf,
  logRows,
  momentOf,
  normalize,
  normalizeCard,
  normalizeGate,
  normalizeLog,
  noteTool,
  PALETTES,
  parseConfig,
  prettyModel,
  promptLine,
  handbackOf,
  adviceLine,
  receiptOf,
  recordCheck,
  settleCheck,
  shorten,
  startConsult,
  stepLoop,
} from './core'
import type { Config, Panel } from './core'

const PANE = 'control-tower'
const TITLE = 'Control Tower'
const PANE_COLUMNS = 66


// ---------------------------------------------------------------- state

const meta = atom({ plugin: 'control-tower', key: 'meta' } as const, { schemaVersion: SCHEMA_VERSION })
const main = atom({ plugin: 'control-tower', key: 'main' } as const, DEFAULT_MAIN)
const usage = atom({ plugin: 'control-tower', key: 'usage' } as const, DEFAULT_USAGE)
const architect = atom({ plugin: 'control-tower', key: 'architect' } as const, DEFAULT_ARCHITECT)
const gate = atom({ plugin: 'control-tower', key: 'gate' } as const, DEFAULT_GATE)
const agents = atom({ plugin: 'control-tower', key: 'agents' } as const, [])
const loops = atom({ plugin: 'control-tower', key: 'loops' } as const, [])
const log = atom({ plugin: 'control-tower', key: 'log' } as const, [])
const turn = atom({ plugin: 'control-tower', key: 'turn' } as const, DEFAULT_TURN)
const receipt = atom({ plugin: 'control-tower', key: 'receipt' } as const, null)
const view = atom({ plugin: 'control-tower', key: 'view' } as const, DEFAULT_VIEW)
const roster = atom({ plugin: 'control-tower', key: 'roster' } as const, DEFAULT_ROSTER)

type ServerBlock = { type: string; id?: string; name?: string; tool_use_id?: string }

// Every read goes through these, so a value saved under an older shape still reads.
async function getMain($: EngineInterface): Promise<Main> {
  return normalize(DEFAULT_MAIN, await read($, main))
}
async function getUsage($: EngineInterface): Promise<Usage> {
  return normalize(DEFAULT_USAGE, await read($, usage))
}
async function getArchitect($: EngineInterface): Promise<Architect> {
  const a = normalize(DEFAULT_ARCHITECT, await read($, architect))
  return { ...a, consults: listOf(a.consults), ids: listOf(a.ids), seen: listOf(a.seen) }
}
async function getGate($: EngineInterface): Promise<Gate> {
  return normalizeGate(await read($, gate))
}
async function getCards($: EngineInterface): Promise<AgentCard[]> {
  return listOf<unknown>(await read($, agents)).map(normalizeCard)
}
async function getLoops($: EngineInterface): Promise<Loop[]> {
  return listOf<Loop>(await read($, loops))
}
async function getLog($: EngineInterface): Promise<LogLine[]> {
  return normalizeLog(await read($, log))
}
async function getTurn($: EngineInterface): Promise<Turn> {
  return normalize(DEFAULT_TURN, await read($, turn))
}
async function getView($: EngineInterface): Promise<View> {
  return normalize(DEFAULT_VIEW, await read($, view))
}
async function getRoster($: EngineInterface): Promise<Roster> {
  const r = normalize(DEFAULT_ROSTER, await read($, roster))
  return { architectTypes: listOf(r.architectTypes) }
}

/** A stored shape older than this build's: drop what cannot be read, keep the rest. */
async function migrate($: EngineInterface) {
  const m = await read($, meta)
  if ((m?.schemaVersion ?? 0) >= SCHEMA_VERSION) return
  await update($, log, list => normalizeLog(list))
  await update($, agents, list => listOf<unknown>(list).map(normalizeCard))
  await update($, gate, g => normalizeGate(g))
  await update($, meta, () => ({ schemaVersion: SCHEMA_VERSION }))
}

async function say($: EngineInterface, who: string, text: string, kind: LogLine['kind'] = 'info', agentId: string | null = null) {
  const line: LogLine = { at: await $.clock.now(), who, text, kind, agentId }
  await update($, log, list => [...normalizeLog(list), line].slice(-60))
}

async function refreshStatus($: EngineInterface, cfg: Config) {
  if (!cfg.statusLine) return $.ui.status(undefined)
  const [u, a, g, cards] = await Promise.all([getUsage($), getArchitect($), getGate($), getCards($)])
  const running = cards.filter(c => c.status === 'running').length
  const s = gateSummary(g)
  const parts = [
    u.pct !== null ? `ctx ${Math.round(u.pct)}%` : null,
    cards.length > 0 ? `agents ${running}/${cards.length}` : null,
    a.consults.length > 0 || a.ids.length > 0 ? `${cfg.architectLabel.toLowerCase()} ${isAdvising(a) ? 'advising' : a.consults.length}` : null,
    s.deny > 0 ? `denied ${s.deny}` : null,
  ]
  // Only fields with something to say; with none, no status entry at all.
  const shown = parts.filter(Boolean)
  $.ui.status(shown.length > 0 ? shown.join(' · ') : undefined)
}

async function whoIs($: EngineInterface, agentId: string | undefined) {
  if (!agentId) return 'main'
  const card = (await getCards($)).find(c => c.id === agentId)
  return card ? shorten(cardTitle(card), 14) : 'agent'
}

async function consultStarted($: EngineInterface, cfg: Config, id: string, via: string) {
  const t = await getTurn($)
  const moment = momentOf(t)
  const at = await $.clock.now()
  await update($, architect, a => startConsult(normalize(DEFAULT_ARCHITECT, a), { id, at, moment, via }))
  if (moment === 'before done') await update($, turn, x => ({ ...normalize(DEFAULT_TURN, x), isReviewing: true }))
  await say($, cfg.architectLabel.toLowerCase(), cfg.moments ? `${moment} · ${via}` : `consulted · ${via}`, 'consult')
  await refreshStatus($, cfg)
}

async function consultEnded($: EngineInterface, cfg: Config, advice: string | null, id?: string) {
  const at = await $.clock.now()
  const first = advice?.split('\n').find(l => l.trim()) ?? null
  const text = first ? shorten(first.replace(/^[#>*\s-]+/, ''), 160) : null
  await update($, architect, a => endConsult(normalize(DEFAULT_ARCHITECT, a), at, text, id))
  await update($, turn, t => ({ ...normalize(DEFAULT_TURN, t), isReviewing: false }))
  await say($, cfg.architectLabel.toLowerCase(), text ? `advice: ${shorten(text, 60)}` : 'advice returned', 'consult')
  await refreshStatus($, cfg)
}

async function noteAdvice($: EngineInterface, cfg: Config, advice: string) {
  await update($, architect, x => ({ ...normalize(DEFAULT_ARCHITECT, x), lastAdvice: advice }))
  await say($, cfg.architectLabel.toLowerCase(), `advice: ${shorten(advice, 60)}`, 'consult')
}

async function isArchitectType($: EngineInterface, cfg: Config, type: string) {
  return cfg.architect.test(type) || (await getRoster($)).architectTypes.includes(type)
}

async function openPane($: EngineInterface) {
  // columns apply when docked beside the transcript, rows when seated inline above the prompt.
  return $.ui.open({ id: PANE, title: TITLE, columns: PANE_COLUMNS, rows: 8 })
}

async function resetAll($: EngineInterface) {
  await update($, main, m => ({ ...DEFAULT_MAIN, model: normalize(DEFAULT_MAIN, m).model, mode: normalize(DEFAULT_MAIN, m).mode }))
  await update($, architect, () => DEFAULT_ARCHITECT)
  await update($, gate, () => DEFAULT_GATE)
  await update($, agents, () => [])
  await update($, loops, () => [])
  await update($, log, () => [])
  await update($, turn, () => DEFAULT_TURN)
  await update($, receipt, () => null)
  await update($, view, () => DEFAULT_VIEW)
  await update($, runs, () => [])
  await update($, flow, () => null)
  // The context gauge waits for the next measurement rather than showing the pre-clear fill.
  await update($, usage, x => ({ ...normalize(DEFAULT_USAGE, x), pct: null, tokens: null }))
}

/** The session's cost read fresh, not from the last measurement: the receipt subtracts two of these. */
async function costNow($: EngineInterface): Promise<number | null> {
  const u = await $.session.usage().catch(() => null)
  return u?.cost?.usd ?? null
}

async function noteMode($: EngineInterface, mode: string | undefined) {
  if (mode) await update($, main, m => (normalize(DEFAULT_MAIN, m).mode === mode ? normalize(DEFAULT_MAIN, m) : { ...normalize(DEFAULT_MAIN, m), mode }))
}

// ---------------------------------------------------------------- savvy-progress

const flow = atom({ plugin: 'control-tower', key: 'flow' } as const, null)
const runs = atom({ plugin: 'control-tower', key: 'runs' } as const, [])
const panel = atom({ plugin: 'control-tower', key: 'savvyPanel' } as const, {
  isCompact: false,
  isDoneCollapsed: false,
  autoOpenedFor: '',
})
const savvyNow = atom({ plugin: 'control-tower', key: 'now' } as const, 0)

const TOOL = 'mcp__control-tower__progress'
const STEP_TOOL = 'mcp__control-tower__step'
const PHASES: readonly Phase[] = ['plan', 'design', 'delegate', 'review', 'close']
const ACCENT = '#8f8cf4'
const DONE = '#5fbf8f'

type ProgressInput = {
  title?: string
  total?: number
  done?: number
  phase?: Phase
  finished?: boolean
  tasks?: { title?: string; tier?: string; after?: number[] }[]
}

// ---------------------------------------------------------------------------
// Language: the `language` option, else Claude Code's `language` setting, else the
// process locale; English when nothing says Russian.

type Lang = 'en' | 'ru'

const STRINGS = {
  en: {
    pane: 'Agents',
    cost: 'Cost',
    tokens: 'Tokens',
    time: 'Time',
    collapse: 'Collapse',
    expand: 'Expand',
    running: 'Running',
    finished: 'Finished',
    planned: 'Planned',
    empty: 'No subagents yet.',
    round: 'round',
    failed: 'error',
    after: 'after',
    tokensWord: 'tokens',
    agentsCount: 'agents',
    isRunning: 'running',
    isFinished: 'finished',
    isPlanned: 'planned',
    opened: 'Agents panel opened.',
    closed: 'Agents panel closed.',
    done: 'Done',
    plan: 'Plan',
    design: 'Design',
    tasks: 'Tasks',
    review: 'Review',
    busy: 'running',
  },
  ru: {
    pane: 'Агенты',
    cost: 'Стоимость',
    tokens: 'Токены',
    time: 'Время',
    collapse: 'Свернуть',
    expand: 'Развернуть',
    running: 'Работают',
    finished: 'Завершены',
    planned: 'Запланированы',
    empty: 'Субагентов пока нет.',
    round: 'раунд',
    failed: 'ошибка',
    after: 'после',
    tokensWord: 'токенов',
    agentsCount: 'агентов',
    isRunning: 'работает',
    isFinished: 'завершён',
    isPlanned: 'запланирована',
    opened: 'Панель агентов открыта.',
    closed: 'Панель агентов закрыта.',
    done: 'Готово',
    plan: 'План',
    design: 'Дизайн',
    tasks: 'Задачи',
    review: 'Ревью',
    busy: 'в работе',
  },
} as const

// Module scope is fine here: session.start sets it again on every (re)load.
let lang: Lang = 'en'
const tr = () => STRINGS[lang]

const isRussian = (v: unknown): boolean => typeof v === 'string' && /^(ru|russian|рус)/i.test(v.trim())

async function detectLang($: EngineInterface, option: unknown): Promise<Lang> {
  if (option === 'en' || option === 'ru') return option
  try {
    const settings = (await $.settings.read()) as Record<string, unknown>
    if (typeof settings.language === 'string' && settings.language.trim()) return isRussian(settings.language) ? 'ru' : 'en'
  } catch {
    // No settings: fall through to the locale.
  }
  const locale = (await $.env.get('LC_ALL')) || (await $.env.get('LC_MESSAGES')) || (await $.env.get('LANG'))
  return isRussian(locale) ? 'ru' : 'en'
}

const blank = (): Flow => ({
  title: 'savvy-flow',
  total: 0,
  done: 0,
  running: 0,
  phase: 'plan',
  isFinished: false,
  tasks: [],
})

const isNewFlow = (prev: Flow | null, input: ProgressInput): boolean =>
  !prev || prev.isFinished || (input.title !== undefined && input.title.trim() !== prev.title)

const cleanTasks = (tasks: ProgressInput['tasks']): PlannedTask[] | undefined =>
  tasks
    ?.filter(t => t.title?.trim())
    .map(t => ({
      title: (t.title ?? '').trim(),
      tier: (t.tier ?? '').replace(/^savvy-/, '').trim().toLowerCase(),
      after: (t.after ?? []).filter(n => Number.isInteger(n) && n > 0),
    }))

const merge = (prev: Flow | null, input: ProgressInput): Flow => {
  // A new title means a new flow: never carry counters over from an earlier one.
  const base = isNewFlow(prev, input) || !prev ? blank() : { ...blank(), ...prev }
  const tasks = cleanTasks(input.tasks) ?? base.tasks
  const total = Math.max(0, Math.round(input.total ?? (input.tasks ? tasks.length : base.total)))
  const done = Math.min(total || Infinity, Math.max(0, Math.round(input.done ?? base.done)))
  const phase = input.phase && PHASES.includes(input.phase) ? input.phase : base.phase
  return {
    ...base,
    title: input.title?.trim() || base.title,
    total,
    done,
    phase: input.finished ? 'close' : phase,
    isFinished: input.finished === true,
    tasks,
  }
}

const label = (f: Flow): string => {
  const s = tr()
  if (f.isFinished) return s.done
  if (f.phase === 'plan') return s.plan
  if (f.phase === 'design') return s.design
  const count = f.total ? `${f.done}/${f.total}` : `${f.running} ${s.busy}`
  return `${f.phase === 'review' ? s.review : s.tasks} ${count}`
}

const ratio = (f: Flow): number => (f.isFinished ? 1 : f.total ? f.done / f.total : 0)

// Deterministic noise so the dither does not shimmer between redraws.
const noise = (x: number, y: number): number => {
  const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453
  return s - Math.floor(s)
}

// The whole row is one SVG: the desktop wraps sibling elements onto new lines,
// so title, bar, percent and the crab live in one drawing; only the count and
// the dismiss are Buttons beside it.
const H = 22
const BAR_H = 16
const CRAB_W = 26
const CELL = 3
const FONT = "-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',sans-serif"

const xml = (s: string): string =>
  s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c)

const clip = (s: string, max: number): string => (s.length > max ? s.slice(0, Math.max(1, max - 1)) + '…' : s)

// Rough advance of system UI text, in em; good enough to size the title's slot.
const charEm = (ch: string): number =>
  /[\s.,:;'|!il1()[\]]/.test(ch) ? 0.3 : /[A-ZА-ЯЁmwшщжюМШЩЖЮ@%]/.test(ch) ? 0.72 : 0.56

const textWidth = (s: string, size: number): number => [...s].reduce((w, ch) => w + charEm(ch) * size, 0)

// Cuts `s` to fit `maxW` pixels, with an ellipsis when it had to cut.
const fitText = (s: string, size: number, maxW: number): string => {
  if (textWidth(s, size) <= maxW) return s
  let out = ''
  for (const ch of s) {
    if (textWidth(out + ch + '…', size) > maxW) break
    out += ch
  }
  return out + '…'
}

const rowSvg = (f: Flow, W: number, isWorking: boolean): string => {
  // The title takes what it needs, up to 40% of the row; the bar takes the rest.
  const title = fitText(f.title, 13, Math.max(60, W * 0.4))
  const BAR_X = Math.round(16 + textWidth(title, 13) + 12)
  const BAR_W = Math.max(60, W - BAR_X - 46 - CRAB_W)
  const color = f.isFinished ? DONE : ACCENT
  const y0 = (H - BAR_H) / 2
  const fillW = Math.round(BAR_W * ratio(f))
  const runW = f.total ? Math.round((BAR_W * Math.min(f.total, f.done + f.running)) / f.total) : 0
  const dots: string[] = []

  // Dithered fill: sparse at the start, dense toward the head.
  const cols = Math.floor(fillW / CELL)
  const rows = Math.floor(BAR_H / CELL)
  for (let c = 0; c < cols; c++) {
    const density = 0.35 + 0.6 * Math.pow(c / Math.max(1, cols), 1.2)
    for (let r = 0; r < rows; r++) {
      if (noise(c, r) < density) dots.push(`<rect class="t${Math.floor(noise(r, c) * 4)}" x="${c * CELL + 1}" y="${r * CELL + 1}" width="2" height="2"/>`)
    }
  }
  // Handed to workers, not yet accepted: a faint second layer.
  const faint: string[] = []
  for (let c = cols; c < Math.floor(runW / CELL); c++) {
    for (let r = 0; r < rows; r++) {
      if (noise(c + 7, r + 3) < 0.2) faint.push(`<rect class="t${Math.floor(noise(r + 5, c) * 4)}" x="${c * CELL + 1}" y="${r * CELL + 1}" width="1.7" height="1.7"/>`)
    }
  }

  const ticks: string[] = []
  for (let i = 1; i < f.total; i++) {
    const x = Math.round((BAR_W * i) / f.total)
    if (x > fillW + 4) ticks.push(`<rect x="${x}" y="${BAR_H / 2 - 4}" width="1.5" height="8" rx="0.75"/>`)
  }

  const text = label(f)
  const pillW = Math.round(18 + text.length * 6.6)
  const pillX = Math.max(0, Math.min(BAR_W - pillW, fillW - pillW))
  const percent = `${Math.round(ratio(f) * 100)}%`

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<style>
.t{fill:#1f1f1f}.m{fill:#8a8a8a}.k{fill:#e4e4e2}.tk{fill:#b4b4b0}
@media (prefers-color-scheme: dark){.t{fill:#ececec}.m{fill:#9a9a9a}.k{fill:#2c2c2c}.tk{fill:#5a5a5a}}
/* Pixels twinkle in four out-of-phase groups; a finished bar settles to a slow glow. */
.t0,.t1,.t2,.t3{animation:tw ${f.isFinished ? 3.2 : 2.2}s ease-in-out infinite}
.t1{animation-duration:${f.isFinished ? 3.8 : 2.8}s;animation-delay:-.7s}.t2{animation-duration:${f.isFinished ? 4.4 : 1.9}s;animation-delay:-1.3s}.t3{animation-duration:${f.isFinished ? 3.5 : 3.3}s;animation-delay:-.4s}
@keyframes tw{0%,100%{opacity:1}50%{opacity:${f.isFinished ? 0.8 : 0.3}}}
@media (prefers-reduced-motion: reduce){.t0,.t1,.t2,.t3{animation:none}}
</style>
<defs><clipPath id="c"><rect x="0" y="0" width="${BAR_W}" height="${BAR_H}" rx="${BAR_H / 2}"/></clipPath></defs>
<circle cx="5" cy="${H / 2}" r="4" fill="${color}"/>
<text class="t" x="16" y="${H / 2 + 4.5}" font-family="${FONT}" font-size="13" font-weight="500">${xml(title)}</text>
<g transform="translate(${BAR_X},${y0})">
<rect class="k" width="${BAR_W}" height="${BAR_H}" rx="${BAR_H / 2}"/>
<g clip-path="url(#c)">
<g fill="${color}">${dots.join('')}</g>
<g fill="${color}" opacity="0.45">${faint.join('')}</g>
<g class="tk">${ticks.join('')}</g>
</g>
<rect x="${pillX}" width="${pillW}" height="${BAR_H}" rx="${BAR_H / 2}" fill="${color}"/>
<text x="${pillX + pillW / 2}" y="${BAR_H / 2 + 4}" text-anchor="middle" font-family="${FONT}" font-size="11" font-weight="600" fill="#ffffff">${xml(text)}</text>
</g>
<text class="m" x="${W - CRAB_W - 6}" y="${H / 2 + 4.5}" text-anchor="end" font-family="${FONT}" font-size="12.5" font-variant-numeric="tabular-nums">${percent}</text>
${CRAB_CSS}${crab(W - CRAB_W + 1, 0, 'other', false, isWorking, 0.8)}
</svg>`
}

const barText = (f: Flow, width: number): string => {
  const filled = Math.round(width * ratio(f))
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled))
}

// ---------------------------------------------------------------------------
// Agents panel: every subagent of the session, plus the tasks the flow planned.

const TIER_COLOR: Record<string, string> = {
  fable: '#7F77DD',
  heavy: '#D85A30',
  careful: '#BA7517',
  medium: '#378ADD',
  light: '#1D9E75',
  other: '#888780',
}

// What each savvy tier runs on, for planned tasks that have no run yet.
const colorOf = (tier: string): string => TIER_COLOR[tier] ?? '#888780'

const TIER_MODEL: Record<string, string> = {
  fable: 'Fable · high',
  heavy: 'Opus · xhigh',
  careful: 'Opus · high',
  medium: 'Opus · medium',
  light: 'Opus · low',
}

// USD per million tokens: input, output, cache read, cache write (5-minute TTL).
// The engine reports tokens, not money, so the panel's cost is an estimate.
const PRICES: [RegExp, [number, number, number, number]][] = [
  [/fable|mythos/, [10, 50, 0.25, 12.5]],
  [/opus-5-5/, [4, 20, 0.2, 5]],
  [/opus/, [5, 25, 0.5, 6.25]],
  [/sonnet/, [2, 10, 0.2, 2.5]],
  [/haiku/, [1, 5, 0.1, 1.25]],
]

type ApiUsage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

const priceOf = (model: string): [number, number, number, number] =>
  PRICES.find(([re]) => re.test(model.toLowerCase()))?.[1] ?? [4, 20, 0.2, 5]

const costOf = (model: string, u: ApiUsage): number => {
  const [i, o, r, w] = priceOf(model)
  return (
    ((u.input_tokens || 0) * i +
      (u.output_tokens || 0) * o +
      (u.cache_read_input_tokens || 0) * r +
      (u.cache_creation_input_tokens || 0) * w) /
    1e6
  )
}

const windowOf = (model: string): number => (/haiku/i.test(model) ? 200_000 : 1_000_000)

// `savvy-careful`, or `savvy-flow:savvy-careful` when the agents ship in a plugin.
const tierOf = (type: string): string => {
  const bare = type.replace(/^[^:]*:/, '')
  const t = bare.replace(/^savvy-/, '').toLowerCase()
  return t in TIER_COLOR && bare.startsWith('savvy-') ? t : 'other'
}

const modelName = (id: string): string => {
  const m = /(fable|mythos|opus|sonnet|haiku)-(\d+)(?:-(\d{1,2})(?!\d))?/i.exec(id)
  const [, family = '', major = '', minor] = m ?? []
  if (!family) return id.replace(/^claude-/, '').replace(/\[.*\]$/, '') || '—'
  return `${family.charAt(0).toUpperCase()}${family.slice(1).toLowerCase()} ${major}${minor ? '.' + minor : ''}`
}

const norm = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

const fmtTokens = (n: number): string =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : `${Math.round(n)}`

const fmtCost = (usd: number): string => `$${usd < 10 ? usd.toFixed(2) : usd.toFixed(1)}`

const fmtTime = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

const elapsed = (a: AgentRun, at: number): number => (a.endedAt ?? Math.max(at, a.startedAt)) - a.startedAt

type Planned = PlannedTask & { n: number }

const plannedOf = (f: Flow | null, list: AgentRun[]): Planned[] => {
  if (!f || f.isFinished) return []
  const started = new Set(list.map(a => norm(a.description)))
  return (f.tasks ?? []).map((t, i) => ({ ...t, n: i + 1 })).filter(t => !started.has(norm(t.title)))
}

const totals = (list: AgentRun[], at: number) => {
  const cost = list.reduce((s, a) => s + a.costUsd, 0)
  const tokens = list.reduce((s, a) => s + a.tokens, 0)
  const start = Math.min(...list.map(a => a.startedAt))
  const end = Math.max(...list.map(a => a.endedAt ?? Math.max(at, a.startedAt)))
  return { cost, tokens, time: list.length ? end - start : 0 }
}

// --- desktop drawings: each row is one SVG, as the band above the prompt is.

const PANE_CSS = `<style>
.t{fill:#1f1f1f}.s{fill:#6b6b68}.m{fill:#9a9a96}.k{fill:#ecebe8}.ln{stroke:#e4e4e1}.tile{fill:#f4f3f0}
@media (prefers-color-scheme: dark){.t{fill:#ececec}.s{fill:#a8a8a4}.m{fill:#7d7d79}.k{fill:#2c2c2b}.ln{stroke:#333331}.tile{fill:#262625}}
.live{animation:p 1.6s ease-in-out infinite}@keyframes p{50%{opacity:.3}}
@media (prefers-reduced-motion: reduce){.live{animation:none}}
</style>`

// Pixel Clawd from DockCrab (Clawdy): a 24×18 crab on a 30×28 grid, one costume per tier.
// The body keeps the brand clay; the tier's color lives in the costume's accent.
const CLAY = '#D97757'
const INK = '#1F1E1D'

// `cls` puts a pixel in a named group: `bd` (the default) is the body and its
// costume, `la`/`lb` the leg pairs, anything else a prop with its own motion.
type Fill = (x: number, y: number, w: number, h: number, c: string, cls?: string) => void

const stamp = (f: Fill, x: number, y: number, rows: string[], map: Record<string, string>, cls?: string): void =>
  rows.forEach((row, dy) => [...row].forEach((ch, dx) => map[ch] && f(x + dx, y + dy, 1, 1, map[ch] ?? '', cls)))

// `armCls` lets a raised claw travel with the prop it holds.
const crabBody = (f: Fill, armFront = 0, armCls?: string): void => {
  f(7, 10, 16, 12, CLAY)
  f(3, 14, 4, 4, CLAY)
  f(23, 14 + armFront, 4, 4, CLAY, armCls)
  f(9, 12, 2, 2, INK)
  f(19, 12, 2, 2, INK)
  f(7, 22, 2, 4, CLAY, 'la')
  f(17, 22, 2, 4, CLAY, 'la')
  f(11, 22, 2, 4, CLAY, 'lb')
  f(21, 22, 2, 4, CLAY, 'lb')
}

// Pure CSS, run by the compositor: no redraws. Periods divide one second, so the
// once-a-second redraw of a running row restarts them in phase. Every crab walks;
// each costume adds its prop's own motion on top.
const CRAB_CSS = `<style>
.run .la{animation:st .5s steps(1) infinite}.run .lb{animation:st .5s steps(1) infinite -.25s}
.run .bd{animation:bob .5s steps(1) infinite -.125s}
.run g{transform-box:fill-box}
@keyframes st{50%{transform:translateY(-1px)}}@keyframes bob{50%{transform:translateY(1px)}}
.c-astronaut.run{animation:float 1s ease-in-out infinite}
.c-astronaut.run .la,.c-astronaut.run .lb,.c-astronaut.run .bd{animation:none}
.c-astronaut.run .ant{animation:blink 1s steps(1) infinite}
.c-astronaut.run .star{animation:blink .5s steps(1) infinite -.25s}
@keyframes float{50%{transform:translateY(-2px)}}@keyframes blink{50%{opacity:.15}}
.c-detective.run .it{animation:scan 1s steps(1) infinite}
.c-detective.run .gl{animation:blink 1s steps(1) infinite -.5s}
@keyframes scan{25%{transform:translate(-1px,1px)}50%{transform:translate(-2px,2px)}75%{transform:translate(-1px,1px)}}
.c-builder.run .it{transform-origin:100% 100%;animation:twist .5s ease-in-out infinite}
@keyframes twist{50%{transform:rotate(-35deg)}}
.c-chef.run .pan{transform-origin:0 50%;animation:tilt 1s ease-in-out infinite}
.c-chef.run .egg{animation:flip 1s ease-in-out infinite}
@keyframes tilt{20%,40%{transform:rotate(-12deg)}}@keyframes flip{30%{transform:translateY(-5px) scaleY(-1)}60%{transform:translateY(0)}}
.c-racer.run .la{animation-duration:.25s}.c-racer.run .lb{animation-duration:.25s;animation-delay:-.125s}
.c-racer.run .flag{transform-origin:0 50%;animation:wave .25s steps(1) infinite}
@keyframes wave{50%{transform:skewY(-12deg) scaleX(.85)}}
.c-pirate.run .it{transform-origin:50% 100%;animation:fence .5s ease-in-out infinite}
@keyframes fence{50%{transform:rotate(25deg)}}
.c-wizard.run .it{transform-origin:50% 100%;animation:wiggle .5s ease-in-out infinite}
.c-wizard.run .sp{animation:blink .5s steps(1) infinite}
@keyframes wiggle{50%{transform:rotate(-15deg)}}
.c-viking.run .it{transform-origin:50% 100%;animation:chop .5s ease-in infinite}
@keyframes chop{50%{transform:rotate(-40deg)}}
.c-cowboy.run .lo{animation:loop .5s linear infinite}
@keyframes loop{25%{transform:scaleX(.5)}50%{transform:scaleX(-1)}75%{transform:scaleX(-.5)}}
.c-propeller.run .pr{animation:prop .25s steps(1) infinite}
@keyframes prop{25%{transform:scaleX(.3)}50%{transform:scaleX(-1)}75%{transform:scaleX(-.3)}}
.c-gentleman.run .it{animation:tap .5s steps(1) infinite}
.c-gentleman.run .gl{animation:blink 1s steps(1) infinite}
@keyframes tap{50%{transform:translateY(-2px)}}
.c-ninja.run .sh{animation:whirl .5s linear infinite}
.c-ninja.run .tl{transform-origin:100% 0;animation:wave .25s steps(1) infinite}
@keyframes whirl{to{transform:rotate(360deg)}}
.c-royal.run .jw{animation:blink .5s steps(1) infinite}
.c-royal.run .it{transform-origin:50% 100%;animation:wiggle 1s ease-in-out infinite}
.c-diver.run .bu{animation:rise 1s ease-out infinite}
@keyframes rise{0%{opacity:0;transform:translateY(3px)}40%{opacity:1}100%{opacity:0;transform:translateY(-3px)}}
.c-artist.run .it{transform-origin:50% 100%;animation:dab .5s ease-in-out infinite}
@keyframes dab{50%{transform:rotate(25deg) translateY(1px)}}
.c-dj.run .n1{animation:rise 1s ease-out infinite}.c-dj.run .n2{animation:rise 1s ease-out infinite -.5s}
.c-graduate.run .ta{transform-origin:50% 0;animation:swing 1s ease-in-out infinite}
@keyframes swing{25%{transform:rotate(20deg)}75%{transform:rotate(-20deg)}}
.c-party.run .nz{transform-origin:0 50%;animation:blow .5s ease-in-out infinite}
.c-party.run .pm{animation:blink .5s steps(1) infinite}
@keyframes blow{0%,100%{transform:scaleX(.25)}50%{transform:scaleX(1)}}
@media (prefers-reduced-motion: reduce){.run,.run g{animation:none!important}}
</style>`

const COSTUMES: Record<string, (f: Fill, t: string) => void> = {
  // Astronaut in a glass dome; floats instead of walking, the antenna and the star blink.
  astronaut: f => {
    crabBody(f)
    f(6, 7, 18, 1, '#E6E8EE'); f(5, 8, 1, 14, '#E6E8EE'); f(24, 8, 1, 14, '#E6E8EE'); f(6, 22, 18, 1, '#C9CCD2')
    f(6, 8, 18, 14, 'rgba(169,214,245,.32)'); f(8, 9, 2, 1, '#fff'); f(8, 10, 1, 2, '#fff')
    f(14, 4, 2, 3, '#C9CCD2'); f(14, 2, 2, 2, '#7F77DD', 'ant'); f(13, 18, 4, 2, '#7F77DD')
    f(27, 3, 1, 3, '#F5C542', 'star'); f(26, 4, 3, 1, '#F5C542', 'star')
  },
  // Detective with a deerstalker; the magnifier sweeps and glints.
  detective: f => {
    crabBody(f, -4, 'it')
    stamp(f, 6, 3, ['......bbbbbb......', '....bbcbbcbbbb....', '...bbbbbbbbbbbb...', '..bcbbcbbcbbcbbb..', '.bbbbbbbbbbbbbbbb.', 'dddddddddddddddddd'], { b: '#7A4A26', c: '#A0703F', d: '#5A3519' })
    f(6, 9, 18, 1, '#D85A30')
    stamp(f, 23, 1, ['.kkk.', 'k...k', 'k...k', 'k...k', '.kkk.'], { k: '#3A3A3C' }, 'it')
    f(24, 2, 3, 3, 'rgba(169,214,245,.7)', 'it'); f(25, 6, 1, 4, '#7A4A26', 'it'); f(24, 2, 1, 1, '#fff', 'gl')
  },
  // Builder in a hard hat; the wrench turns a bolt.
  builder: f => {
    crabBody(f)
    stamp(f, 6, 4, ['.....yyyyyyyy.....', '...yyyyyhhyyyyy...', '..yyyyyyhhyyyyyy..', '..yyyyyyhhyyyyyy..', '.yyyyyyyhhyyyyyyy.', 'dddddddddddddddddd'], { y: '#F5C542', h: '#FBE08A', d: '#C99A1E' })
    f(13, 5, 4, 2, '#BA7517')
    stamp(f, 0, 10, ['.s.s', 'sss.', '.s..', '.s..'], { s: '#8E929A' }, 'it')
  },
  // Chef, the toque traced from DockCrab's Sprites.chefHat; tosses the omelette.
  chef: f => {
    crabBody(f, -4, 'pan')
    stamp(f, 6, 0, ['........lll.......', '.......lllll......', '.wwwwgwwwwwwgwwwww', 'wwwwwwwwwwwwwwwwww', 'wwwwwwwwwwwwwwwwww', 'wwwwwgwwwwwggwwwww', '.wwwwgwwwwwggwwwww', '.dddbbbbbbbbbbbbb.', '.dddbbbbbbbbbbbbb.', '.dddbbbbbbbbbbbbb.'], { w: '#F4F3EE', l: '#F7F6F2', g: '#D2D1C8', b: '#378ADD', d: '#B45F43' })
    f(22, 8, 7, 2, '#4A4A48', 'pan'); f(26, 10, 1, 1, '#4A4A48', 'pan'); f(24, 7, 3, 1, '#F5B731', 'egg')
  },
  // Racer in a helmet; runs at double pace, the checkered flag flutters.
  racer: f => {
    crabBody(f, -4)
    stamp(f, 6, 5, ['....rrrrrrrrrr....', '..rrrrrrwwrrrrrr..', '.rrrrrrrwwrrrrrrr.', '.rrrrrrrwwrrrrrrr.', '.rrrrrrrwwrrrrrrr.', '.kkkkkkkkkkkkkkkkr'], { r: '#1D9E75', w: '#F8F6F1', k: INK })
    f(25, 1, 1, 9, '#8E929A')
    stamp(f, 26, 1, ['wkwk', 'kwkw', 'wkwk'], { w: '#F8F6F1', k: INK }, 'flag')
  },
  // Pirate scouting the code; the cutlass fences.
  pirate: f => {
    crabBody(f)
    stamp(f, 5, 3, ['.kk..............kk.', '.kkk....kkkk....kkk.', '..kkkkkkkwwkkkkkkk..', '..kkkkkkkkkkkkkkkk..', '.gggggggggggggggggg.'], { k: '#55514C', w: '#F8F6F1', g: '#F5C542' })
    f(7, 11, 11, 1, INK); f(18, 11, 4, 3, INK)
    f(27, 6, 1, 9, '#C9CCD2', 'it'); f(26, 15, 3, 1, '#7A4A26', 'it')
  },
  // Wizard: pointed hat with stars; the wand wiggles and sparkles.
  wizard: f => {
    crabBody(f, -4, 'it')
    stamp(f, 6, 0, ['........pp........', '.......ppp........', '.......pppp.......', '......ppsppp......', '......pppppp......', '.....pppppppp.....', '....pppppppsppp...', '...pppsppppppppp..', '..bbbbbbbbbbbbbb..', 'dddddddddddddddddd'], { p: '#6B4FBF', s: '#F5C542', b: '#F5C542', d: '#4B3590' })
    f(25, 3, 1, 8, '#4A3B2A', 'it'); f(25, 2, 1, 1, '#fff', 'it')
    f(27, 0, 1, 3, '#F5C542', 'sp'); f(26, 1, 3, 1, '#F5C542', 'sp')
  },
  // Viking: horned helmet; the axe chops.
  viking: f => {
    crabBody(f, -4, 'it')
    stamp(f, 5, 2, ['h..................h', 'hh................hh', '.hh....mmmmmm....hh.', '..hhmmmmmmmmmmmmhh..', '...mmmmmmlmmmmmmm...', '..mmmmmmmlmmmmmmmm..', '..mmmmmmmlmmmmmmmm..', '.rrrrrrrrrrrrrrrrrr.'], { h: '#EFE6D2', m: '#8E929A', l: '#C9CCD2', r: '#6A6E75' })
    f(25, 4, 1, 10, '#7A4A26', 'it')
    stamp(f, 26, 3, ['bb.', 'bbb', 'bbb', 'bb.'], { b: '#C9CCD2' }, 'it')
  },
  // Cowboy: wide-brim hat; the lasso loops overhead.
  cowboy: f => {
    crabBody(f, -4)
    stamp(f, 4, 4, ['.......cccccccc.......', '......cccccccccc......', '......cccccccccc......', '......bbbbbbbbbb......', 'kk..cccccccccccccc..kk', '.kkkkkkkkkkkkkkkkkkkk.'], { c: '#A0703F', b: '#5A3519', k: '#7A4A26' })
    f(25, 4, 1, 6, '#D9B27C')
    stamp(f, 22, 0, ['.rrrrr.', 'r.....r', 'r.....r', '.rrrrr.'], { r: '#D9B27C' }, 'lo')
  },
  // Propeller: striped beanie; the propeller spins.
  propeller: f => {
    crabBody(f)
    stamp(f, 6, 3, ['........kk........', '.....rrryyyybbb...', '...rrrrryyyybbbbb.', '..rrrrrryyyybbbbbb', '..rrrrrryyyybbbbbb', 'gggggggggggggggggg'], { k: '#3A3A3C', r: '#E5534B', y: '#F5C542', b: '#4F7FD9', g: '#5FBF8F' })
    f(14, 2, 2, 1, '#3A3A3C')
    f(10, 2, 4, 1, '#E5534B', 'pr'); f(16, 2, 4, 1, '#4F7FD9', 'pr')
  },
  // Gentleman: top hat and monocle; the cane taps.
  gentleman: f => {
    crabBody(f)
    stamp(f, 8, 2, ['..khkkkkkkkk..', '..khkkkkkkkk..', '..khkkkkkkkk..', '..khkkkkkkkk..', '..khkkkkkkkk..', '..rrrrrrrrrr..', '..kkkkkkkkkk..', 'kkkkkkkkkkkkkk'], { k: '#2A2A2C', h: '#4A4A4E', r: '#B23A3A' })
    stamp(f, 18, 11, ['.gg.', 'g..g', 'g..g', '.gg.'], { g: '#F5C542' })
    f(21, 15, 1, 3, '#F5C542'); f(19, 12, 1, 1, '#fff', 'gl')
    f(26, 9, 1, 15, '#3A3A3C', 'it'); f(24, 9, 3, 1, '#3A3A3C', 'it')
  },
  // Ninja: hood and headband; the shuriken whirls, the band's tails flutter.
  ninja: f => {
    crabBody(f, -4)
    stamp(f, 7, 6, ['..kkkkkkkkkkkk..', '.kkkkkkkkkkkkkk.', 'kkkkkkkkkkkkkkkk', 'rrrrrrrrrrrrrrrr'], { k: '#2A2A2C', r: '#C8322C' })
    f(4, 9, 3, 1, '#C8322C', 'tl'); f(2, 10, 3, 1, '#C8322C', 'tl'); f(1, 11, 2, 1, '#C8322C', 'tl')
    stamp(f, 23, 3, ['..s..', '..s..', 'ssgss', '..s..', '..s..'], { s: '#C9CCD2', g: '#3A3A3C' }, 'sh')
  },
  // Royal: jewelled crown; the scepter's gem blinks.
  royal: f => {
    crabBody(f, -4, 'it')
    stamp(f, 8, 3, ['g.....gg.....g', 'gg...gggg...gg', 'ggg.gggggg.ggg', 'gggggggggggggg', 'ggrgggbbgggrgg', 'gggggggggggggg', 'dddddddddddddd'], { g: '#F5C542', r: '#D64545', b: '#4F7FD9', d: '#C99A1E' })
    f(25, 3, 1, 9, '#C99A1E', 'it'); f(24, 1, 3, 2, '#F5C542', 'it'); f(25, 0, 1, 1, '#D64545', 'jw')
  },
  // Diver: mask and snorkel; bubbles rise.
  diver: f => {
    crabBody(f)
    f(8, 11, 14, 4, '#3A6EA5'); f(7, 12, 1, 2, '#2A2A2C'); f(22, 12, 1, 2, '#2A2A2C')
    f(9, 12, 4, 2, '#A9D6F5'); f(17, 12, 4, 2, '#A9D6F5')
    f(9, 12, 2, 2, INK); f(19, 12, 2, 2, INK)
    f(5, 4, 2, 8, '#F5C542'); f(5, 12, 3, 1, '#F5C542'); f(5, 3, 2, 1, '#E5534B')
    f(4, 0, 2, 2, '#A9D6F5', 'bu'); f(7, 1, 1, 1, '#A9D6F5', 'bu')
  },
  // Artist: beret and palette; the brush dabs.
  artist: f => {
    crabBody(f, -4, 'it')
    stamp(f, 5, 5, ['..........k........', '....bbbbbbbbbbb....', '..bbbbbbbbbbbbbbbb.', '.bbbbbbbbbbbbbbbbbb', '..dddddddddddddddd.'], { k: '#8E2420', b: '#C8322C', d: '#8E2420' })
    stamp(f, 0, 15, ['wwww', 'rwyw', 'wbww'], { w: '#E8D8B8', r: '#D64545', y: '#F5C542', b: '#4F7FD9' })
    f(25, 3, 1, 8, '#A0703F', 'it'); f(25, 2, 1, 1, '#C9CCD2', 'it'); f(25, 0, 1, 2, '#4F7FD9', 'it')
  },
  // DJ: headphones; music notes float up.
  dj: f => {
    crabBody(f)
    stamp(f, 5, 4, ['.....kkkkkkkkkk.....', '...kk..........kk...', '..k..............k..', '.k................k.', '.k................k.', 'ccc..............ccc', 'cec..............cec', 'cec..............cec', 'ccc..............ccc'], { k: '#3A3A3C', c: '#3A3A3C', e: '#E5534B' })
    f(27, 1, 1, 5, '#8f8cf4', 'n1'); f(25, 4, 2, 2, '#8f8cf4', 'n1'); f(28, 1, 1, 2, '#8f8cf4', 'n1')
    f(24, 0, 1, 3, '#8f8cf4', 'n2'); f(22, 2, 2, 2, '#8f8cf4', 'n2')
  },
  // Graduate: mortarboard; the tassel swings, the diploma is in hand.
  graduate: f => {
    crabBody(f)
    stamp(f, 5, 3, ['.........kk.........', '.....kkkkkkkkkk.....', 'kkkkkkkkkkkkkkkkkkkk', '.....kkkkkkkkkk.....', '......ssssssss......', '......ssssssss......', '......ssssssss......'], { k: '#2A2A2C', s: '#3A3A3C' })
    f(14, 4, 2, 1, '#F5C542')
    f(24, 6, 1, 3, '#F5C542', 'ta'); f(23, 9, 3, 2, '#F5C542', 'ta')
    f(24, 15, 6, 2, '#E8D8B8'); f(24, 15, 1, 2, '#B89A6A'); f(29, 15, 1, 2, '#B89A6A'); f(26, 15, 1, 2, '#D64545')
  },
  // Party: striped cone hat; the noisemaker unrolls.
  party: f => {
    crabBody(f, 2)
    stamp(f, 9, 0, ['.....ww.....', '.....ww.....', '.....pp.....', '....ppyy....', '....yypp....', '...ppyypp...', '...yyppyy...', '..ppyyppyy..', '..yyppyypp..', '.pppppppppp.'], { p: '#E66BA8', y: '#55C1E0' })
    f(14, 0, 2, 2, '#F8F6F1', 'pm')
    f(22, 15, 2, 1, '#F5C542'); f(24, 15, 5, 1, '#E5534B', 'nz'); f(28, 13, 1, 2, '#E5534B', 'nz')
  },
}

const COSTUME_KEYS = Object.keys(COSTUMES)

/** A planned task's crab wears its savvy tier's costume. */
const TIER_COSTUME: Record<string, string> = { fable: 'astronaut', heavy: 'detective', careful: 'builder', medium: 'chef', light: 'racer' }

/** A run's costume: the one it was given at spawn; older runs pick by their id. */
const costumeOf = (a: AgentRun): string => {
  if (a.costume && a.costume in COSTUMES) return a.costume
  const hash = [...a.id].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7)
  return COSTUME_KEYS[hash % COSTUME_KEYS.length] ?? 'other'
}

/** The next costume in order: the least worn in `list`, so none repeats until all are out. */
const nextCostume = (list: AgentRun[]): string => {
  const worn = new Map<string, number>()
  for (const a of list) worn.set(costumeOf(a), (worn.get(costumeOf(a)) ?? 0) + 1)
  return COSTUME_KEYS.reduce((best, k) => ((worn.get(k) ?? 0) < (worn.get(best) ?? 0) ? k : best), COSTUME_KEYS[0] ?? 'other')
}

const CRAB_SCALE = 1.1

// Body and props nest inside `bd` so a prop rides the bob and adds its own motion;
// legs stay outside it and step on their own.
const crab = (x: number, y: number, costume: string, dim = false, isWalking = false, scale = CRAB_SCALE): string => {
  const groups = new Map<string, string[]>([['bd', []]])
  const f: Fill = (cx, cy, w, h, c, cls = 'bd') => {
    if (!groups.has(cls)) groups.set(cls, [])
    groups.get(cls)?.push(`<rect x="${cx}" y="${cy}" width="${w}" height="${h}" fill="${c}"/>`)
  }
  const draw = COSTUMES[costume] ?? ((g: Fill) => crabBody(g))
  draw(f, colorOf(costume))
  const group = (cls: string) => `<g class="${cls}">${(groups.get(cls) ?? []).join('')}</g>`
  const props = [...groups.keys()].filter(k => k !== 'bd' && k !== 'la' && k !== 'lb')
  const body = `<g class="bd">${(groups.get('bd') ?? []).join('')}${props.map(group).join('')}</g>`
  return `<g transform="translate(${x},${y}) scale(${scale})" opacity="${dim ? 0.45 : 1}" shape-rendering="crispEdges"><g class="c-${costume}${isWalking ? ' run' : ''}">${body}${group('la')}${group('lb')}</g></g>`
}

const statusMark = (x: number, y: number, status: string, color: string): string => {
  if (status === 'running') return `<circle class="live" cx="${x}" cy="${y}" r="3.5" fill="${color}"/>`
  if (status === 'done') return `<path d="M${x - 5} ${y}l3.5 3.5 6.5-7" fill="none" stroke="#3B9C5F" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`
  if (status === 'failed') return `<path d="M${x - 4} ${y - 4}l8 8M${x + 4} ${y - 4}l-8 8" stroke="#D0453F" stroke-width="1.8" stroke-linecap="round"/>`
  return `<circle cx="${x}" cy="${y}" r="5" fill="none" stroke="#9a9a96" stroke-width="1.4"/><path d="M${x} ${y - 2.5}v2.8l1.8 1.2" fill="none" stroke="#9a9a96" stroke-width="1.4" stroke-linecap="round"/>`
}

const svg = (W: number, H: number, body: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${PANE_CSS}${CRAB_CSS}${body}</svg>`

// The task's own progress when the worker reports steps; a finished run is full.
const progressOf = (a: AgentRun): number | null => {
  if (a.status === 'done') return 1
  if (a.stepTotal) return Math.min(1, (a.stepDone ?? 0) / a.stepTotal)
  return null
}

const ctxOf = (a: AgentRun): number => (a.contextMax ? Math.min(100, Math.round((a.contextTokens / a.contextMax) * 100)) : 0)

const agentSvg = (W: number, a: AgentRun, at: number): string => {
  const s = tr()
  const tier = tierOf(a.type)
  const color = colorOf(tier)
  const ctx = ctxOf(a)
  const textW = W - 42 - 22
  const meta = [a.effort ? `${modelName(a.model)} · ${a.effort}` : modelName(a.model)]
  if (a.round > 1) meta.push(`${s.round} ${a.round}`)
  if (a.status === 'failed') meta.push(s.failed)
  const barW = textW
  const progress = progressOf(a)
  const stats = `ctx ${ctx}% · ${fmtTokens(a.contextTokens)}  ≈${fmtCost(a.costUsd)}  ${fmtTime(elapsed(a, at))}`
  const steps = a.stepTotal ? `${a.stepDone ?? 0}/${a.stepTotal}${a.stepNote ? ' · ' + a.stepNote : ''}` : ''
  const stepsW = Math.max(0, barW - textWidth(stats, 11) - 12)
  // Without reported steps the bar falls back to the context, drawn grey.
  const fillW = Math.round(barW * (progress ?? ctx / 100))
  return svg(
    W,
    66,
    `${crab(0, 14, costumeOf(a), false, a.status === 'running')}
<text class="t" x="42" y="18" font-family="${FONT}" font-size="13" font-weight="600">${xml(fitText(a.description || a.type, 13, textW))}</text>
<text x="42" y="34" font-family="${FONT}" font-size="11"><tspan fill="${color}">${xml(tier === 'other' ? a.type : tier)}</tspan><tspan class="s">  ${xml(meta.join('  ·  '))}</tspan></text>
${steps && stepsW > 30 ? `<text class="t" x="42" y="49" font-family="${FONT}" font-size="11" font-variant-numeric="tabular-nums">${xml(fitText(steps, 11, stepsW))}</text>` : ''}
<text class="s" x="${42 + barW}" y="49" text-anchor="end" font-family="${FONT}" font-size="11" font-variant-numeric="tabular-nums">${stats}</text>
<rect class="k" x="42" y="55" width="${barW}" height="4" rx="2"/><rect${progress === null ? ' class="m"' : ''} x="42" y="55" width="${fillW}" height="4" rx="2"${progress === null ? '' : ` fill="${color}"`}/>
${statusMark(W - 8, 16, a.status, color)}
<line class="ln" x1="0" y1="65.5" x2="${W}" y2="65.5"/>`,
  )
}

const plannedSvg = (W: number, p: Planned): string => {
  const tier = p.tier in TIER_COLOR ? p.tier : 'other'
  const color = colorOf(tier)
  const textW = W - 42 - 22
  const meta = [TIER_MODEL[tier] ?? '']
  if (p.after.length) meta.push(`${tr().after} ${p.after.join(', ')}`)
  return svg(
    W,
    46,
    `${crab(0, 6, TIER_COSTUME[tier] ?? tier, true)}
<text class="s" x="42" y="18" font-family="${FONT}" font-size="13" font-weight="600">${xml(fitText(`${p.n}. ${p.title}`, 13, textW))}</text>
<text x="42" y="34" font-family="${FONT}" font-size="11"><tspan fill="${color}">${xml(tier)}</tspan><tspan class="m">  ${xml(meta.filter(Boolean).join('  ·  '))}</tspan></text>
${statusMark(W - 8, 16, 'planned', color)}
<line class="ln" x1="0" y1="45.5" x2="${W}" y2="45.5"/>`,
  )
}

const compactSvg = (W: number, list: AgentRun[], planned: Planned[], t: ReturnType<typeof totals>): string => {
  const icons = [
    ...list.filter(a => a.status === 'running').map(a => ({ k: costumeOf(a), c: colorOf(tierOf(a.type)), s: 'running', dim: false })),
    ...list.filter(a => a.status !== 'running').map(a => ({ k: costumeOf(a), c: colorOf(tierOf(a.type)), s: a.status, dim: false })),
    ...planned.map(p => ({ k: TIER_COSTUME[p.tier] ?? 'other', c: colorOf(p.tier), s: 'planned', dim: true })),
  ]
  const fit = Math.max(1, Math.floor((W - 150) / 36))
  const shown = icons.slice(0, fit)
  const more = icons.length - shown.length
  const body = shown
    .map((ic, i) => crab(i * 36, 0, ic.k, ic.dim, ic.s === 'running') + (ic.s === 'running' ? `<circle class="live" cx="${i * 36 + 32}" cy="4" r="3" fill="${ic.c}"/>` : ''))
    .join('')
  const x = shown.length * 36 + (more ? 4 : 0)
  return svg(
    W,
    32,
    `${body}${more ? `<text class="s" x="${x}" y="21" font-family="${FONT}" font-size="12">+${more}</text>` : ''}
<text class="s" x="${W}" y="21" text-anchor="end" font-family="${FONT}" font-size="12" font-variant-numeric="tabular-nums">≈${fmtCost(t.cost)} · ${fmtTokens(t.tokens)} · ${fmtTime(t.time)}</text>`,
  )
}

// --- terminal drawing: the same rows in text.

const ctxBar = (pct: number, width: number): string => {
  const filled = Math.round((width * pct) / 100)
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled))
}

const STATUS_GLYPH: Record<string, string> = { running: '●', done: '✓', failed: '✗', planned: '◷' }

// Opens the combined pane, or closes it when it is up; true when it ends up open.
async function togglePane($: EngineInterface): Promise<boolean> {
  const isOpen = (await $.ui.panes()).some(p => p.id === PANE)
  if (isOpen) {
    await $.ui.close({ id: PANE })
    return false
  }
  const at = await $.clock.now()
  await update($, savvyNow, () => at)
  await openPane($)
  return true
}

async function autoOpen($: EngineInterface, key: string): Promise<void> {
  const p = await read($, panel)
  if (p.autoOpenedFor === key) return
  await update($, panel, prev => ({ ...prev, autoOpenedFor: key }))
  void openPane($).catch(() => undefined)
}

/** True when the savvy half has a flow or agent runs to show. */
async function hasSavvy($: EngineInterface): Promise<boolean> {
  return (await read($, flow)) !== null || (await read($, runs)).length > 0
}

/** Registers the hooks only savvy watches. */
function registerSavvy(on: On, options: PluginOptions) {
  on('tool.call', { tool: TOOL }, async ($, e) => {
    const input = e as unknown as ProgressInput
    const prev = await read($, flow)
    if (isNewFlow(prev, input) && input.title !== undefined) {
      // A new flow starts with a clean list; agents still running stay.
      await update($, runs, list => list.filter(a => a.status === 'running'))
    }
    const next = await update($, flow, p => merge(p, input))
    if (next && input.tasks?.length) await autoOpen($, next.title)
    return { result: `ok: ${label(next ?? blank())}` }
  })

  // A worker's own progress: the call runs in the worker's loop, so agentId names it.
  on('tool.call', { tool: STEP_TOOL }, async ($, e) => {
    const input = e as unknown as { done?: number; total?: number; note?: string }
    const agentId = e.agentId
    if (!agentId) return { result: 'ignored: only subagents report steps' }
    await update($, runs, list =>
      list.map(a => {
        if (a.agentId !== agentId) return a
        const total = Math.max(0, Math.round(input.total ?? a.stepTotal ?? 0))
        const done = Math.max(0, Math.round(input.done ?? a.stepDone ?? 0))
        return { ...a, stepTotal: total, stepDone: total ? Math.min(total, done) : done, stepNote: input.note?.trim() || undefined }
      }),
    )
    return { result: 'ok' }
  })

  // Safety net: worker launches move the faint layer even if the orchestrator forgets to report.
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const type = String(e.subagent_type ?? '')
    if (tierOf(type) === 'other') return next(e)

    await update($, flow, prev => {
      const base = prev && !prev.isFinished ? { ...blank(), ...prev } : blank()
      return { ...base, running: base.running + 1, phase: base.phase === 'plan' ? 'delegate' : base.phase }
    })
    try {
      return await next(e)
    } finally {
      await update($, flow, prev => (prev ? { ...prev, running: Math.max(0, prev.running - 1) } : prev))
    }
  })

  // Each model request of a subagent: live context, tokens and cost.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const f = await read($, flow)
    if (f === null || e.props.hasSurvey) return next(e)

    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const list = await read($, runs)
    const crew = list.length + plannedOf(f, list).length
    const isWorking = list.some(a => a.status === 'running')
    const crewButton = (
      <Button key="savvy-agents" label={`×${crew}`} plain onPress={() => void togglePane($)} />
    )
    const percent = `${Math.round(ratio(f) * 100)}%`
    const dismiss = (
      <Button
        key="savvy-dismiss"
        label="✕"
        plain
        role="dismiss"
        onPress={() => update($, flow, () => null)}
      />
    )

    if ('Svg' in ui) {
      const { Svg } = ui
      // About 8 CSS px per reported column; the rest is the count, the dismiss
      // and their gaps. No floor above the slot: a row wider than it would wrap.
      const width = Math.max(180, Math.min(1600, (e.props.bodyColumns || 100) * 8 - 96))
      return (
        <Box flexDirection="row" alignItems="center" gap={1}>
          <Svg source={rowSvg(f, width, isWorking)} alt={`${f.title}: ${label(f)}, ${percent}`} width={width} height={H} />
          {crewButton}
          {dismiss}
        </Box>
      )
    }

    const cols = e.props.bodyColumns
    const titleW = Math.max(8, Math.min(30, f.title.length + 2, Math.floor(cols / 3)))
    const width = Math.max(6, Math.min(40, cols - titleW - 32))
    return (
      <Box flexDirection="row" gap={2}>
        <Box width={titleW} flexShrink={0}>
          <Text color={f.isFinished ? DONE : ACCENT}>● </Text>
          <Text wrap="truncate-end">{f.title}</Text>
        </Box>
        <Text color={f.isFinished ? DONE : ACCENT}>{barText(f, width)}</Text>
        <Text bold>{label(f)}</Text>
        <Text dimColor>{percent}</Text>
        <Text color={CLAY}>▣</Text>
        {crewButton}
        {dismiss}
      </Box>
    )
  })
}

/** The savvy-progress half of the combined pane. */
async function renderSavvy($: EngineInterface, e: RenderInput<'Pane'>) {
  const s = tr()
  const ui = $.ui.resolve(e)
  const { Box, Text, Button } = ui
  const list = await read($, runs)
  const f = await read($, flow)
  const p: SavvyPanel = await read($, panel)
  const at = Math.max(await read($, savvyNow), ...list.map(a => a.startedAt), 0)

  const running = list.filter(a => a.status === 'running').reverse()
  const finished = list.filter(a => a.status !== 'running').reverse()
  const planned = plannedOf(f, list)
  const t = totals(list, at)
  // The pane's title says "Agents"; inside, only the flow's own name.
  const title = f && !f.isFinished ? f.title : ''

  const toggleCompact = (
    <Button
      key="compact"
      label={p.isCompact ? `${s.expand} ▾` : `${s.collapse} ▴`}
      plain
      dimColor
      onPress={() => update($, panel, prev => ({ ...prev, isCompact: !prev.isCompact }))}
    />
  )
  const toggleDone = (
    <Button
      key="done"
      label={`${p.isDoneCollapsed ? '▸' : '▾'} ${s.finished} · ${finished.length}`}
      plain
      dimColor
      onPress={() => update($, panel, prev => ({ ...prev, isDoneCollapsed: !prev.isDoneCollapsed }))}
    />
  )
  const isEmpty = list.length === 0 && planned.length === 0
  // Drawn inside a bordered box: its border and padding take 4 columns.
  const bodyCols = (e.props.bodyColumns || 40) - 4
  const summary = `≈${fmtCost(t.cost)}, ${fmtTokens(t.tokens)} ${s.tokensWord}, ${fmtTime(t.time)}`

  // The flow's name, or "Agents", with the expand/collapse control at its end.
  const header = (
    <Box flexDirection="row" justifyContent="space-between" alignItems="center">
      <Text bold wrap="truncate-end">
        {title || s.pane}
      </Text>
      {toggleCompact}
    </Box>
  )

  if (e.surface === 'desktop' && 'Svg' in ui) {
    const { Svg } = ui
    const W = Math.max(240, Math.min(900, bodyCols * 8 - 8))
    const section = (key: string, text: string) => (
      <Text key={key} dimColor>
        {text}
      </Text>
    )

    if (p.isCompact) {
      return (
        <Box flexDirection="column">
          {header}
          <Svg source={compactSvg(W, list, planned, t)} alt={`${list.length} ${s.agentsCount}, ${summary}`} width={W} height={32} />
        </Box>
      )
    }
    return (
      <Box flexDirection="column">
        {header}
        {isEmpty && <Text dimColor>{s.empty}</Text>}
        {running.length > 0 && section('h-run', `${s.running} · ${running.length}`)}
        {running.map(a => (
          <Svg key={a.id} source={agentSvg(W, a, at)} alt={`${a.description}: ${modelName(a.model)}, ${s.isRunning}`} width={W} height={66} />
        ))}
        {finished.length > 0 && toggleDone}
        {!p.isDoneCollapsed &&
          finished.map(a => (
            <Svg key={a.id} source={agentSvg(W, a, at)} alt={`${a.description}: ${modelName(a.model)}, ${s.isFinished}`} width={W} height={66} />
          ))}
        {planned.length > 0 && section('h-plan', `${s.planned} · ${planned.length}`)}
        {planned.map(pl => (
          <Svg key={`plan-${pl.n}`} source={plannedSvg(W, pl)} alt={`${pl.n}. ${pl.title}: ${s.isPlanned}`} width={W} height={46} />
        ))}
      </Box>
    )
  }

  // Terminal: the same content in text rows.
  const cols = Math.max(24, bodyCols)
  const barW = Math.max(6, Math.min(20, cols - 34))
  const row = (a: AgentRun) => {
    const tier = tierOf(a.type)
    const color = colorOf(tier)
    const ctx = ctxOf(a)
    const progress = progressOf(a)
    const model = a.effort ? `${modelName(a.model)} · ${a.effort}` : modelName(a.model)
    const steps = a.stepTotal ? `${a.stepDone ?? 0}/${a.stepTotal}${a.stepNote ? ' ' + a.stepNote : ''} · ` : ''
    return (
      <Box key={a.id} flexDirection="column" marginBottom={1}>
        <Box flexDirection="row" gap={1}>
          <Text color={color}>▣</Text>
          <Text bold wrap="truncate-end">
            {a.description || a.type}
          </Text>
          <Text color={a.status === 'failed' ? 'red' : a.status === 'done' ? 'green' : color}>{STATUS_GLYPH[a.status]}</Text>
        </Box>
        <Text dimColor wrap="truncate-end">
          {'  '}
          {tier === 'other' ? a.type : tier} · {model}
          {a.round > 1 ? ` · ${s.round} ${a.round}` : ''}
        </Text>
        <Text wrap="truncate-end">
          {'  '}
          {progress === null ? <Text dimColor>{ctxBar(ctx, barW)}</Text> : <Text color={color}>{ctxBar(progress * 100, barW)}</Text>}
          <Text dimColor>
            {' '}
            {steps}ctx {ctx}% · {fmtTokens(a.contextTokens)} ≈{fmtCost(a.costUsd)} {fmtTime(elapsed(a, at))}
          </Text>
        </Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      {header}
      {p.isCompact ? (
        <Text wrap="truncate-end">
          {[...running, ...finished].map(a => (
            <Text key={a.id} color={colorOf(tierOf(a.type))}>
              {STATUS_GLYPH[a.status]}{' '}
            </Text>
          ))}
          {planned.map(pl => (
            <Text key={`plan-${pl.n}`} dimColor>
              ◷{' '}
            </Text>
          ))}
        </Text>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          {isEmpty && <Text dimColor>{s.empty}</Text>}
          {running.length > 0 && <Text dimColor>{s.running} · {running.length}</Text>}
          {running.map(row)}
          {finished.length > 0 && toggleDone}
          {!p.isDoneCollapsed && finished.map(row)}
          {planned.length > 0 && <Text dimColor>{s.planned} · {planned.length}</Text>}
          {planned.map(pl => {
            const tier = pl.tier in TIER_COLOR ? pl.tier : 'other'
            return (
              <Box key={`plan-${pl.n}`} flexDirection="column" marginBottom={1}>
                <Text dimColor wrap="truncate-end">
                  <Text color={colorOf(tier)}>▢</Text> {pl.n}. {pl.title} ◷
                </Text>
                <Text dimColor wrap="truncate-end">
                  {'  '}
                  {tier} · {TIER_MODEL[tier] ?? ''}
                  {pl.after.length ? ` · ${s.after} ${pl.after.join(', ')}` : ''}
                </Text>
              </Box>
            )
          })}
        </Box>
      )}
    </Box>
  )
}

// savvy's hooks on the events the dashboard also watches; the dashboard runs each as its `next`.
type Args<E extends 'session.start' | 'agent.spawn' | 'turn.step' | 'turn.complete'> = Parameters<Hook<E>>

async function savvySessionStart($: Args<'session.start'>[0], e: Args<'session.start'>[1], next: Args<'session.start'>[2], options: PluginOptions) {
  const started = await next(e)
  lang = await detectLang($, options.language)
  await $.tool.register({
    name: 'progress',
    description:
      'Report /savvy-flow progress to the progress bar above the prompt and the agents panel. ' +
      'Call it after presenting the plan (title, total, tasks, phase "delegate"), each time a task is accepted (done), ' +
      'when switching phase or re-planning (tasks), and once at the end with finished: true. Fields left out keep their previous value.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short name of the overall task, a few words.' },
        total: { type: 'integer', minimum: 0, description: 'Number of planned worker tasks.' },
        done: { type: 'integer', minimum: 0, description: 'Number of tasks accepted after review.' },
        phase: { type: 'string', enum: [...PHASES] },
        finished: { type: 'boolean', description: 'True once the flow is closed.' },
        tasks: {
          type: 'array',
          description:
            'The planned worker tasks in order, numbered from 1. Each title must equal the Agent tool `description` the task will be delegated with, so the panel can match runs to tasks.',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'A few words; reused verbatim as the Agent description.' },
              tier: { type: 'string', enum: ['fable', 'heavy', 'careful', 'medium', 'light'] },
              after: { type: 'array', items: { type: 'integer' }, description: 'Numbers of the tasks this one waits for.' },
            },
            required: ['title', 'tier'],
          },
        },
      },
    },
  })
  await $.tool.register({
    name: 'step',
    description:
      'For savvy-flow workers: report progress on your own task to the agents panel. ' +
      'Right after reading the brief, call it with `total` (your plan in 3-8 steps) and `done: 0`; ' +
      'call it again as each step finishes. Cheap and silent: it only draws a bar.',
    inputSchema: {
      type: 'object',
      properties: {
        done: { type: 'integer', minimum: 0, description: 'Steps finished so far.' },
        total: { type: 'integer', minimum: 1, description: 'Steps planned; may change if the plan changes.' },
        note: { type: 'string', description: 'The step in progress, a few words.' },
      },
      required: ['done'],
    },
  })
  // Ticks the running agents' clocks; quiet when nothing runs.
  $.clock.every(1000, () => {
    void (async () => {
      const list = await read($, runs)
      if (!list.some(a => a.status === 'running')) return
      const at = await $.clock.now()
      await update($, savvyNow, () => at)
    })()
  })
  return started
}

async function savvyAgentSpawn($: Args<'agent.spawn'>[0], e: Args<'agent.spawn'>[1], next: Args<'agent.spawn'>[2]) {
  const started = await next(e)
  if (started.deny !== undefined) return started

  const at = await $.clock.now()
  await update($, runs, list => {
    const round = 1 + list.filter(a => norm(a.description) === norm(e.description) && e.description).length
    const run: AgentRun = {
      id: started.agentId ?? e.tool_use_id,
      agentId: started.agentId,
      type: e.subagentType,
      description: e.description,
      model: started.model,
      status: 'running',
      startedAt: at,
      contextTokens: 0,
      contextMax: windowOf(started.model),
      tokens: 0,
      costUsd: 0,
      steps: 0,
      round,
      costume: nextCostume(list.filter(a => a.id !== (started.agentId ?? e.tool_use_id))),
    }
    return [...list.filter(a => a.id !== run.id), run].slice(-200)
  })
  await update($, savvyNow, () => at)
  if (tierOf(e.subagentType) !== 'other') {
    const f = await read($, flow)
    await autoOpen($, f && !f.isFinished ? f.title : 'savvy-flow')
  }
  return started
}

async function* savvyTurnStep($: Args<'turn.step'>[0], e: Args<'turn.step'>[1], next: Args<'turn.step'>[2]) {
  const result = yield* next(e)
  const agentId = e.agentId
  const usage = result.usage
  if (!agentId || !usage) return result

  const model = usage.model || e.model
  await update($, runs, list =>
    list.map(a =>
      a.agentId !== agentId
        ? a
        : {
            ...a,
            model,
            effort: typeof e.effort === 'string' ? e.effort : a.effort,
            status: 'running',
            endedAt: undefined,
            contextTokens:
              (usage.input_tokens || 0) +
              (usage.cache_read_input_tokens || 0) +
              (usage.cache_creation_input_tokens || 0) +
              (usage.output_tokens || 0),
            contextMax: windowOf(model),
            tokens:
              a.tokens +
              (usage.input_tokens || 0) +
              (usage.output_tokens || 0) +
              (usage.cache_read_input_tokens || 0) +
              (usage.cache_creation_input_tokens || 0),
            costUsd: a.costUsd + costOf(model, usage),
            steps: a.steps + 1,
          },
    ),
  )
  return result
}

async function savvyTurnComplete($: Args<'turn.complete'>[0], e: Args<'turn.complete'>[1], next: Args<'turn.complete'>[2]) {
  const agentId = e.agentId
  if (agentId) {
    const at = await $.clock.now()
    await update($, runs, list =>
      list.map(a => {
        if (a.agentId !== agentId) return a
        // A run whose steps went unseen still gets the turn's own sum.
        const fallback = a.steps === 0 && e.usage
        return {
          ...a,
          status: e.reason === 'answer' ? 'done' : 'failed',
          endedAt: at,
          ...(fallback && e.usage
            ? {
                model: e.usage.model || a.model,
                tokens:
                  e.usage.input_tokens +
                  e.usage.output_tokens +
                  e.usage.cache_read_input_tokens +
                  e.usage.cache_creation_input_tokens,
                costUsd: costOf(e.usage.model || a.model, e.usage),
              }
            : {}),
        }
      }),
    )
    await update($, savvyNow, () => at)
  }
  return next(e)
}

// ---------------------------------------------------------------- hooks

export const register: Register = (on, options) => {
  const cfg = parseConfig(options)
  // savvy-progress's hooks; on the four events both mods watch, savvy's hook runs as this one's `next`.
  registerSavvy(on, options)
  const C = PALETTES[cfg.palette]
  // tool.check carries no loop id; the tool.call around it does, keyed by the call's id.
  const callLoop = new Map<string, string | null>()

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'control-tower',
      description: 'Control Tower, the live agent dashboard and savvy-flow progress: open, close, reset, or set the layout',
      argumentHint: '[open|close|reset|layout auto|compact|wide|mini]',
    })
    await migrate($)
    // A host without usage (headless, an SDK host, a session not yet bound) just starts without it.
    const u = await $.session.usage().catch(() => null)
    if (u) {
      await update($, usage, x => ({
        ...normalize(DEFAULT_USAGE, x),
        pct: u.context.percent ?? null,
        tokens: u.context.tokens ?? null,
        window: u.context.window,
        costUsd: u.cost?.usd ?? null,
        limits: u.rateLimits.map(r => ({ kind: r.kind, pct: r.percentUsed })),
      }))
    }
    if (cfg.openOnStart) void openPane($).catch(() => undefined)
    await refreshStatus($, cfg)
    return savvySessionStart($, e, next, options)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await resetAll($)
      await refreshStatus($, cfg)
    }
    return next(e)
  })

  on('command.run', { command: 'control-tower' }, async ($, e) => {
    const [verb = 'open', arg = ''] = e.args.trim().split(/\s+/)
    if (verb === 'close') {
      await $.ui.close({ id: PANE })
      return { text: 'Control Tower closed.' }
    }
    if (verb === 'reset') {
      await resetAll($)
      await refreshStatus($, cfg)
      return { text: 'Control Tower reset.' }
    }
    if (verb === 'layout') {
      const layout: Layout | null = arg === 'compact' || arg === 'wide' || arg === 'auto' || arg === 'mini' ? arg : null
      if (!layout) return { text: 'Usage: /control-tower layout auto|compact|wide|mini' }
      await update($, view, v => ({ ...normalize(DEFAULT_VIEW, v), layout }))
      const opened = await openPane($)
      return { text: opened.isPlaced ? `Control Tower layout: ${layout}.` : `Layout set to ${layout}; the pane is not shown yet: ${opened.reason}` }
    }
    const opened = await openPane($)
    if (!opened.isPlaced) return { text: `Control Tower is not shown yet: ${opened.reason}` }
    return { text: 'Control Tower opened. Focus it with ctrl+x tab; f/s/o open the gate rows.' }
  })

  on('classic.UserPromptSubmit', async ($, e, next) => {
    await noteMode($, e.permission_mode)
    return next(e)
  })

  on('agent.offer', async ($, e, next) => {
    const offered = await next(e)
    if (cfg.architect.test(e.agent) || (cfg.matchDescriptions && cfg.architect.test(e.description))) {
      await update($, roster, r => {
        const x = normalize(DEFAULT_ROSTER, r)
        return x.architectTypes.includes(e.agent) ? x : { architectTypes: [...listOf<string>(x.architectTypes), e.agent].slice(-20) }
      })
    }
    return offered
  })

  on('turn.start', async ($, e, next) => {
    const [now, cost] = await Promise.all([$.clock.now(), costNow($)])
    await update($, turn, () => ({ ...DEFAULT_TURN, startedAt: now, costAtStart: cost }))
    await update($, main, m => ({ ...normalize(DEFAULT_MAIN, m), isRunning: true }))
    // A background architect's report reaches the main loop as the text opening this turn. The
    // SubagentHandback tool call (in tool.call) normally carries it first; this is the fallback.
    const back = e.text ? handbackOf(e.text) : null
    const a = back ? await getArchitect($) : null
    if (back && a && a.ids.includes(back.from)) {
      const advice = adviceLine(back.body)
      if (advice && advice !== a.lastAdvice) await noteAdvice($, cfg, advice)
    } else if (e.text) {
      const p = promptLine(e.text)
      await say($, p.who, p.text)
    }
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    // The main loop's model is known when its request starts; a long first request shouldn't read "—".
    if (!e.agentId) {
      await update($, main, m => {
        const x = normalize(DEFAULT_MAIN, m)
        return { ...x, model: e.model, effort: String(e.effort ?? x.effort), steps: x.steps + 1 }
      })
      return yield* savvyTurnStep($, e, next)
    }
    const result = yield* savvyTurnStep($, e, next)
    const id = e.agentId
    const [cards, a] = await Promise.all([getCards($), getArchitect($)])
    if (cards.some(c => c.id === id)) {
      const step = { model: e.model, usage: result.usage, stopReason: result.stopReason }
      await update($, agents, list => listOf<unknown>(list).map(normalizeCard).map(c => (c.id === id ? applyStep(c, step) : c)))
      if (result.stopReason === 'max_tokens') await say($, await whoIs($, id), 'hit max_tokens', 'error', id)
    } else if (!a.ids.includes(id)) {
      const now = await $.clock.now()
      await update($, loops, l => stepLoop(listOf<Loop>(l), id, now))
    }
    return result
  })

  on('session.measure', async ($, e, next) => {
    await update($, usage, x => ({
      ...normalize(DEFAULT_USAGE, x),
      pct: e.context.percent ?? null,
      tokens: e.context.tokens ?? null,
      window: e.context.window,
      costUsd: e.cost?.usd ?? null,
      limits: e.rateLimits.map(r => ({ kind: r.kind, pct: r.percentUsed })),
    }))
    if (e.changed.includes('context')) await refreshStatus($, cfg)
    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    const done = await next(e)
    if (!e.agentId && e.trigger !== 'precompute') {
      const now = await $.clock.now()
      await update($, usage, x => {
        const u = normalize(DEFAULT_USAGE, x)
        return { ...u, compactions: u.compactions + 1, lastCompactAt: now }
      })
      await say($, 'main', `context compacted (${e.trigger})`)
    }
    return done
  })

  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    if (e.tool_use_id) {
      const check: Check = {
        id: e.tool_use_id,
        tool: e.tool,
        bucket: bucketOf(e.tool),
        verdict: verdict.decision === 'allow' ? 'rule' : verdict.decision,
        inSubagent: Boolean(callLoop.get(e.tool_use_id)),
        detail: shorten(describeInput(e.tool, e.input), 90),
        at: await $.clock.now(),
      }
      await update($, gate, g => recordCheck(normalizeGate(g), check))
      // The status line updates when the call settles; only a refusal ends here.
      if (verdict.decision === 'deny') {
        await say($, 'gate', `denied by rule · ${check.detail}`, 'error')
        await refreshStatus($, cfg)
      }
    }
    return verdict
  })

  on('tool.call', async ($, e, next) => {
    callLoop.set(e.tool_use_id, e.agentId ?? null)
    const ran = await next(e).finally(() => callLoop.delete(e.tool_use_id))
    const didRun = ran.deny === undefined
    // Settle this call's pending ask, if it had one; skip the write (and the redraw) otherwise.
    const g0 = await getGate($)
    const isSettled = settleCheck(g0, e.tool_use_id, didRun) !== g0
    if (isSettled) await update($, gate, g => settleCheck(normalizeGate(g), e.tool_use_id, didRun))
    // A background agent hands its report back through this tool; an architect's report is its advice.
    if (String(e.tool) === 'SubagentHandback') {
      const message = (e as unknown as { message?: unknown }).message
      const a = e.agentId ? await getArchitect($) : null
      if (a && e.agentId && a.ids.includes(e.agentId) && typeof message === 'string') {
        const advice = adviceLine(message)
        if (advice && advice !== a.lastAdvice) await noteAdvice($, cfg, advice)
      }
      return ran
    }
    if (e.tool === 'Agent') {
      if (isSettled) await refreshStatus($, cfg)
      return ran
    }
    const hasFailed = didRun && ran.isError === true
    const isEdit = !hasFailed && didRun && EDIT_TOOLS.has(e.tool)
    const t0 = await getTurn($)
    if (isEdit || hasFailed || (!e.agentId && t0.errorStreak > 0)) {
      await update($, turn, t => afterCall(normalize(DEFAULT_TURN, t), { inSubagent: Boolean(e.agentId), hasFailed, isEdit }))
    }
    const text = shorten(describeInput(e.tool, e), 64)
    if (e.agentId) {
      const id = e.agentId
      await update($, agents, list =>
        listOf<unknown>(list)
          .map(normalizeCard)
          .map(c => (c.id === id ? noteTool(c, { tool: e.tool, text, isError: hasFailed || ran.deny !== undefined }) : c)),
      )
    }
    // The log keeps what is worth a glance: refusals, errors and edits; the rest is on the cards.
    if (ran.deny !== undefined) await say($, await whoIs($, e.agentId), `${text}  denied`, 'error', e.agentId ?? null)
    else if (hasFailed) await say($, await whoIs($, e.agentId), `${text}  ✗`, 'error', e.agentId ?? null)
    else if (isEdit) await say($, await whoIs($, e.agentId), text, 'info', e.agentId ?? null)
    if (isSettled || !didRun) await refreshStatus($, cfg)
    return ran
  })

  // A server-side review tool never reaches tool.call: it shows only in the assistant's rows.
  on('session.append', async ($, e, next) => {
    if (!e.agentId && e.message.type === 'assistant') {
      const a = await getArchitect($)
      // Consults this row opened: their result may be in the same row, after the stale read above.
      const opened = new Set<string>()
      for (const block of e.message.content as unknown as readonly ServerBlock[]) {
        if (block.type === 'server_tool_use' && block.name && block.id && cfg.architect.test(block.name)) {
          if (a.seen.includes(block.id)) continue
          const id = block.id
          await update($, architect, x => {
            const y = normalize(DEFAULT_ARCHITECT, x)
            return { ...y, seen: [...listOf<string>(y.seen), id].slice(-60) }
          })
          opened.add(id)
          await consultStarted($, cfg, id, `${block.name} tool`)
        } else if (block.type.endsWith('_tool_result') && block.tool_use_id) {
          const id = block.tool_use_id
          const isOpen = opened.has(id) || (await getArchitect($)).consults.some(c => c.id === id && c.endAt === null)
          if (isOpen) await consultEnded($, cfg, null, id)
        }
      }
    }
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const started = await savvyAgentSpawn($, e, next)
    if (!e.parentAgentId) await noteMode($, e.permissionMode)
    if (started.deny !== undefined || !started.agentId) return started
    const id = started.agentId
    if (await isArchitectType($, cfg, e.subagentType)) {
      await update($, architect, a => {
        const x = normalize(DEFAULT_ARCHITECT, a)
        return { ...x, ids: [...listOf<string>(x.ids), id].slice(-40) }
      })
      await update($, loops, l => listOf<Loop>(l).filter(x => x.id !== id))
      await consultStarted($, cfg, id, e.subagentType.split(':').pop() ?? 'agent')
      return started
    }
    const card: AgentCard = {
      ...normalizeCard({}),
      id,
      type: e.name ?? e.subagentType,
      model: started.model,
      description: e.description,
      spawnedAt: await $.clock.now(),
    }
    await update($, agents, list => [...listOf<unknown>(list).map(normalizeCard), card].slice(-24))
    await update($, loops, l => listOf<Loop>(l).filter(x => x.id !== id))
    await say($, shorten(cardTitle(card), 12), `spawned · ${card.type}`, 'info', id)
    await refreshStatus($, cfg)
    return started
  })

  on('turn.complete', async ($, e, next) => {
    const done = await savvyTurnComplete($, e, next)
    const id = e.agentId
    const now = await $.clock.now()
    if (!id) {
      const [t, cards, cost] = await Promise.all([getTurn($), getCards($), costNow($)])
      const r = receiptOf(t, {
        durationMs: e.durationMs,
        agentsSince: cards.filter(c => c.spawnedAt >= t.startedAt).length,
        costNow: cost,
        reason: e.reason,
      })
      await update($, receipt, () => r)
      await update($, main, m => ({ ...normalize(DEFAULT_MAIN, m), isRunning: false }))
      await refreshStatus($, cfg)
      return done
    }
    if ((await getArchitect($)).ids.includes(id)) {
      await consultEnded($, cfg, e.answer, id)
      return done
    }
    const cards = await getCards($)
    if (cards.some(c => c.id === id)) {
      const status = e.reason === 'answer' ? 'done' : e.reason === 'aborted' ? 'stopped' : 'failed'
      await update($, agents, list =>
        listOf<unknown>(list)
          .map(normalizeCard)
          .map(c => (c.id === id ? { ...c, status, endedAt: now, answer: shorten(e.answer, 400) } : c)),
      )
      const card = cards.find(c => c.id === id)
      const took = card ? fmtDuration(now - card.spawnedAt) : ''
      await say($, await whoIs($, id), status === 'done' ? `done · ${took}` : status, status === 'done' ? 'done' : 'error', id)
    } else {
      await update($, loops, l => listOf<Loop>(l).map(x => (x.id === id ? { ...x, isDone: true, lastAt: now } : x)))
    }
    await refreshStatus($, cfg)
    return done
  })

  // ---------------------------------------------------------------- drawing

  // Flightdeck on top, the savvy-progress agents panel below once it has something to show.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    const hasClient = 'Client' in els
    const [m, u, a, g, cards, lp, lines, t, r, v, now] = await Promise.all([
      getMain($),
      getUsage($),
      getArchitect($),
      getGate($),
      getCards($),
      getLoops($),
      getLog($),
      getTurn($),
      read($, receipt),
      getView($),
      $.clock.now(),
    ])
    const W = Math.max(40, e.props.bodyColumns)
    // Inline the pane is an 8-row summary: savvy's progress band above the prompt stands in for its half there.
    const savvy = e.props.placement !== 'inline' && (await hasSavvy($)) ? await renderSavvy($, e) : null
    const savvyHalf = savvy ? (
      <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor={C.main} paddingX={1}>
        {savvy}
      </Box>
    ) : null
    const layout = v.layout ?? cfg.layout
    const isWide = layout === 'wide' || (layout === 'auto' && W >= 110)
    const colW = isWide ? Math.floor((W - 2) / 2) : W
    const modelName = prettyModel(m.model)
    const viewed = e.props.view?.agentId ?? null
    const advising = isAdvising(a)
    const running = cards.filter(c => c.status === 'running')
    const showArchitect = a.consults.length > 0 || a.ids.length > 0
    const motion = cfg.motion && hasClient
    // A panel with nothing to show yet takes no room: most sessions never spawn an agent.
    const isEmpty: Record<Panel, boolean> = {
      main: false,
      architect: !showArchitect,
      gate: g.recent.length === 0 && gateSummary(g).total === 0,
      agents: true, // the savvy half below lists the agents
      loops: lp.length === 0,
      receipt: !m.isRunning && !r,
      log: false,
    }
    const panels = cfg.panels.filter(p => !isEmpty[p])
    const decider = m.mode === 'auto' ? 'classifier' : 'you'

    // A connector between panels: animated while its flow is live, a dim line otherwise.
    const rail = (key: string, active: boolean, color: string, width: number, marks: number[] = [], isMerge = false) =>
      motion ? (
        <els.Client
          key={key}
          module="./rail.tsx"
          width={width}
          height={1}
          props={{ active, width, color, dim: C.faint, marks, isMerge }}
        />
      ) : (
        <Text color={C.faint}>{'─'.repeat(Math.max(1, width))}</Text>
      )

    // A start time of 0 is unknown (state saved before it was recorded): no clock, not decades.
    const clock = (key: string, since: number, endAt: number | null, color: string) =>
      since <= 0 ? (
        <Text color={color}>—</Text>
      ) : hasClient ? (
        <els.Client key={key} module="./elapsed.tsx" props={{ since, now, endAt, color }} />
      ) : (
        <Text color={color}>{fmtTimer((endAt ?? now) - since)}</Text>
      )

    // ---- main
    const effortN = { low: 1, medium: 2, high: 3, xhigh: 4, max: 4 }[m.effort] ?? 0
    const ctxGauge = u.pct !== null ? gauge(u.pct, 10) : null
    const mainPanel = (w: number) => (
      <Box flexDirection="column" borderStyle="round" borderColor={C.main} paddingX={1} width={w}>
        <Box justifyContent="space-between">
          <Text color={C.main} bold>
            {modelName} · main
          </Text>
          <Text color={m.isRunning ? C.main : C.dim}>{m.isRunning ? '● working' : '○ idle'}</Text>
        </Box>
        <Text wrap="truncate">
          <Text dimColor>effort </Text>
          <Text color={C.main}>{'▮'.repeat(effortN) + '▯'.repeat(4 - effortN)} </Text>
          <Text color={C.main} bold>
            {m.effort || '—'}
          </Text>
          {m.mode ? <Text dimColor>{`   mode ${m.mode}`}</Text> : null}
          <Text dimColor>{`   ${m.steps} req`}</Text>
        </Text>
        {ctxGauge ? (
          <Text wrap="truncate">
            <Text dimColor>ctx </Text>
            <Text color={u.pct !== null && u.pct >= 80 ? C.warn : C.main}>{ctxGauge.on}</Text>
            <Text color={C.faint}>{ctxGauge.off}</Text>
            <Text bold>{` ${Math.round(u.pct ?? 0)}%`}</Text>
            {u.tokens !== null ? <Text dimColor>{` ${kTokens(u.tokens)}/${kTokens(u.window)}`}</Text> : null}
            {u.compactions > 0 ? <Text color={C.amber}>{`  ⟲${u.compactions}`}</Text> : null}
          </Text>
        ) : null}
        {u.costUsd !== null || u.limits.length > 0 ? (
          <Text wrap="truncate">
            {u.costUsd !== null ? <Text color={C.text}>{`${fmtUsd(u.costUsd)}   `}</Text> : null}
            {u.limits.slice(0, 2).map(l => {
              const lg = gauge(l.pct, 5)
              return (
                <Text wrap="truncate">
                  <Text dimColor>{`${limitLabel(l.kind)} `}</Text>
                  <Text color={l.pct >= 80 ? C.warn : C.main}>{lg.on}</Text>
                  <Text color={C.faint}>{lg.off}</Text>
                  <Text dimColor>{` ${Math.round(l.pct)}%  `}</Text>
                </Text>
              )
            })}
          </Text>
        ) : null}
      </Box>
    )

    // ---- architect
    const lastConsult = a.consults[a.consults.length - 1]
    const architectPanel = (w: number) => {
      const tl = consultTimeline(a, now, Math.max(8, w - 4))
      return (
        <Box flexDirection="column" borderStyle="round" borderColor={C.arch} paddingX={1} width={w}>
          <Box justifyContent="space-between">
            <Text color={C.arch} bold>
              {cfg.architectLabel} · {advising ? 'advising' : 'on call'}
            </Text>
            <Text>
              <Text dimColor>consults </Text>
              <Text color={C.arch} bold>
                {a.consults.length}
              </Text>
            </Text>
          </Box>
          <Text color={C.arch}>{tl}</Text>
          {lastConsult ? (
            <Text dimColor wrap="truncate">
              {advising
                ? `consulting since ${fmtClock(lastConsult.at)}`
                : `last ${fmtDuration(now - (lastConsult.endAt ?? lastConsult.at))} ago · took ${fmtDuration((lastConsult.endAt ?? now) - lastConsult.at)}`}
            </Text>
          ) : (
            <Text dimColor>not consulted yet</Text>
          )}
          {cfg.moments ? (
            <Box flexWrap="wrap" columnGap={2}>
              {(['before a plan', 'error repeats', 'before done'] as const).map(mo => {
                const isOn = lastConsult?.moment === mo
                return (
                  <Text color={isOn ? C.arch : C.dim} bold={isOn}>
                    {isOn ? '◆' : '◇'} {mo}
                  </Text>
                )
              })}
              <Text color={C.faint}>(inferred)</Text>
            </Box>
          ) : null}
          {a.lastAdvice ? (
            <Text color={C.arch} wrap="truncate">
              » {a.lastAdvice}
            </Text>
          ) : null}
        </Box>
      )
    }

    // ---- gate
    const s = gateSummary(g)
    const verdictColor = (c: Check) =>
      c.verdict === 'rule' ? C.gate : c.verdict === 'cleared' ? C.cleared : c.verdict === 'ask' ? C.amber : C.warn
    const gatePanel = (w: number) => {
      // A desktop draws ■ wider than a column: fewer cells there, and the row clips rather than spill past the border.
      const strip = g.recent.slice(-Math.max(8, Math.floor((w - 4) * (e.surface === 'terminal' ? 1 : 0.75))))
      const open = v.gateOpen
      return (
        <Box flexDirection="column" borderStyle="round" borderColor={C.gate} paddingX={1} width={w}>
          <Box justifyContent="space-between">
            <Text color={C.gate} bold>
              {cfg.gateLabel} · permissions
            </Text>
            <Text dimColor>{`${s.total} checks`}</Text>
          </Box>
          <Box overflow="hidden">
            {strip.length === 0 ? <Text color={C.faint}>no checks yet</Text> : null}
            {strip.map(c => (
              <Text color={verdictColor(c)} dimColor={c.inSubagent}>
                {c.verdict === 'deny' ? '✗' : '■'}
              </Text>
            ))}
          </Box>
          <Text wrap="truncate">
            <Text color={C.gate}>■</Text>
            <Text dimColor>{` ${s.rule} allowed  `}</Text>
            <Text color={C.cleared}>■</Text>
            <Text dimColor>{` ${s.cleared} ${decider}  `}</Text>
            {s.ask > 0 ? <Text color={C.amber}>{`■ ${s.ask} pending  `}</Text> : null}
            <Text color={s.deny > 0 ? C.warn : C.dim}>{`✗ ${s.deny} denied`}</Text>
            {w >= 80 && g.recent.some(c => c.inSubagent) ? <Text color={C.faint}>{'  dim: in subagents'}</Text> : null}
          </Text>
          <Box columnGap={2}>
            {(['file', 'shell', 'other'] as const).map((b: Bucket) => {
              const tl = g.totals[b]
              const n = tl.rule + tl.ask + tl.cleared + tl.deny
              return (
                <Button
                  key={`gate-${b}`}
                  plain
                  hotkey={b[0]}
                  label={`${b} ${n}${open === b ? ' ▾' : ''}`}
                  dimColor={n === 0}
                  onPress={() => update($, view, x => ({ ...normalize(DEFAULT_VIEW, x), gateOpen: normalize(DEFAULT_VIEW, x).gateOpen === b ? null : b }))}
                />
              )
            })}
          </Box>
          {open
            ? g.recent
                .filter(c => c.bucket === open)
                .slice(-5)
                .map(c => (
                  <Text wrap="truncate">
                    <Text color={verdictColor(c)}>{c.verdict === 'deny' ? '✗ ' : '■ '}</Text>
                    <Text color={C.dim}>{`${(c.verdict === 'rule' ? 'allowed' : c.verdict === 'cleared' ? decider : c.verdict === 'ask' ? 'pending' : 'denied').padEnd(10)} `}</Text>
                    <Text dimColor={c.inSubagent}>{shorten(c.detail, Math.max(10, w - 18))}</Text>
                  </Text>
                ))
            : null}
        </Box>
      )
    }

    // ---- agents: cards up to the limit, swimlanes beyond it
    const statusColor = (c: AgentCard) => (c.status === 'failed' ? C.warn : c.status === 'done' ? C.gate : C.agent)
    const glyph = (c: AgentCard) => (c.status === 'running' ? '◐' : c.status === 'done' ? '✓' : c.status === 'failed' ? '✗' : '■')
    const expandOnPress = (id: string) => () =>
      update($, view, x => ({ ...normalize(DEFAULT_VIEW, x), expanded: normalize(DEFAULT_VIEW, x).expanded === id ? null : id }))

    const agentsPanel = (w: number) => {
      // Cards need 20 columns each; when the pane can't hold the limit, lanes take over.
      const fit = Math.max(1, Math.min(cfg.maxCards, Math.floor((w + 1) / 21)))
      const useLanes = cards.length > fit
      const header = (
        <Box justifyContent="space-between" width={w}>
          <Text bold>{`agents · ${running.length} running · ${cards.length} total`}</Text>
          {cards.length > 0 ? <Text color={C.faint}>1-{Math.min(cards.length, useLanes ? 6 : fit)} expand</Text> : null}
        </Box>
      )
      if (cards.length === 0) {
        return (
          <Box flexDirection="column" width={w}>
            {header}
            <Text color={C.faint}>no subagents yet</Text>
          </Box>
        )
      }
      if (useLanes) {
        const shown = cards.slice(-6)
        const barW = Math.max(8, w - 28)
        const geo = lanes(shown, now, barW)
        return (
          <Box flexDirection="column" width={w}>
            {header}
            {cards.length > shown.length ? <Text color={C.faint}>{`+${cards.length - shown.length} earlier`}</Text> : null}
            {shown.map((c, i) => {
              const gm = geo[i]
              const isViewed = viewed === c.id
              return (
                <Box>
                  <Text color={statusColor(c)} bold={isViewed}>{`${isViewed ? '▶' : glyph(c)} `}</Text>
                  <Box width={17}>
                    <Button key={`card-${c.id}`} plain hotkey={String(i + 1)} label={shorten(cardTitle(c), 14)} onPress={expandOnPress(c.id)} />
                  </Box>
                  <Text color={C.faint}>{' ' + '·'.repeat(gm?.before ?? 0)}</Text>
                  <Text color={statusColor(c)}>{'━'.repeat(gm?.bar ?? 1)}</Text>
                  <Text color={C.faint}>{'·'.repeat(gm?.after ?? 0) + ' '}</Text>
                  {clock(`lane-clock-${c.id}`, c.spawnedAt, c.endedAt, C.dim)}
                </Box>
              )
            })}
          </Box>
        )
      }
      const shown = cards.slice(-fit)
      const cardW = Math.max(20, Math.floor((w - (shown.length - 1)) / shown.length))
      const centers = shown.map((_, i) => i * (cardW + 1) + Math.floor(cardW / 2))
      return (
        <Box flexDirection="column" width={w}>
          {header}
          {rail('fan-out', running.length > 0, C.agent, w, centers)}
          <Box columnGap={1}>
            {shown.map((c, i) => {
              const isViewed = viewed === c.id
              const sameModel = !c.model || prettyModel(c.model) === modelName
              return (
                <Box
                  flexDirection="column"
                  borderStyle={isViewed ? 'double' : 'round'}
                  borderColor={c.lastStop === 'max_tokens' ? C.warn : C.agent}
                  borderDimColor={c.status !== 'running' && !isViewed}
                  width={cardW}
                  paddingX={1}
                >
                  <Button key={`card-${c.id}`} plain hotkey={String(i + 1)} label={titleLines(cardTitle(c), cardW - 7, cardW - 4)[0]} onPress={expandOnPress(c.id)} />
                  <Text bold wrap="truncate">
                    {titleLines(cardTitle(c), cardW - 7, cardW - 4)[1]}
                  </Text>
                  <Text color={C.dim} wrap="truncate">
                    {sameModel ? c.type : `${c.type} · ${prettyModel(c.model)}`}
                  </Text>
                  <Text dimColor wrap="truncate">
                    {c.steps > 0 ? `ctx ${kTokens(c.ctx)} · out ${kTokens(c.out)} · ${c.steps} st` : 'starting…'}
                  </Text>
                  <Box>
                    <Text color={c.lastStop === 'max_tokens' ? C.warn : statusColor(c)}>
                      {cardW >= 26 ? `${glyph(c)} ${c.lastStop === 'max_tokens' ? 'max_tokens' : c.status} ` : `${glyph(c)} `}
                    </Text>
                    <Box flexShrink={0}>{clock(`card-clock-${c.id}`, c.spawnedAt, c.endedAt, C.dim)}</Box>
                  </Box>
                </Box>
              )
            })}
          </Box>
          {rail('merge', running.length > 0, C.agent, w, centers, true)}
        </Box>
      )
    }

    const expandedCard = cards.find(c => c.id === v.expanded)
    const expandedPanel = (w: number) =>
      expandedCard ? (
        <Box flexDirection="column" borderStyle="single" borderColor={C.agent} paddingX={1} width={w}>
          <Text bold wrap="wrap">
            {expandedCard.description || expandedCard.type}
          </Text>
          <Text dimColor wrap="truncate">{`${expandedCard.type} · ${prettyModel(expandedCard.model)} · ${expandedCard.status} · ${expandedCard.steps} steps`}</Text>
          {expandedCard.tools.length === 0 ? <Text color={C.faint}>no tool calls yet</Text> : null}
          {expandedCard.tools.map(n => (
            <Text color={n.isError ? C.warn : C.text} wrap="truncate">
              {`${n.isError ? '✗' : '·'} ${n.text}`}
            </Text>
          ))}
          {expandedCard.answer ? (
            <Text dimColor wrap="wrap">
              {`» ${shorten(expandedCard.answer, 240)}`}
            </Text>
          ) : null}
        </Box>
      ) : null

    // ---- other loops (workflow agents, forks): ids that match no card
    const loopsPanel = (w: number) => {
      if (lp.length === 0) return null
      const active = lp.filter(l => isLoopActive(l, now)).length
      const dots = lp.slice(-Math.max(4, w - 38))
      return (
        <Box width={w}>
          <Text bold>other loops </Text>
          <Text dimColor>{`${lp.length} seen · ${active} active  `}</Text>
          {dots.map(l => (
            <Text color={isLoopActive(l, now) ? C.agent : l.isDone ? C.dim : C.faint}>{isLoopActive(l, now) ? '●' : l.isDone ? '✓' : '○'}</Text>
          ))}
        </Box>
      )
    }

    // ---- receipt: the turn now, or the last one
    const receiptPanel = (w: number) => {
      const isReview = t.isReviewing
      return (
        <Box flexDirection="column" borderStyle="round" borderColor={C.main} borderDimColor={!m.isRunning && !isReview} paddingX={1} width={w}>
          {m.isRunning ? (
            <Box>
              <Text color={C.main} wrap="truncate">{`◐ back to ${modelName.toLowerCase()} · turn `}</Text>
              <Box flexShrink={0}>{clock('turn-clock', t.startedAt, null, C.main)}</Box>
              {w >= 60 ? <Text dimColor wrap="truncate">{` · ${plural(t.edits, 'edit')} · ${plural(t.errors, 'error')}`}</Text> : null}
            </Box>
          ) : r ? (
            <Text wrap="truncate">
              <Text color={r.reason === 'answer' ? C.gate : C.warn}>{r.reason === 'answer' ? '✓ ' : '✗ '}</Text>
              <Text>{`last turn ${fmtDuration(r.durationMs)} · ${plural(r.agents, 'agent')} · ${plural(r.edits, 'edit')} · ${plural(r.errors, 'error')}`}</Text>
              {r.costDelta !== null ? <Text color={C.main}>{` · +${fmtUsd(r.costDelta)}`}</Text> : null}
            </Text>
          ) : (
            <Text color={C.faint}>no turn finished yet</Text>
          )}
          {isReview ? <Text color={C.arch}>{`${cfg.architectLabel.toLowerCase()} reviewing before done (inferred)`}</Text> : null}
        </Box>
      )
    }

    // ---- log: whatever rows the other panels leave, 4 to 8
    const used = 2 + 5 + (showArchitect ? 6 : 0) + 6 + (v.gateOpen ? 5 : 0) + (cards.length > cfg.maxCards ? 3 + Math.min(6, cards.length) : 8) + (expandedCard ? 8 : 0) + (lp.length ? 1 : 0) + 3
    const bodyRows = e.props.scroll?.bodyRows ?? e.viewport?.rows ?? 40
    const nLog = logRows(bodyRows, used)
    const shownLines = (viewed ? lines.filter(l => l.agentId === viewed) : lines).slice(-nLog)
    const colorOf = (l: LogLine) =>
      l.kind === 'error' ? C.warn : l.kind === 'consult' ? C.arch : l.who === 'main' ? C.main : l.who === 'gate' ? C.gate : l.who === 'you' ? C.text : C.agent
    const logPanel = (w: number) => (
      <Box flexDirection="column" borderStyle="round" borderColor={C.faint} paddingX={1} width={w}>
        <Text dimColor>{viewed ? 'session log · this agent' : 'session log'}</Text>
        {shownLines.length === 0 ? <Text color={C.faint}>nothing yet</Text> : null}
        {shownLines.map(l => (
          <Box>
            <Box width={9} flexShrink={0}>
              <Text color={C.faint}>{fmtClock(l.at)}</Text>
            </Box>
            <Box width={13} flexShrink={0}>
              <Text color={colorOf(l)} bold wrap="truncate">
                {l.who}
              </Text>
            </Box>
            <Text color={l.kind === 'error' ? C.warn : C.text} wrap="truncate">
              {l.text}
            </Text>
          </Box>
        ))}
      </Box>
    )

    const draw = (p: Panel, w: number) =>
      p === 'main'
        ? mainPanel(w)
        : p === 'architect'
          ? architectPanel(w)
          : p === 'gate'
            ? gatePanel(w)
            : p === 'agents'
              ? agentsPanel(w)
              : p === 'loops'
                ? loopsPanel(w)
                : p === 'receipt'
                  ? receiptPanel(w)
                  : logPanel(w)

    // Panels with the flow between them; the agents panel draws its own rails.
    const column = (ps: Panel[], w: number) => (
      <Box flexDirection="column" width={w}>
        {ps.map((p, i) => {
          const prev = ps[i - 1]
          const link =
            i === 0 || p === 'agents' || prev === 'agents' || p === 'log' || p === 'loops' || prev === 'loops'
              ? null
              : rail(`link-${p}`, p === 'architect' ? advising : m.isRunning, p === 'architect' ? C.arch : C.main, w)
          return (
            <Box flexDirection="column" marginTop={link === null && i > 0 && e.surface !== 'terminal' ? 1 : 0}>
              {link}
              {draw(p, w)}
              {p === 'agents' ? expandedPanel(w) : null}
            </Box>
          )
        })}
      </Box>
    )

    // Inline above the prompt (the terminal's main screen), the pane is a summary of at most 8 rows.
    const isMini = layout === 'mini' || (layout === 'auto' && e.props.placement === 'inline')
    if (isMini) {
      const live = [...cards.filter(c => c.status === 'running'), ...cards.filter(c => c.status !== 'running').reverse()].slice(0, 3)
      const counts = ` ${s.rule} allowed · ${s.cleared} ${decider}${s.ask > 0 ? ` · ${s.ask} pending` : ''} · ${s.deny} denied`
      const strip = g.recent.slice(-Math.max(4, W - cfg.gateLabel.length - 1 - counts.length))
      const mg = u.pct !== null ? gauge(u.pct, 6) : null
      return (
        <Box flexDirection="column" width={W}>
          <Text wrap="truncate">
            <Text color={C.main} bold>
              {modelName}
            </Text>
            <Text color={m.isRunning ? C.main : C.dim}>{m.isRunning ? ' ● working' : ' ○ idle'}</Text>
            {mg ? <Text dimColor> · ctx </Text> : null}
            {mg ? <Text color={(u.pct ?? 0) >= 80 ? C.warn : C.main}>{mg.on}</Text> : null}
            {mg ? <Text color={C.faint}>{mg.off}</Text> : null}
            {mg ? <Text>{` ${Math.round(u.pct ?? 0)}%`}</Text> : null}
            {u.compactions > 0 ? <Text color={C.amber}>{` ⟲${u.compactions}`}</Text> : null}
            {u.costUsd !== null ? <Text dimColor>{` · ${fmtUsd(u.costUsd)}`}</Text> : null}
            {showArchitect ? <Text color={C.arch}>{` · ${cfg.architectLabel.toLowerCase()} ${advising ? 'advising' : a.consults.length}`}</Text> : null}
          </Text>
          {strip.length > 0 ? (
            <Box>
              <Text dimColor>{`${cfg.gateLabel.toLowerCase()} `}</Text>
              {strip.map(c => (
                <Text color={verdictColor(c)} dimColor={c.inSubagent}>
                  {c.verdict === 'deny' ? '✗' : '■'}
                </Text>
              ))}
              <Text color={s.deny > 0 ? C.warn : s.ask > 0 ? C.amber : C.dim} wrap="truncate">
                {counts}
              </Text>
            </Box>
          ) : null}
          {live.map(c => (
            <Box>
              <Text color={statusColor(c)}>{`${glyph(c)} `}</Text>
              <Box width={Math.max(10, W - 30)}>
                <Text wrap="truncate">{cardTitle(c)}</Text>
              </Box>
              <Text dimColor>{c.steps > 0 ? ` ctx ${kTokens(c.ctx)} ` : ' '}</Text>
              {clock(`mini-clock-${c.id}`, c.spawnedAt, c.endedAt, C.dim)}
            </Box>
          ))}
          {cards.length > live.length ? (
            <Text color={C.faint} wrap="truncate">{`+${cards.length - live.length} more agents · /control-tower layout compact for all`}</Text>
          ) : null}
          {lp.length > 0 ? <Text dimColor>{`other loops ${lp.length} · ${lp.filter(l => isLoopActive(l, now)).length} active`}</Text> : null}
          {!m.isRunning && r ? (
            <Text dimColor wrap="truncate">
              {`last turn ${fmtDuration(r.durationMs)} · ${plural(r.agents, 'agent')} · ${plural(r.edits, 'edit')} · ${plural(r.errors, 'error')}${r.costDelta !== null ? ` · +${fmtUsd(r.costDelta)}` : ''}`}
            </Text>
          ) : null}
          {savvyHalf}
        </Box>
      )
    }

    const legend = fitLegend(
      [
        { label: 'main', color: C.main },
        { label: cfg.gateLabel.toLowerCase(), color: C.gate },
        ...(showArchitect ? [{ label: cfg.architectLabel.toLowerCase(), color: C.arch }] : []),
      ],
      W,
    )

    const body = isWide ? (
      <Box flexDirection="column">
        <Box columnGap={2}>
          {column(panels.filter(p => p === 'main' || p === 'architect' || p === 'gate'), colW)}
          {column(panels.filter(p => p === 'agents' || p === 'loops' || p === 'receipt'), colW)}
        </Box>
        {panels.includes('log') ? logPanel(W) : null}
      </Box>
    ) : (
      column(panels, W)
    )

    return (
      <Box flexDirection="column" width={W}>
        <Box justifyContent="center">
          <Text bold wrap="truncate">
            <Text>CONTROL TOWER</Text>
            <Text color={C.dim}> · </Text>
            <Text color={C.main}>{modelName.toUpperCase()}</Text>
            <Text>{m.isRunning ? ' WORKS' : ' IDLE'}</Text>
            {showArchitect ? <Text color={C.dim}> · </Text> : null}
            {showArchitect ? <Text color={C.arch}>{cfg.architectLabel}</Text> : null}
            {showArchitect ? <Text>{advising ? ' ADVISING' : ' ON CALL'}</Text> : null}
          </Text>
        </Box>
        <Box justifyContent="center" columnGap={2}>
          {legend.map(l => (
            <Text>
              <Text color={l.color}>■</Text>
              <Text dimColor>{` ${l.label}`}</Text>
            </Text>
          ))}
        </Box>
        {body}
        {savvyHalf}
      </Box>
    )
  })
}

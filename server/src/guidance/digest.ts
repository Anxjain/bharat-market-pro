// Daily digest (9.3) — the 19:00 scan already computes "what moved / what's setting up /
// what broke a thesis"; this delivers it. Renders the latest persisted board + market
// regime + risk-capped names into one email-safe HTML digest and mails it to the owners.
// Deterministic (reuses the board's stored readout prose — no extra LLM or scoring work).
import * as boardRepo from '../repositories/guidanceBoard'
import * as histRepo from '../repositories/guidancePriceHistory'
import { computeRegime, type Regime } from './regime'
import { weeklyBoard, type Board, type Opportunity } from './scan'
import { sendMail, mailConfigured } from '../mail'

/** Public base URL of this deployment — used for the "open the desk" link in emails.
 *  Set PUBLIC_URL (or DOMAIN) to your own host; falls back to a local dev address. */
const SITE = (process.env.PUBLIC_URL || (process.env.DOMAIN ? `https://${process.env.DOMAIN}` : '') || `http://localhost:${process.env.PORT ?? 9787}`).replace(/\/+$/, '')

/** Owner recipients: DIGEST_TO overrides, else the guidance owner allowlist. */
export function digestRecipients(): string[] {
  return (process.env.DIGEST_TO ?? process.env.GUIDANCE_OWNER_EMAILS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

/** Calendar day (YYYY-MM-DD) in IST — "is this board from today?" must use market time,
 *  not UTC (a 19:00 IST scan is still "today" even after 18:30 UTC). */
export function istDay(d = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const pct = (n: number | null | undefined) => (n == null ? '—' : `${n > 0 ? '+' : ''}${n.toFixed(1)}%`)
const moveColor = (n: number | null | undefined) => (n == null ? '#666' : n >= 0 ? '#1a7f37' : '#c62828')

const TIER_BADGE: Record<string, { bg: string; label: string }> = {
  'high-conviction': { bg: '#1a7f37', label: 'HIGH CONVICTION' },
  constructive: { bg: '#2e7d32', label: 'CONSTRUCTIVE' },
  neutral: { bg: '#8d6e08', label: 'NEUTRAL' },
  avoid: { bg: '#c62828', label: 'AVOID' },
}
const TONE_DOT: Record<string, string> = { up: '#1a7f37', down: '#1565c0', value: '#6a1b9a', warn: '#c62828', info: '#666' }

function regimeBlock(r: Regime): string {
  const bg = r.label === 'risk-on' ? '#e8f5e9' : r.label === 'risk-off' ? '#fdecea' : '#fff8e1'
  const fg = r.label === 'risk-on' ? '#1a7f37' : r.label === 'risk-off' ? '#c62828' : '#8d6e08'
  return `<div style="background:${bg};border-radius:8px;padding:12px 16px;margin:0 0 16px">
    <span style="color:${fg};font-weight:700;text-transform:uppercase;font-size:13px">${r.label}</span>
    <span style="color:#444;font-size:13px"> — ${esc(r.note)}</span>
  </div>`
}

function oppRow(o: Opportunity): string {
  // Boards persisted before a field existed (e.g. `themes`) round-trip without it — never
  // assume shape on JSON read back from the DB.
  const themesArr = o.themes ?? []
  const reasonsArr = o.reasons ?? []
  const badge = TIER_BADGE[o.tier] ?? { bg: '#666', label: String(o.tier ?? '?').toUpperCase() }
  const flags = [
    o.cappedByRisk ? '⚠ risk-capped' : '',
    o.qualityAvoid ? '⛔ fundamentals avoid' : '',
    o.daysSeen && o.daysSeen > 1 ? `recurring ×${o.daysSeen}` : '',
  ].filter(Boolean).join(' · ')
  const reasons = reasonsArr
    .map((r) => `<li style="margin:2px 0;color:#333"><span style="color:${TONE_DOT[r.tone] ?? '#666'}">●</span> ${esc(r.text)}</li>`)
    .join('')
  const themes = themesArr.length ? ` <span style="color:#6a1b9a;font-size:11px">[${themesArr.join(' · ')}]</span>` : ''
  return `<tr><td style="padding:10px 0;border-top:1px solid #eee">
    <div style="font-size:14px">
      <strong>#${o.rank} ${esc(o.symbol)}</strong>${o.name ? ` <span style="color:#666">${esc(o.name)}</span>` : ''}${themes}
      <span style="background:${badge.bg};color:#fff;border-radius:4px;padding:1px 6px;font-size:10px;font-weight:700;margin-left:6px">${badge.label}</span>
      ${o.type === 'dip' ? '<span style="color:#1565c0;font-size:11px;margin-left:4px">dip</span>' : '<span style="color:#1a7f37;font-size:11px;margin-left:4px">riser</span>'}
    </div>
    <div style="font-size:12px;color:#444;margin:2px 0">
      ${o.price != null ? `₹${o.price.toLocaleString('en-IN')}` : ''} ·
      1d <span style="color:${moveColor(o.move1d)}">${pct(o.move1d)}</span> ·
      5d <span style="color:${moveColor(o.move5d)}">${pct(o.move5d)}</span>
      ${o.qualityTier ? ` · quality: ${esc(o.qualityTier)}${o.qualityScore != null ? ` (${o.qualityScore}/100)` : ''}` : ''}
      ${flags ? ` · <span style="color:#c62828">${flags}</span>` : ''}
    </div>
    <div style="font-size:13px;color:#222;margin:4px 0"><em>${esc(o.verdict)}</em></div>
    ${o.odds ? `<div style="font-size:12px;color:#555;margin:2px 0">${esc(o.odds)}</div>` : ''}
    <ul style="margin:4px 0 0;padding-left:18px;font-size:12px">${reasons}</ul>
  </td></tr>`
}

function moversBlock(board: Board): string {
  const cell = (m: { symbol: string; name: string | null; move1d: number }) =>
    `<td style="padding:2px 8px;font-size:12px">${esc(m.symbol)}</td><td style="padding:2px 8px;font-size:12px;color:${moveColor(m.move1d)};text-align:right">${pct(m.move1d)}</td>`
  const rows = Math.max(board.risers.length, board.fallers.length)
  let body = ''
  for (let i = 0; i < rows; i++) {
    body += `<tr>${board.risers[i] ? cell(board.risers[i]) : '<td></td><td></td>'}<td style="width:24px"></td>${board.fallers[i] ? cell(board.fallers[i]) : '<td></td><td></td>'}</tr>`
  }
  return `<table style="border-collapse:collapse;margin:4px 0">
    <tr><th colspan="2" style="text-align:left;font-size:11px;color:#1a7f37;padding:2px 8px">TOP RISERS</th><th></th><th colspan="2" style="text-align:left;font-size:11px;color:#c62828;padding:2px 8px">TOP FALLERS</th></tr>
    ${body}
  </table>`
}

export interface Digest {
  subject: string
  html: string
  text: string
  boardAsOf: string
}

/** Assemble the digest from the latest persisted board. Returns null when there's no board. */
export async function buildDigest(): Promise<Digest | null> {
  const latest = await boardRepo.latest<Board>().catch(() => null)
  if (!latest) return null
  const board = latest.json
  const regime = computeRegime(await histRepo.closesAsc('^NSEI').catch(() => []))
  // Weekly recurrence adds the "durable setup" context (a name that shows up 3 scans
  // running is a different animal from a one-day blip).
  const weekly = await weeklyBoard().catch(() => null)
  const daysSeen = new Map((weekly?.opportunities ?? []).map((o) => [o.symbol, o.daysSeen ?? 1]))

  const opps = board.opportunities.slice(0, 8).map((o) => ({ ...o, daysSeen: daysSeen.get(o.symbol) }))
  const broken = board.opportunities.filter((o) => o.cappedByRisk || o.qualityAvoid)
  const buys = board.buys ?? [] // boards persisted before the buy list round-trip without it

  const day = istDay(new Date(board.asOf))
  const top = opps[0]
  const subject = `Bharat Market Pro digest ${day} — ${regime.label}${buys.length ? ` · ${buys.length} buy${buys.length === 1 ? '' : 's'} today (top: ${buys[0].symbol})` : top ? ` · #1 ${top.symbol} (${top.tier})` : ' · no setups today'}`

  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f5f5f5">
  <div style="max-width:640px;margin:0 auto;padding:24px 16px;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif">
    <div style="background:#fff;border-radius:12px;padding:24px">
      <h1 style="font-size:18px;margin:0 0 4px">Bharat Market Pro — daily guidance digest</h1>
      <div style="color:#666;font-size:12px;margin:0 0 16px">${day} · scanned ${board.scanned} names, deep-scored ${board.deepScored} · <a href="${SITE}" style="color:#1565c0">open the desk</a></div>
      ${regimeBlock(regime)}
      ${buys.length ? `<h2 style="font-size:15px;margin:16px 0 4px;color:#1a7f37">Today's buys</h2>
      <table style="border-collapse:collapse;width:100%">${buys.slice(0, 5).map((b) => `<tr><td style="padding:6px 0;border-top:1px solid #eef5ef">
        <strong>${esc(b.symbol)}</strong>${b.name ? ` <span style="color:#666;font-size:12px">${esc(b.name)}</span>` : ''}
        <span style="background:#1a7f37;color:#fff;border-radius:4px;padding:1px 6px;font-size:10px;font-weight:700;margin-left:6px">${b.tier === 'high-conviction' ? 'HIGH CONVICTION' : 'BUY LEAN'}</span>
        <div style="font-size:12px;color:#444;margin-top:2px">
          ${b.expectancy ? `Expected ₹${(100 + b.expectancy.evPer100).toFixed(1)} per ₹100 in ~${b.expectancy.horizon}d (won ${b.expectancy.winRate}% of comparable setups) · size: ${esc(b.expectancy.size)}` : esc(b.verdict)}
        </div>
      </td></tr>`).join('')}</table>` : ''}
      <h2 style="font-size:15px;margin:16px 0 4px">What's setting up</h2>
      ${opps.length ? `<table style="border-collapse:collapse;width:100%">${opps.map(oppRow).join('')}</table>` : '<div style="color:#666;font-size:13px">No qualifying setups today.</div>'}
      ${broken.length ? `<h2 style="font-size:15px;margin:20px 0 4px;color:#c62828">Thesis breakers / risk caps</h2>
      <ul style="padding-left:18px;font-size:13px;color:#333">${broken.map((o) => `<li><strong>${esc(o.symbol)}</strong> — ${o.qualityAvoid ? 'fundamentals force-avoid' : 'thesis-breaker cap'}: ${esc((o.reasons ?? []).find((r) => r.tone === 'warn')?.text ?? o.verdict)}</li>`).join('')}</ul>` : ''}
      <h2 style="font-size:15px;margin:20px 0 4px">What moved</h2>
      ${moversBlock(board)}
      <div style="color:#999;font-size:11px;margin-top:20px;border-top:1px solid #eee;padding-top:12px">
        Private owner digest — generated from the ${day} scan. ${esc(board.note)}
      </div>
    </div>
  </div></body></html>`

  const textLines = [
    `Bharat Market Pro daily digest — ${day}`,
    `Regime: ${regime.label} — ${regime.note}`,
    '',
    buys.length ? `Today's buys: ${buys.slice(0, 5).map((b) => `${b.symbol}${b.expectancy ? ` (EV ${b.expectancy.evPer100 >= 0 ? '+' : ''}${b.expectancy.evPer100}%/~${b.expectancy.horizon}d)` : ''}`).join(', ')}` : 'No buys today.',
    '',
    'Setting up:',
    ...opps.map((o) => `#${o.rank} ${o.symbol} [${o.tier}] ${pct(o.move1d)} 1d — ${o.verdict}`),
    '',
    broken.length ? `Thesis breakers: ${broken.map((o) => o.symbol).join(', ')}` : '',
    `Risers: ${board.risers.map((m) => `${m.symbol} ${pct(m.move1d)}`).join(', ')}`,
    `Fallers: ${board.fallers.map((m) => `${m.symbol} ${pct(m.move1d)}`).join(', ')}`,
    '',
    SITE,
  ].filter((l) => l !== '')

  return { subject, html, text: textLines.join('\n'), boardAsOf: board.asOf }
}

/**
 * Send the daily digest to the owners. Skips (returns false) when: SMTP unconfigured,
 * no recipients, no board yet, or — unless `force` — the latest board isn't from today
 * IST (don't re-mail yesterday's board when a scan failed).
 */
export async function sendDailyDigest(opts: { force?: boolean } = {}): Promise<boolean> {
  if (!mailConfigured()) {
    console.log('[digest] SMTP not configured — skipping daily digest')
    return false
  }
  const to = digestRecipients()
  if (to.length === 0) {
    console.warn('[digest] no recipients (DIGEST_TO / GUIDANCE_OWNER_EMAILS) — skipping')
    return false
  }
  const digest = await buildDigest()
  if (!digest) {
    console.warn('[digest] no scan board yet — skipping')
    return false
  }
  if (!opts.force && istDay(new Date(digest.boardAsOf)) !== istDay()) {
    console.warn(`[digest] latest board is stale (${digest.boardAsOf}) — skipping (use force to override)`)
    return false
  }
  return sendMail({ to, subject: digest.subject, html: digest.html, text: digest.text })
}

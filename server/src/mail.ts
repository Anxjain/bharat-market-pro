// Outbound email (SMTP via nodemailer). Used by the guidance daily digest (and any
// future alerting) — NOT user-facing signup mail (Supabase owns auth email).
//
// Config is entirely env-driven so environments without SMTP simply no-op:
//   SMTP_HOST / SMTP_PORT (587 default) / SMTP_USER / SMTP_PASS
//   SMTP_FROM   — From header (defaults to SMTP_USER)
//   SMTP_SECURE — 'true' for implicit TLS :465; otherwise STARTTLS on :587
// For Gmail: host smtp.gmail.com, port 587, user = the Gmail address, pass = an
// App Password (Google account → Security → 2-Step Verification → App passwords).
import nodemailer from 'nodemailer'

export function mailConfigured(): boolean {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS)
}

export interface Mail {
  to: string[]
  subject: string
  html: string
  text?: string
}

/** Send one email. Returns false (and logs) instead of throwing — callers are
 *  schedulers/fire-and-forget paths that must never die on a mail hiccup. */
export async function sendMail(mail: Mail): Promise<boolean> {
  if (!mailConfigured()) {
    console.warn('[mail] SMTP not configured (SMTP_HOST/SMTP_USER/SMTP_PASS) — skipping send')
    return false
  }
  if (mail.to.length === 0) {
    console.warn('[mail] no recipients — skipping send')
    return false
  }
  try {
    const port = Number(process.env.SMTP_PORT ?? 587)
    const transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: process.env.SMTP_SECURE === 'true' || port === 465,
      auth: { user: process.env.SMTP_USER!, pass: process.env.SMTP_PASS! },
      connectionTimeout: 20_000,
    })
    const info = await transport.sendMail({
      from: process.env.SMTP_FROM ?? process.env.SMTP_USER,
      to: mail.to.join(', '),
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
    })
    console.log(`[mail] sent "${mail.subject}" to ${mail.to.join(', ')} (${info.messageId})`)
    return true
  } catch (e) {
    console.warn('[mail] send failed:', (e as Error).message)
    return false
  }
}

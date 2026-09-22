// Per-company AI chat panel — grounded in this company's real NSE data
// (quotes, filings, news) with sources listed under every answer; the web-dive
// toggle routes to the agentic model with built-in live web search.
//
// Scrolling is contained: only the message list scrolls — the page never jumps.

import { useEffect, useRef, useState } from 'react'
import { Send, Globe, Sparkle, Link2 } from 'lucide-react'
import { askDesk } from '../lib/api'
import { MarkdownLite } from './MarkdownLite'
import { Disclaimer } from './ui'

interface Msg {
  role: 'user' | 'assistant'
  content: string
  sources?: string[]
}

export function CompanyChat({ symbol, name }: { symbol: string; name: string }) {
  const [messages, setMessages] = useState<Msg[]>([])
  const [input, setInput] = useState('')
  const [thinking, setThinking] = useState(false)
  const [webDive, setWebDive] = useState(true) // web-dive ON by default; user can toggle off
  const listRef = useRef<HTMLDivElement>(null)

  // Scroll ONLY the message list (never the page)
  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, thinking])

  const suggestions = [
    `What has ${name.split(' ')[0]} filed recently?`,
    'How has the stock moved this month?',
    'Any red flags in recent disclosures?',
  ]

  async function send(text: string) {
    const q = text.trim()
    if (!q || thinking) return
    const history: Msg[] = [...messages, { role: 'user', content: q }]
    setMessages(history)
    setInput('')
    setThinking(true)
    const res = await askDesk(history.map((m) => ({ role: m.role, content: m.content })), { symbol, webDive })
    setMessages((prev) => [
      ...prev,
      res
        ? { role: 'assistant', content: res.answer, sources: res.grounded }
        : {
            role: 'assistant',
            content: 'The AI desk is unreachable right now. Live filings and price data on this page remain available — try again in a moment.',
          },
    ])
    setThinking(false)
  }

  return (
    <div className="card flex flex-col p-4">
      <div className="mb-2 flex items-center gap-2">
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-up-soft text-up">
          <Sparkle size={13} />
        </span>
        <h3 className="text-[13px] font-bold text-ink">Ask about {name}</h3>
        <button
          onClick={() => setWebDive((w) => !w)}
          title={webDive ? 'Web dive ON — answers may search the live web' : 'Web dive OFF — auto-escalates to web search only when needed'}
          className={`ml-auto flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide transition ${
            webDive ? 'border-info-soft bg-info-soft text-[#2186c4]' : 'border-line bg-surface text-faint hover:text-muted'
          }`}
        >
          <Globe size={11} /> Web dive {webDive ? 'on' : 'off'}
        </button>
      </div>

      <div ref={listRef} className="max-h-[300px] min-h-[120px] flex-1 space-y-3 overflow-y-auto overscroll-contain rounded-xl bg-panel p-3">
        {messages.length === 0 && !thinking && (
          <p className="text-[12px] text-faint">
            Grounded in {symbol}'s live NSE price, filings and news — and it dives into the live web when our data isn't enough.
          </p>
        )}
        {messages.map((m, i) => (
          <div key={i} className={m.role === 'user' ? 'flex justify-end' : ''}>
            {m.role === 'user' ? (
              <span className="inline-block max-w-[85%] rounded-xl rounded-br-sm bg-inkfill px-3 py-2 text-[12px] font-medium text-white">
                {m.content}
              </span>
            ) : (
              <div className="max-w-[95%] rounded-xl rounded-bl-sm border border-line bg-surface px-3 py-2">
                <MarkdownLite text={m.content} />
                {m.sources && m.sources.length > 0 && (
                  <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-line pt-1.5">
                    <Link2 size={10} className="text-faint" />
                    {m.sources.map((s) => (
                      <span key={s} className="rounded-full bg-panel px-2 py-0.5 text-[9.5px] font-bold uppercase tracking-wide text-muted">
                        {s}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
        {thinking && (
          <p className="text-[12px] italic text-faint">{webDive ? 'Diving — checking our data and the live web…' : 'Checking the data stores…'}</p>
        )}
      </div>

      <div className="mt-2.5 flex flex-wrap gap-1.5">
        {suggestions.map((s) => (
          <button
            key={s}
            onClick={() => send(s)}
            className="rounded-full border border-line bg-surface px-2.5 py-1 text-[10.5px] font-semibold text-muted shadow-sm transition hover:-translate-y-0.5 hover:text-ink"
          >
            {s}
          </button>
        ))}
      </div>

      <form onSubmit={(e) => { e.preventDefault(); send(input) }} className="mt-2 flex gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={`Ask anything about ${symbol}…`}
          className="flex-1 rounded-full border border-line bg-surface px-3.5 py-2 text-[12.5px] text-ink transition placeholder:text-faint focus:border-line focus:shadow-[0_2px_10px_rgba(16,24,40,0.06)] focus:outline-none"
        />
        <button type="submit" disabled={!input.trim() || thinking} className="btn btn-red !px-4 !py-2">
          <Send size={13} />
        </button>
      </form>
      <Disclaimer />
    </div>
  )
}

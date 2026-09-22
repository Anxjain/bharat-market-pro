import { useEffect, useRef, useState } from 'react'
import { Send, Sparkle, Globe } from 'lucide-react'
import { answerQuery, type ChatMessage } from '../lib/chat'
import { askDesk, askAgent, type AgentTraceLine } from '../lib/api'
import { PageHeader, Disclaimer } from '../components/ui'
import { MarkdownLite } from '../components/MarkdownLite'

const SUGGESTIONS = [
  'Market summary today',
  'Compare TCS vs Infosys',
  'What are the biggest risks right now?',
  'How is the insurance sector doing?',
  'Latest news on Bajaj Finance',
  'Show high-materiality filings',
]

const WELCOME: ChatMessage = {
  role: 'assistant',
  content:
    'Hello — this is the Bharat Market Pro research desk. Ask anything grounded in the current coverage file: companies, fundamentals, news, NSE/BSE filings and risk flags.\n\nWant a direct view — buy, sell or hold? Just ask. What would you like to look into?',
}

function DeskAvatar() {
  return (
    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-up-soft text-up shadow-sm">
      <Sparkle size={14} />
    </span>
  )
}

type Msg = ChatMessage & { sources?: string[]; trace?: AgentTraceLine[] }

export function Chat() {
  const [messages, setMessages] = useState<Msg[]>([WELCOME])
  const [input, setInput] = useState('')
  const [thinking, setThinking] = useState(false)
  const [engine, setEngine] = useState<'llm' | 'rules' | null>(null)
  const [webDive, setWebDive] = useState(true) // web-dive ON by default; user can toggle off
  const listRef = useRef<HTMLDivElement>(null)
  // Guard against applying a slow (≤90s) LLM response after the user left the page.
  const mountedRef = useRef(true)
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false } }, [])

  // Scroll only the message list — never the page
  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, thinking])

  async function send(text: string) {
    const q = text.trim()
    if (!q || thinking) return
    const history: Msg[] = [...messages, { role: 'user', content: q }]
    setMessages(history)
    setInput('')
    setThinking(true)
    // Agent desk first (9.2): plan → tools → cited answer for company-specific questions.
    // The server 503s when no NIFTY 500 name matched or the loop failed, and we fall
    // back to the classic grounded chat, then the offline rule engine.
    const agent = await askAgent(q)
    if (!mountedRef.current) return
    if (agent) {
      setMessages((prev) => [...prev, { role: 'assistant', content: agent.answer, sources: agent.grounded, trace: agent.toolTrace }])
      setEngine('llm')
      setThinking(false)
      return
    }
    // Server LLM (grounded in real NSE data + auto web escalation); rule engine offline fallback.
    const res = await askDesk(history.slice(1).map((m) => ({ role: m.role, content: m.content })), { webDive })
    if (!mountedRef.current) return
    setMessages((prev) => [
      ...prev,
      res ? { role: 'assistant', content: res.answer, sources: res.grounded } : { role: 'assistant', content: answerQuery(q) },
    ])
    setEngine(res ? 'llm' : 'rules')
    setThinking(false)
  }

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col">
      <PageHeader
        title="Research Chat"
        subtitle={
          engine === 'llm'
            ? 'AI engine · grounded in live NSE prices, filings and news'
            : engine === 'rules'
              ? 'Standby engine answered (AI busy) — it retries automatically on your next message'
              : 'Grounded in live NSE prices, filings and news'
        }
      />

      <div className="card flex min-h-0 flex-1 flex-col">
        <div ref={listRef} className="flex-1 space-y-4 overflow-y-auto overscroll-contain p-4">
          {messages.map((m, i) => (
            <div key={i} className={`flex gap-2.5 ${m.role === 'user' ? 'justify-end' : ''}`}>
              {m.role === 'assistant' && <DeskAvatar />}
              <div
                className={`max-w-[80%] rounded-2xl px-4 py-3 ${
                  m.role === 'user'
                    ? 'rounded-br-md bg-inkfill text-[13px] font-medium text-white shadow-[0_6px_16px_rgba(22,24,29,0.2)]'
                    : 'rounded-bl-md bg-panel'
                }`}
              >
                {m.trace && m.trace.length > 0 && (
                  <div className="mb-2 space-y-0.5 border-b border-line pb-2">
                    {m.trace.map((t, j) => (
                      <div key={j} className="text-[11px] text-faint">
                        · {t.summary}
                      </div>
                    ))}
                  </div>
                )}
                {m.role === 'assistant' ? <MarkdownLite text={m.content} /> : m.content}
                {m.sources && m.sources.length > 0 && (
                  <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-line pt-1.5">
                    <span className="text-[9.5px] font-bold uppercase tracking-wide text-faint">Sources</span>
                    {m.sources.map((s) => (
                      <span key={s} className="rounded-full bg-surface px-2 py-0.5 text-[9.5px] font-bold uppercase tracking-wide text-muted ring-1 ring-[#ececf0]">
                        {s}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ))}
          {thinking && (
            <div className="flex gap-2.5">
              <DeskAvatar />
              <div className="rounded-2xl rounded-bl-md bg-panel px-4 py-3 text-[12.5px] text-faint">
                {webDive
                  ? 'Researching — agent desk (quotes, filings, news, fundamentals), then the live web…'
                  : 'Researching — agent desk (quotes, filings, news, fundamentals)…'}
              </div>
            </div>
          )}
        </div>

        <div className="border-t border-line p-4">
          <div className="mb-3 flex items-center gap-2">
            <span className="text-[11px] font-semibold text-faint">
              {webDive ? 'Web dive on — every answer searches the live web' : 'Auto: dives the web when our data isn’t enough'}
            </span>
            <button
              type="button"
              onClick={() => setWebDive((w) => !w)}
              title={webDive ? 'Web dive ON — every answer searches the live web' : 'Web dive OFF — auto-escalates to web search only when our data falls short'}
              className={`ml-auto flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide transition ${
                webDive ? 'border-info-soft bg-info-soft text-[#2186c4]' : 'border-line bg-surface text-faint hover:text-muted'
              }`}
            >
              <Globe size={11} /> Web dive {webDive ? 'on' : 'off'}
            </button>
          </div>
          <div className="mb-3 flex flex-wrap gap-1.5">
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                onClick={() => send(s)}
                className="rounded-full border border-line bg-surface px-3 py-1 text-[11px] font-semibold text-muted shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:text-ink hover:shadow-md"
              >
                {s}
              </button>
            ))}
          </div>
          <form onSubmit={(e) => { e.preventDefault(); send(input) }} className="flex gap-2">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask the desk about companies, risks, filings, news, sectors…"
              className="flex-1 rounded-full border border-line bg-panel px-4 py-2.5 text-[13px] text-ink transition-all duration-200 placeholder:text-faint focus:border-line focus:bg-surface focus:shadow-[0_4px_16px_rgba(16,24,40,0.08)] focus:outline-none"
            />
            <button type="submit" disabled={!input.trim() || thinking} className="btn btn-red !px-5">
              <Send size={14} /> Send
            </button>
          </form>
          <Disclaimer />
        </div>
      </div>
    </div>
  )
}

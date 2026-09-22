// Minimal markdown renderer for chat/report previews.
// Supports: **bold**, _italic_, bullet lists, pipe tables, headings, paragraphs.
// Deliberately tiny — avoids a full markdown dependency for the prototype.

import { Fragment, type ReactNode } from 'react'

function inline(text: string): ReactNode[] {
  const parts: ReactNode[] = []
  // split on **bold** and _italic_. Underscores must sit on word boundaries so
  // snake_case identifiers (drop_1d, cfo_to_op) aren't mangled into italics.
  const regex = /(\*\*[^*]+\*\*|(?<![A-Za-z0-9])_[^_\n]+_(?![A-Za-z0-9]))/g
  let last = 0
  let m: RegExpExecArray | null
  let key = 0
  while ((m = regex.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index))
    const token = m[0]
    if (token.startsWith('**')) parts.push(<strong key={key++} className="font-semibold text-ink">{token.slice(2, -2)}</strong>)
    else parts.push(<em key={key++} className="text-muted">{token.slice(1, -1)}</em>)
    last = m.index + token.length
  }
  if (last < text.length) parts.push(text.slice(last))
  return parts
}

export function MarkdownLite({ text }: { text: string }) {
  const lines = text.split('\n')
  const blocks: ReactNode[] = []
  let i = 0
  let key = 0

  while (i < lines.length) {
    const line = lines[i]

    if (line.trim() === '') { i++; continue }

    // table block
    if (line.trim().startsWith('|')) {
      const tableLines: string[] = []
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        tableLines.push(lines[i].trim())
        i++
      }
      const rows = tableLines
        .filter((l) => !/^\|[\s\-|:]+\|?$/.test(l)) // drop separator row (trailing pipe optional)
        .map((l) => l.replace(/^\||\|$/g, '').split('|').map((c) => c.trim())) // tolerate a missing trailing pipe
      // A block that is ONLY a separator (LLMs emit `|---|` on truncation) leaves rows=[]
      // → destructuring head would crash. Skip it instead of white-screening the app.
      if (!rows.length || !rows[0]) { continue }
      const [head, ...body] = rows
      blocks.push(
        <div key={key++} className="my-2 overflow-x-auto">
          <table className="w-full text-[12.5px]">
            <thead>
              <tr className="border-b border-line text-left text-muted">
                {head.map((h, j) => <th key={j} className="py-1.5 pr-4 font-medium">{inline(h)}</th>)}
              </tr>
            </thead>
            <tbody>
              {body.map((r, j) => (
                <tr key={j} className="border-b border-line/70 last:border-0">
                  {r.map((c, k) => <td key={k} className="py-1.5 pr-4 text-muted">{inline(c)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      )
      continue
    }

    // bullet list block
    if (line.trim().startsWith('- ')) {
      const items: string[] = []
      while (i < lines.length && lines[i].trim().startsWith('- ')) {
        items.push(lines[i].trim().slice(2))
        i++
      }
      blocks.push(
        <ul key={key++} className="my-1.5 space-y-1.5 pl-1">
          {items.map((it, j) => (
            <li key={j} className="flex gap-2 leading-relaxed">
              <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-red-400" />
              <span>{inline(it)}</span>
            </li>
          ))}
        </ul>,
      )
      continue
    }

    // headings
    if (line.startsWith('#')) {
      const level = line.match(/^#+/)![0].length
      const content = line.replace(/^#+\s*/, '')
      blocks.push(
        <div key={key++} className={`mt-4 mb-1.5 font-medium text-ink ${level === 1 ? 'text-[20px]' : level === 2 ? 'text-[16px]' : 'text-[14px] italic'}`}>
          {inline(content)}
        </div>,
      )
      i++
      continue
    }

    // paragraph (consume consecutive non-special lines)
    const para: string[] = []
    while (i < lines.length && lines[i].trim() !== '' && !lines[i].trim().startsWith('|') && !lines[i].trim().startsWith('- ') && !lines[i].startsWith('#')) {
      para.push(lines[i])
      i++
    }
    blocks.push(<p key={key++} className="my-1.5 leading-relaxed">{para.map((p, j) => <Fragment key={j}>{inline(p)}{j < para.length - 1 ? ' ' : ''}</Fragment>)}</p>)
  }

  return <div className="text-[13px] text-muted">{blocks}</div>
}

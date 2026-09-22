// On-demand Excel (.xlsx) exports for the ULIP explorer. Data is read through the
// repository layer (no raw SQL here). Four workbooks: company-wise, section-wise,
// comparative, and consolidated holdings. Every workbook carries source
// attribution.
import ExcelJS from 'exceljs'
import * as insurersRepo from '../repositories/insurers'
import * as fundsRepo from '../repositories/funds'
import * as fundReturnsRepo from '../repositories/fundReturns'
import * as fundAllocationsRepo from '../repositories/fundAllocations'
import * as fundHoldingsRepo from '../repositories/fundHoldings'
import * as views from '../repositories/ulipViews'
import type { FundRow } from '../repositories/funds'

const ATTRIBUTION =
  'Data sourced from insurer public ULIP fact-sheets. Verify against the original insurer factsheet before use.'

const PERIOD_ORDER = ['1M', '3M', '6M', 'YTD', '1Y', '2Y', '3Y', '4Y', '5Y', '7Y', '10Y', 'Inception']

function orderPeriods(periods: string[]): string[] {
  const known = PERIOD_ORDER.filter((p) => periods.includes(p))
  const rest = periods.filter((p) => !PERIOD_ORDER.includes(p)).sort()
  return [...known, ...rest]
}

function addAbout(wb: ExcelJS.Workbook, title: string, month: string): void {
  const ws = wb.addWorksheet('About')
  ws.columns = [{ width: 22 }, { width: 90 }]
  ws.addRow(['Bharat Market Pro — ULIP export', title])
  ws.addRow(['As-of month', month])
  ws.addRow(['Generated', new Date().toISOString()])
  ws.addRow(['Source', ATTRIBUTION])
  ws.getColumn(1).font = { bold: true }
  ws.getRow(4).alignment = { wrapText: true, vertical: 'top' }
}

function header(ws: ExcelJS.Worksheet): void {
  ws.getRow(1).font = { bold: true }
  ws.getRow(1).alignment = { vertical: 'middle' }
  ws.views = [{ state: 'frozen', ySplit: 1 }]
}

async function toBuffer(wb: ExcelJS.Workbook): Promise<Buffer> {
  return Buffer.from(await wb.xlsx.writeBuffer())
}

function returnsMap(rows: { period: string; returnPct: number | null; benchmarkPct: number | null }[]): Map<string, { r: number | null; b: number | null }> {
  return new Map(rows.map((x) => [x.period, { r: x.returnPct, b: x.benchmarkPct }]))
}

// ——— (1) Company-wise: one insurer's funds + their holdings ———
export async function buildCompanyWorkbook(insurerCode: string, month: string): Promise<{ buffer: Buffer; filename: string }> {
  const insurer = await insurersRepo.get(insurerCode)
  const funds = await fundsRepo.listVisible(insurerCode, month)
  const wb = new ExcelJS.Workbook()
  addAbout(wb, `${insurer?.name ?? insurerCode} — funds`, month)

  const fws = wb.addWorksheet('Funds')
  fws.columns = [
    { header: 'SFIN', key: 'sfin', width: 30 },
    { header: 'Fund', key: 'name', width: 34 },
    { header: 'Class', key: 'class', width: 12 },
    { header: 'Category', key: 'category', width: 20 },
    { header: 'NAV', key: 'nav', width: 12 },
    { header: 'AUM (Cr)', key: 'aum', width: 14 },
    { header: 'Benchmark', key: 'benchmark', width: 18 },
    { header: 'Manager', key: 'manager', width: 22 },
    { header: 'Status', key: 'status', width: 12 },
    { header: 'Confidence', key: 'confidence', width: 12 },
  ]
  for (const f of funds) {
    fws.addRow({ sfin: f.sfin, name: f.name, class: f.class, category: f.category, nav: f.nav, aum: f.aumTotalCr, benchmark: f.benchmark, manager: f.manager, status: f.status, confidence: f.confidence })
  }
  header(fws)

  const hws = wb.addWorksheet('Holdings')
  hws.columns = [
    { header: 'Fund', key: 'fund', width: 34 },
    { header: 'SFIN', key: 'sfin', width: 30 },
    { header: 'Security', key: 'security', width: 40 },
    { header: 'Weight %', key: 'weight', width: 12 },
    { header: 'NSE Symbol', key: 'symbol', width: 16 },
  ]
  for (const f of funds) {
    const holds = await fundHoldingsRepo.getForFund(f.sfin, month)
    for (const h of holds) hws.addRow({ fund: f.name, sfin: f.sfin, security: h.security, weight: h.weightPct, symbol: h.normalizedSymbol })
  }
  header(hws)

  return { buffer: await toBuffer(wb), filename: `ulip_${insurer?.adapterId ?? insurerCode}_${month}.xlsx` }
}

// ——— (2) Section-wise: all funds of a category across insurers ———
export async function buildSectionWorkbook(category: string, month: string): Promise<{ buffer: Buffer; filename: string }> {
  const funds = await fundsRepo.byCategory(month, category)
  const wb = new ExcelJS.Workbook()
  addAbout(wb, `Section — ${category}`, month)
  const ws = wb.addWorksheet('Funds')
  ws.columns = [
    { header: 'Insurer', key: 'insurer', width: 10 },
    { header: 'Fund', key: 'name', width: 34 },
    { header: 'SFIN', key: 'sfin', width: 30 },
    { header: 'NAV', key: 'nav', width: 12 },
    { header: 'AUM (Cr)', key: 'aum', width: 14 },
    { header: '1Y %', key: 'y1', width: 10 },
    { header: '3Y %', key: 'y3', width: 10 },
    { header: 'Inception %', key: 'inc', width: 12 },
    { header: 'Status', key: 'status', width: 12 },
  ]
  for (const f of funds) {
    const rm = returnsMap(await fundReturnsRepo.getForFund(f.sfin, month))
    ws.addRow({ insurer: f.insurer, name: f.name, sfin: f.sfin, nav: f.nav, aum: f.aumTotalCr, y1: rm.get('1Y')?.r ?? null, y3: rm.get('3Y')?.r ?? null, inc: rm.get('Inception')?.r ?? null, status: f.status })
  }
  header(ws)
  return { buffer: await toBuffer(wb), filename: `ulip_section_${category.replace(/[^a-z0-9]+/gi, '-')}_${month}.xlsx` }
}

// ——— (3) Comparative: selected funds side by side (returns + asset allocation) ———
export async function buildComparativeWorkbook(sfins: string[], month: string): Promise<{ buffer: Buffer; filename: string }> {
  const funds: FundRow[] = []
  for (const sfin of sfins) {
    const f = await fundsRepo.getBySfinMonth(sfin, month)
    if (f) funds.push(f)
  }
  const wb = new ExcelJS.Workbook()
  addAbout(wb, `Comparative — ${funds.map((f) => f.name).join(' vs ')}`, month)

  // Overview
  const ows = wb.addWorksheet('Overview')
  ows.columns = [{ header: 'Field', key: 'field', width: 18 }, ...funds.map((f) => ({ header: f.name, key: f.sfin, width: 26 }))]
  const row = (field: string, get: (f: FundRow) => unknown) => { const r: Record<string, unknown> = { field }; for (const f of funds) r[f.sfin] = get(f); ows.addRow(r) }
  row('Insurer', (f) => f.insurer)
  row('SFIN', (f) => f.sfin)
  row('NAV', (f) => f.nav)
  row('AUM (Cr)', (f) => f.aumTotalCr)
  row('Benchmark', (f) => f.benchmark)
  row('Category', (f) => f.category)
  header(ows)

  // Returns matrix (period rows × fund columns)
  const retByFund = new Map<string, Map<string, { r: number | null; b: number | null }>>()
  const periodSet = new Set<string>()
  for (const f of funds) {
    const rm = returnsMap(await fundReturnsRepo.getForFund(f.sfin, month))
    retByFund.set(f.sfin, rm)
    rm.forEach((_, p) => periodSet.add(p))
  }
  const rws = wb.addWorksheet('Returns')
  rws.columns = [{ header: 'Period', key: 'period', width: 14 }, ...funds.map((f) => ({ header: f.name, key: f.sfin, width: 26 }))]
  for (const p of orderPeriods([...periodSet])) {
    const r: Record<string, unknown> = { period: p }
    for (const f of funds) r[f.sfin] = retByFund.get(f.sfin)?.get(p)?.r ?? null
    rws.addRow(r)
  }
  header(rws)

  // Asset allocation matrix (label rows × fund columns)
  const allocByFund = new Map<string, Map<string, number | null>>()
  const labelSet = new Set<string>()
  for (const f of funds) {
    const rows = (await fundAllocationsRepo.getForFund(f.sfin, month)).filter((a) => a.kind === 'asset')
    const m = new Map(rows.map((a) => [a.label, a.weight]))
    allocByFund.set(f.sfin, m)
    m.forEach((_, l) => labelSet.add(l))
  }
  const aws = wb.addWorksheet('Asset Allocation')
  aws.columns = [{ header: 'Asset', key: 'asset', width: 22 }, ...funds.map((f) => ({ header: f.name, key: f.sfin, width: 26 }))]
  for (const l of [...labelSet]) {
    const r: Record<string, unknown> = { asset: l }
    for (const f of funds) r[f.sfin] = allocByFund.get(f.sfin)?.get(l) ?? null
    aws.addRow(r)
  }
  header(aws)

  return { buffer: await toBuffer(wb), filename: `ulip_compare_${month}.xlsx` }
}

// ——— (4) Consolidated: every holding rolled up by security + insurer ———
export async function buildConsolidatedWorkbook(month: string): Promise<{ buffer: Buffer; filename: string }> {
  const rolled = await views.rolledHoldings(month)
  const wb = new ExcelJS.Workbook()
  addAbout(wb, 'Consolidated cross-insurer holdings', month)

  const ws = wb.addWorksheet('Holdings')
  ws.columns = [
    { header: 'NSE Symbol', key: 'symbol', width: 16 },
    { header: 'Company', key: 'company', width: 34 },
    { header: 'Security (as printed)', key: 'security', width: 40 },
    { header: 'Insurer', key: 'insurer', width: 10 },
    { header: 'Insurer Name', key: 'insurerName', width: 26 },
    { header: 'Fund', key: 'fund', width: 34 },
    { header: 'SFIN', key: 'sfin', width: 30 },
    { header: 'Weight %', key: 'weight', width: 12 },
  ]
  for (const h of rolled) {
    ws.addRow({ symbol: h.symbol, company: h.company, security: h.security, insurer: h.insurer, insurerName: h.insurerName, fund: h.fundName, sfin: h.sfin, weight: h.weightPct })
  }
  header(ws)

  // Summary by mapped security: how many funds/insurers hold it.
  const bySym = new Map<string, { company: string | null; funds: number; insurers: Set<string>; maxWeight: number }>()
  for (const h of rolled) {
    if (!h.symbol) continue
    const cur = bySym.get(h.symbol) ?? { company: h.company, funds: 0, insurers: new Set<string>(), maxWeight: 0 }
    cur.funds++
    cur.insurers.add(h.insurer)
    if ((h.weightPct ?? 0) > cur.maxWeight) cur.maxWeight = h.weightPct ?? 0
    bySym.set(h.symbol, cur)
  }
  const sws = wb.addWorksheet('By Security')
  sws.columns = [
    { header: 'NSE Symbol', key: 'symbol', width: 16 },
    { header: 'Company', key: 'company', width: 34 },
    { header: '# Funds', key: 'funds', width: 10 },
    { header: '# Insurers', key: 'insurers', width: 12 },
    { header: 'Max Weight %', key: 'max', width: 14 },
  ]
  for (const [symbol, v] of [...bySym].sort((a, b) => b[1].funds - a[1].funds)) {
    sws.addRow({ symbol, company: v.company, funds: v.funds, insurers: v.insurers.size, max: Math.round(v.maxWeight * 100) / 100 })
  }
  header(sws)

  return { buffer: await toBuffer(wb), filename: `ulip_consolidated_${month}.xlsx` }
}

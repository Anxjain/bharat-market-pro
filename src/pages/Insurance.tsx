import { PageHeader } from '../components/ui'
import { UlipExplorer } from '../components/ulip/UlipExplorer'

// Insurance Monitor — the real, live ULIP fund explorer only. The earlier
// illustrative/sample sections (listed-insurer prices, value/underwriting KPI
// ledgers, sample sector news) were removed so the page is 100% real data.
export function Insurance() {
  return (
    <div>
      <PageHeader
        title="Insurance Monitor"
        subtitle="ULIP fund explorer across Indian life insurers — funds, holdings, returns & exports"
      />
      <UlipExplorer />
    </div>
  )
}

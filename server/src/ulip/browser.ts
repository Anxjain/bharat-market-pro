// Headless-Chromium fetch for bot-protected / tokenised insurer sites (SBI,
// ICICI Pru). Dependency-light + VM-portable: only engages when ULIP_CHROMIUM=1
// AND an optional Chromium driver ('puppeteer') is installed; otherwise returns
// null so archive() degrades to the bundled reference file. CHROMIUM_PATH lets
// the VM point at a system Chromium. The 'puppeteer' specifier is resolved
// dynamically (variable) so the project doesn't hard-depend on it.
export interface ChromiumResult {
  buffer: Buffer
  contentType: string
}

export async function chromiumAvailable(): Promise<boolean> {
  if (process.env.ULIP_CHROMIUM !== '1') return false
  const mod = await loadDriver()
  return mod != null
}

async function loadDriver(): Promise<unknown> {
  const name = process.env.ULIP_CHROMIUM_DRIVER ?? 'puppeteer'
  try {
    return await import(/* @vite-ignore */ name)
  } catch {
    return null
  }
}

/** Fetch a URL through headless Chromium; null if disabled/unavailable/failed. */
export async function fetchViaChromium(url: string, opts: { timeoutMs?: number } = {}): Promise<ChromiumResult | null> {
  if (process.env.ULIP_CHROMIUM !== '1') return null
  const driver = (await loadDriver()) as
    | { launch: (o: unknown) => Promise<any> } // eslint-disable-line @typescript-eslint/no-explicit-any
    | null
  if (!driver) {
    console.warn('[ulip] ULIP_CHROMIUM=1 but no Chromium driver installed — falling back')
    return null
  }
  let browser: any // eslint-disable-line @typescript-eslint/no-explicit-any
  try {
    browser = await driver.launch({
      headless: true,
      executablePath: process.env.CHROMIUM_PATH || undefined,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    })
    const page = await browser.newPage()
    const resp = await page.goto(url, { waitUntil: 'networkidle2', timeout: opts.timeoutMs ?? 60_000 })
    if (!resp) return null
    const buffer = Buffer.from(await resp.buffer())
    const contentType = String(resp.headers()?.['content-type'] ?? '')
    return { buffer, contentType }
  } catch (e) {
    console.warn(`[ulip] chromium fetch failed: ${(e as Error).message}`)
    return null
  } finally {
    if (browser) await browser.close().catch(() => {})
  }
}

/** Fetch listing HTML via Chromium (rendered DOM); null if unavailable. */
export async function fetchHtmlViaChromium(url: string): Promise<string | null> {
  const r = await fetchViaChromium(url)
  return r ? r.buffer.toString('utf8') : null
}

/**
 * Open a browser session on a base page, then fetch JSON API endpoints FROM WITHIN that
 * page (same-origin, with the anti-bot session cookies the page's JS sets). This defeats
 * edge WAFs (e.g. ICICI's Akamai) that 403 plain server-side requests but allow XHRs from
 * a real, challenge-solved browser context. Returns null when Chromium is unavailable.
 */
export interface ApiSession {
  fetchText(url: string): Promise<string>
  close(): Promise<void>
}
export async function openApiSession(basePageUrl: string, opts: { timeoutMs?: number } = {}): Promise<ApiSession | null> {
  if (process.env.ULIP_CHROMIUM !== '1') return null
  const driver = (await loadDriver()) as { launch: (o: unknown) => Promise<any> } | null // eslint-disable-line @typescript-eslint/no-explicit-any
  if (!driver) { console.warn('[ulip] openApiSession: no Chromium driver'); return null }
  let browser: any // eslint-disable-line @typescript-eslint/no-explicit-any
  try {
    browser = await driver.launch({
      headless: true,
      executablePath: process.env.CHROMIUM_PATH || undefined,
      // Hide the headless fingerprint (Akamai flags "HeadlessChrome"): a real UA, a real
      // window size, and the automation flags disabled.
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled', '--window-size=1366,900'],
    })
    const page = await browser.newPage()
    const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    await page.setUserAgent(CHROME_UA)
    await page.setViewport({ width: 1366, height: 900 })
    await page.evaluateOnNewDocument(() => {
      // strip the webdriver flag the anti-bot checks for
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
    })
    // Load the base page so its JS runs and sets the WAF/session cookies before we XHR.
    await page.goto(basePageUrl, { waitUntil: 'networkidle2', timeout: opts.timeoutMs ?? 60_000 })
    // Give the Akamai sensor a moment to POST and validate the _abck cookie.
    await new Promise((r) => setTimeout(r, 4000))
    return {
      async fetchText(url: string): Promise<string> {
        return page.evaluate(
          (u: string) => fetch(u, { headers: { Accept: 'application/json, text/plain, */*' } }).then((r) => r.text()),
          url,
        )
      },
      async close() { if (browser) await browser.close().catch(() => {}) },
    }
  } catch (e) {
    console.warn(`[ulip] openApiSession failed: ${(e as Error).message}`)
    if (browser) await browser.close().catch(() => {})
    return null
  }
}

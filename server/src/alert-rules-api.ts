// HTTP routes for the rule-based alerts engine (9.7), mounted at /api/alert-rules.
// Kept as its own sub-app so index.ts only carries a one-line mount; all SQL stays
// in repositories and all evaluation logic in alert-rules.ts.
import { Hono } from 'hono'
import {
  ruleConditionsSchema,
  listRulesWithHits,
  createRule,
  setRuleEnabled,
  deleteRule,
  evaluateAlertRules,
} from './alert-rules'
import { userFromAuthHeader, authEnabled } from './auth'

export const alertRulesApi = new Hono()

// AUDIT FIX (2026-07-14): these routes were fully public — anyone could create/toggle/
// delete rules or trigger the evaluation + email blast. Mutations now require a valid
// login; reads stay open (same posture as price alerts). When auth isn't configured
// (local dev without Supabase) the gate is a no-op so dev flows keep working.
alertRulesApi.use('*', async (c, next) => {
  if (c.req.method === 'GET' || !authEnabled()) return next()
  const user = await userFromAuthHeader(c.req.header('Authorization'))
  if (!user) return c.json({ error: 'login required' }, 401)
  await next()
})

// Rules + the most recent hits (rule names resolved).
alertRulesApi.get('/', async (c) => c.json(await listRulesWithHits()))

alertRulesApi.post('/', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { name?: unknown; conditions?: unknown } | null
  const name = typeof body?.name === 'string' ? body.name.trim() : ''
  if (!name || name.length > 120) return c.json({ error: 'name (non-empty string, ≤120 chars) required' }, 400)
  const parsed = ruleConditionsSchema.safeParse(body?.conditions)
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.') || 'conditions'}: ${i.message}`).join('; ')
    return c.json({ error: `invalid conditions — ${msg}` }, 400)
  }
  return c.json({ rule: await createRule(name, parsed.data) })
})

alertRulesApi.patch('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'invalid rule id' }, 400)
  const body = (await c.req.json().catch(() => null)) as { enabled?: unknown } | null
  if (typeof body?.enabled !== 'boolean') return c.json({ error: 'enabled (boolean) required' }, 400)
  await setRuleEnabled(id, body.enabled)
  return c.json({ ok: true })
})

alertRulesApi.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'invalid rule id' }, 400)
  await deleteRule(id)
  return c.json({ ok: true })
})

// Manual evaluation (same code path the 18:50 scheduler runs). Never throws.
alertRulesApi.post('/run', async (c) => c.json(await evaluateAlertRules()))

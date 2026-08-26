import { createHash, randomBytes } from 'node:crypto'
import { appendFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { execFile as execFileCallback, spawn, type ChildProcess } from 'node:child_process'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { createOpencodeClient } from '@opencode-ai/sdk/v2'
import { OPENCODE_VERSION } from '../packages/cli/src/constants.js'
import { OpenCodeGateway } from '../packages/cli/src/opencode/gateway.js'
import { DEFAULT_CUPPET_INSTRUCTION, startOpenCodeServer } from '../packages/cli/src/opencode/server.js'
import { RedactedLogger } from '../packages/cli/src/runtime/logger.js'
import { resolveRuntimeAssets } from '../packages/cli/src/runtime/assets.js'
import { createRuntimePaths } from '../packages/cli/src/runtime/paths.js'
import { startTstDaemon, type TstRuntime } from '../packages/cli/src/tst/supervisor.js'
import type { AgentEvent, ModelRef, TokenUsage } from '../packages/cli/src/types.js'
import { openDeepSeekBenchmarkSession, type DeepSeekBenchmarkSession } from './lib/deepseek-benchmark.js'
import { DEEPSEEK_HARNESS_CODING_SYSTEM_PROMPT, type DeepSeekTokenTotals } from './lib/deepseek-harness.js'

type Arm = 'opencode' | 'cuppet' | 'deepseek-harness'
type PatternCheck = { name: string; file: string; pattern: RegExp; min?: number }
type HardTask = {
  slug: string
  title: string
  prompt: string
  requiredFiles: string[]
  patterns: PatternCheck[]
  verifier: (workspace: string) => string
}
type Check = { passed: boolean; detail: string }
type CommandResult = { passed: boolean; code: number | string; stdout: string; stderr: string; durationMs: number }
type UsageStats = { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number; totalModel: number; totalWithCache: number }
type TaskUsage = UsageStats & { eventCount: number; cost: number; steps?: UsageStep[] }
type UsageStep = UsageStats & { gapSeconds?: number }

type TaskEvaluation = {
  success: boolean
  passedChecks: number
  totalChecks: number
  checks: Record<string, Check>
}

type TaskResult = {
  index: number
  slug: string
  title: string
  success: boolean
  attempts: number
  firstAttemptSuccess: boolean
  repaired: boolean
  agentDurationMs: number
  endToEndDurationMs: number
  usage: TaskUsage
  toolCalls: number
  evaluation: TaskEvaluation
  finalMessage: string
  error?: string
}

type ArmReport = {
  arm: Arm
  workspace: string
  sessionID: string
  tasks: TaskResult[]
  finalSessionUsage: UsageStats
  errors: string[]
}

const execFile = promisify(execFileCallback)
const project = resolve(process.cwd())
const resultsDirectory = join(project, 'benchmarks', 'results')
const keepWorkspaces = process.env.CUPPET_HARD_KEEP_WORKSPACES !== '0'

function parseRequestedModel(): ModelRef | undefined {
  const requested = process.env.CUPPET_AB_MODEL?.trim()
  if (!requested) return undefined
  const slash = requested.indexOf('/')
  if (slash <= 0 || slash === requested.length - 1) throw new Error('CUPPET_AB_MODEL must be provider/model')
  const variant = process.env.CUPPET_AB_VARIANT?.trim()
  return { providerID: requested.slice(0, slash), modelID: requested.slice(slash + 1), ...(variant ? { variant } : {}) }
}

const model: ModelRef = parseRequestedModel() ?? { providerID: 'openai', modelID: 'gpt-5.6-luna', variant: 'low' }
const timeoutMs = 15 * 60_000

// ---------------------------------------------------------------------------
// Fixture: a 22-file orders/subscriptions system with a deep call graph.
// ---------------------------------------------------------------------------

function fixtureFile(path: string, body: string): [string, string] {
  return [path, body.trimStart() + '\n']
}

const fixtureEntries: Array<[string, string]> = [
  fixtureFile('package.json', `{
  "name": "acme-billing",
  "private": true,
  "type": "module"
}`),
  fixtureFile('README.md', `# ACME Billing

Internal billing sandbox. Orders, subscriptions, invoicing, notifications,
audit trail, HTTP-style handlers and a CLI front-end. All local, no deps.
`),
  fixtureFile('src/types.ts', `export type PlanName = 'starter' | 'pro' | 'enterprise'

export type AuditEvent =
  | 'order.placed'
  | 'order.cancelled'
  | 'subscription.renewed'
  | 'payment.failed'

export interface Money {
  amountMinor: number
  currency: 'usd'
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: string }
`),
  fixtureFile('src/util/ids.ts', `let counter = 0

export function nextId(prefix: string): string {
  counter += 1
  return prefix + '_' + counter.toString(36).padStart(6, '0')
}
`),
  fixtureFile('src/util/dates.ts', `export function toIso(value: Date | string): string {
  return typeof value === 'string' ? value : value.toISOString()
}

export function addDays(iso: string, days: number): string {
  const next = new Date(iso)
  next.setUTCDate(next.getUTCDate() + days)
  return next.toISOString()
}

export function isPast(iso: string, now: Date = new Date()): boolean {
  return new Date(iso).getTime() < now.getTime()
}
`),
  fixtureFile('src/util/money.ts', `// Formatting only. Rounding currently lives near its call sites.
export function formatMoney(amountMinor: number): string {
  return '$' + (amountMinor / 100).toFixed(2)
}
`),
  fixtureFile('src/models/customer.ts', `import { nextId } from '../util/ids.js'
import type { Result } from '../types.js'

export interface Customer {
  id: string
  email: string
  name: string
}

const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

export function createCustomer(input: { email: string; name: string }): Result<Customer> {
  if (!EMAIL_PATTERN.test(input.email)) {
    return { ok: false, error: 'invalid email: ' + input.email }
  }
  if (input.name.trim().length === 0) {
    return { ok: false, error: 'name is required' }
  }
  return { ok: true, value: { id: nextId('cus'), email: input.email, name: input.name.trim() } }
}
`),
  fixtureFile('src/models/order.ts', `import { nextId } from '../util/ids.js'
import type { PlanName } from '../types.js'

export interface OrderItem {
  sku: string
  qty: number
  unitPrice: number
}

export interface Order {
  id: string
  customerId: string
  plan: PlanName
  seats: number
  items: OrderItem[]
  status: 'draft' | 'placed' | 'cancelled'
  /** Internal amount for the order in minor units. Serialized externally as "total". */
  totalAmount: number
  createdAt: string
}

export const PLAN_PRICES: Record<PlanName, number> = {
  starter: 4900,
  pro: 9900,
  enterprise: 29900,
}

export function createOrder(input: {
  customerId: string
  plan: PlanName
  seats?: number
}): Order {
  const seats = Math.max(1, Math.floor(input.seats ?? 1))
  const unitPrice = PLAN_PRICES[input.plan]
  return {
    id: nextId('ord'),
    customerId: input.customerId,
    plan: input.plan,
    seats,
    items: [{ sku: 'plan-' + input.plan, qty: seats, unitPrice }],
    status: 'draft',
    totalAmount: unitPrice * seats,
    createdAt: new Date().toISOString(),
  }
}
`),
  fixtureFile('src/models/subscription.ts', `import { nextId } from '../util/ids.js'
import type { PlanName } from '../types.js'
import { PLAN_PRICES } from './order.js'

export interface Subscription {
  id: string
  customerId: string
  plan: PlanName
  seats: number
  priceMinor: number
  lastRenewedAt: string | null
}

export function createSubscription(input: {
  customerId: string
  plan: PlanName
  seats?: number
}): Subscription {
  const seats = Math.max(1, Math.floor(input.seats ?? 1))
  return {
    id: nextId('sub'),
    customerId: input.customerId,
    plan: input.plan,
    seats,
    priceMinor: PLAN_PRICES[input.plan] * seats,
    lastRenewedAt: null,
  }
}
`),
  fixtureFile('src/services/pricing.ts', `import type { Order } from '../models/order.js'

export interface Quote {
  subtotal: number
  tax: number
  total: number
  discountApplied: number
}

export const TAX_RATE = 0.2

export const DISCOUNT_CODES: Record<string, number> = {
  SAVE10: 0.1,
  SAVE20: 0.2,
}

// Local rounding helper. Billing keeps its own copy - a known wart.
function round2(amountMinor: number): number {
  return Math.round(amountMinor * 100) / 100
}

export function applyDiscount(subtotal: number, code?: string): { amountMinor: number; valid: boolean; rate: number } {
  if (!code) return { amountMinor: subtotal, valid: true, rate: 0 }
  const rate = DISCOUNT_CODES[code]
  if (rate === undefined) return { amountMinor: subtotal, valid: false, rate: 0 }
  return { amountMinor: round2(subtotal * (1 - rate)), valid: true, rate }
}

export function computeTax(amountMinor: number, rate: number = TAX_RATE): number {
  return round2(amountMinor * rate)
}

export function quote(order: Order, options: { taxRate?: number } = {}): Quote {
  const subtotal = order.items.reduce((sum, item) => sum + item.qty * item.unitPrice, 0)
  const tax = computeTax(subtotal, options.taxRate ?? TAX_RATE)
  return { subtotal, tax, total: round2(subtotal + tax), discountApplied: 0 }
}
`),
  fixtureFile('src/services/billing.ts', `import { nextId } from '../util/ids.js'
import type { Money } from '../types.js'

export interface Invoice {
  id: string
  customerId: string
  amountMinor: number
  issuedAt: string
}

const issued: Invoice[] = []

// Second copy of the rounding wart from pricing.
function round2(amountMinor: number): number {
  return Math.round(amountMinor * 100) / 100
}

export function charge(customerId: string, amountMinor: number): Invoice {
  const normalized = round2(amountMinor)
  const invoice: Invoice = {
    id: nextId('inv'),
    customerId,
    amountMinor: normalized,
    issuedAt: new Date().toISOString(),
  }
  issued.push(invoice)
  return invoice
}

export function invoicesFor(customerId: string): Invoice[] {
  return issued.filter((invoice) => invoice.customerId === customerId)
}

export function __reset(): void {
  issued.length = 0
}

export function money(m: Money): number {
  return m.amountMinor
}
`),
  fixtureFile('src/services/renewal.ts', `import type { Subscription } from '../models/subscription.js'
import { charge } from './billing.js'

// Renews a subscription by charging the customer.
// FIXME(billing): the scheduler can invoke renew() twice for the same tick;
// customers have reported duplicate charges on rapid retries.
export function renew(
  subscription: Subscription,
  now: Date = new Date(),
): { invoiceId: string; alreadyBilled: boolean } {
  const invoice = charge(subscription.customerId, subscription.priceMinor)
  subscription.lastRenewedAt = now.toISOString()
  return { invoiceId: invoice.id, alreadyBilled: false }
}
`),
  fixtureFile('src/services/notifications.ts', `export interface NotifySink {
  (to: string, message: string): void
}

let sink: NotifySink = (to, message) => {
  console.log('[notify]', to, message)
}

export function __setNotifySink(next: NotifySink): void {
  sink = next
}

export function __resetNotifySink(): void {
  sink = (to, message) => {
    console.log('[notify]', to, message)
  }
}

export function send(to: string, message: string): void {
  sink(to, message)
}
`),
  fixtureFile('src/services/audit.ts', `import type { AuditEvent } from '../types.js'

export interface AuditEntry {
  event: AuditEvent
  payload: Record<string, unknown>
  at: string
}

const entries: AuditEntry[] = []

let sink: ((entry: AuditEntry) => void) | null = null

export function __setAuditSink(next: (entry: AuditEntry) => void): void {
  sink = next
}

export function __reset(): void {
  entries.length = 0
  sink = null
}

export function append(event: AuditEvent, payload: Record<string, unknown>): AuditEntry {
  const entry: AuditEntry = { event, payload, at: new Date().toISOString() }
  entries.push(entry)
  sink?.(entry)
  return entry
}

export function events(): AuditEntry[] {
  return [...entries]
}
`),
  fixtureFile('src/services/checkout.ts', `import type { Order } from '../models/order.js'
import { append } from './audit.js'
import { send } from './notifications.js'

export interface CheckoutResult {
  ok: boolean
  orderId: string
}

// Places an order: records the audit trail and notifies the customer.
export function placeOrder(order: Order, options: { notifyEmail?: string | null } = {}): CheckoutResult {
  const email = options.notifyEmail ?? null
  if (email) {
    send(email, 'Your order ' + order.id + ' is confirmed')
  }
  order.status = 'placed'
  append('order.placed', { orderId: order.id, totalAmount: order.totalAmount })
  return { ok: true, orderId: order.id }
}
`),
  fixtureFile('src/api/handlers.ts', `import type { Order } from '../models/order.js'
import { createOrder } from '../models/order.js'
import { quote } from '../services/pricing.js'
import { placeOrder } from '../services/checkout.js'
import type { Result } from '../types.js'

/** External payload shape. The internal amount field must never leak. */
export interface OrderPayload {
  id: string
  customerId: string
  plan: string
  seats: number
  status: string
  items: Array<{ sku: string; qty: number }>
  total: number
  currency: 'usd'
}

export function serializeOrder(order: Order): OrderPayload {
  return {
    id: order.id,
    customerId: order.customerId,
    plan: order.plan,
    seats: order.seats,
    status: order.status,
    items: order.items.map((item) => ({ sku: item.sku, qty: item.qty })),
    total: order.totalAmount,
    currency: 'usd',
  }
}

export function handleCreateOrder(body: { customerId: string; plan: 'starter' | 'pro' | 'enterprise'; seats?: number }): OrderPayload {
  const order = createOrder({ customerId: body.customerId, plan: body.plan, seats: body.seats })
  return serializeOrder(order)
}

export function handleQuote(body: { order: Order }): Result<{ subtotal: number; tax: number; total: number }> {
  const q = quote(body.order)
  return { ok: true, value: { subtotal: q.subtotal, tax: q.tax, total: q.total } }
}

export function handlePlaceOrder(body: { order: Order; notifyEmail?: string }): Result<CheckoutResult> {
  return { ok: true, value: placeOrder(body.order, { notifyEmail: body.notifyEmail ?? null }) }
}
`),
  fixtureFile('src/api/middleware/auth.ts', `export interface AuthContext {
  apiKey: string | null
  principal: string
}

export function authenticate(headers: Record<string, string>): AuthContext {
  const apiKey = headers['x-api-key'] ?? null
  return { apiKey, principal: apiKey ? 'key-' + apiKey.slice(0, 6) : 'anonymous' }
}
`),
  fixtureFile('src/api/routes.ts', `import { handleCreateOrder, handlePlaceOrder, handleQuote, serializeOrder } from './handlers.js'
import type { Order } from '../models/order.js'

type Handler = (body: any) => unknown

const routes: Record<string, Handler> = {
  'POST /orders': handleCreateOrder,
  'POST /orders/quote': handleQuote,
  'POST /orders/place': handlePlaceOrder,
}

export function dispatch(method: string, path: string, body: unknown): unknown {
  const handler = routes[method.toUpperCase() + ' ' + path]
  if (!handler) throw new Error('no route for ' + method + ' ' + path)
  return handler(body)
}

export function renderOrder(order: Order): string {
  return JSON.stringify(serializeOrder(order))
}
`),
  fixtureFile('src/store/orders.ts', `import type { Order } from '../models/order.js'

const orders = new Map<string, Order>()

export function save(order: Order): void {
  orders.set(order.id, order)
}

export function find(id: string): Order | undefined {
  return orders.get(id)
}

export function list(): Order[] {
  return [...orders.values()]
}

export function byCustomer(customerId: string): Order[] {
  return list().filter((order) => order.customerId === customerId)
}

export function __reset(): void {
  orders.clear()
}
`),
  fixtureFile('src/cli/parse.ts', `export interface CliOptions {
  plan?: 'starter' | 'pro' | 'enterprise'
  seats?: number
  customer?: string
}

export function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {}
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === '--plan') options.plan = argv[++index] as CliOptions['plan']
    else if (flag === '--seats') options.seats = Number(argv[++index])
    else if (flag === '--customer') options.customer = argv[++index]
  }
  return options
}
`),
  fixtureFile('src/cli/main.ts', `import { createCustomer } from '../models/customer.js'
import { createOrder } from '../models/order.js'
import { quote } from '../services/pricing.js'
import { parseArgs } from './parse.js'

export function main(argv: string[]): string {
  const options = parseArgs(argv)
  const customer = createCustomer({ email: 'ops@example.com', name: options.customer ?? 'Ops' })
  if (!customer.ok) return JSON.stringify({ error: customer.error })
  const order = createOrder({
    customerId: customer.value.id,
    plan: options.plan ?? 'starter',
    seats: options.seats,
  })
  const q = quote(order)
  return JSON.stringify({ orderId: order.id, subtotal: q.subtotal, tax: q.tax, total: q.total })
}
`),
  fixtureFile('test/smoke.test.ts', `import assert from 'node:assert/strict'
import { createOrder } from '../src/models/order.js'
import { quote } from '../src/services/pricing.js'
import { renew } from '../src/services/renewal.js'
import { createSubscription } from '../src/models/subscription.js'
import { __reset as resetBilling, invoicesFor } from '../src/services/billing.js'
import { serializeOrder } from '../src/api/handlers.js'

const order = createOrder({ customerId: 'cus_1', plan: 'pro', seats: 2 })
assert.equal(order.totalAmount, 19800)

const q = quote(order)
assert.equal(q.subtotal, 19800)
assert.equal(q.total, 23760)

const payload = serializeOrder(order)
assert.equal(payload.total, 19800)

resetBilling()
const sub = createSubscription({ customerId: 'cus_1', plan: 'starter' })
const at = new Date('2026-01-01T00:00:00.000Z')
const first = renew(sub, at)
assert.equal(first.alreadyBilled, false)
assert.equal(invoicesFor('cus_1').length, 1)

console.log('smoke ok')
`),
]

const fixtureHashInput = createHash('sha256')

// ---------------------------------------------------------------------------
// Hard tasks.
// ---------------------------------------------------------------------------

const hardTasks: HardTask[] = [
  {
    slug: 'deep-rename-grand-total',
    title: 'Rename internal total without changing the wire format',
    prompt: `In this repository, rename the Order field "totalAmount" to "grandTotal" in ALL internal code: the model, every service, handler, route, CLI and test that references it. CRITICAL WIRE CONTRACT: the external API payload produced by serializeOrder in src/api/handlers.ts must keep exposing the amount under the key "total", must NOT expose "totalAmount" or "grandTotal" anywhere in the payload object, and its shape (exact set of keys) must stay: id, customerId, plan, seats, status, items, total, currency. Update test/smoke.test.ts so it compiles against the new name and still passes. Do not rename anything else. Search the whole repository for remaining occurrences of "totalAmount" and eliminate them all. Inspect your work before replying.`,
    requiredFiles: ['src/models/order.ts', 'src/api/handlers.ts'],
    patterns: [
      { name: 'grandTotal in model', file: 'src/models/order.ts', pattern: /grandTotal/i },
      { name: 'legacy name gone from model', file: 'src/models/order.ts', pattern: /^[\s\S]*$/ },
      { name: 'payload keeps total key', file: 'src/api/handlers.ts', pattern: /total:/ },
    ],
    verifier: verifyDeepRename,
  },
  {
    slug: 'feature-discount-end-to-end',
    title: 'Thread discount codes through the entire stack',
    prompt: `Add discount-code support end to end. Semantics: a discount applies to the SUBTOTAL before tax; SAVE10 gives 10% off, SAVE20 gives 20% off; an unknown code must produce a failed Result (ok:false) rather than silently charging full price; no code means no discount. Wire it through: 1) src/services/pricing.ts - extend quote(order, options) to accept an optional discountCode and return discountApplied (minor units saved) plus recomputed tax and total; 2) src/api/handlers.ts - handleQuote must accept an optional discountCode on its body and surface discountApplied; 3) src/cli/parse.ts and src/cli/main.ts - support a --discount-code flag that flows into the quote; 4) keep test/smoke.test.ts passing and add one assertion covering SAVE20 math. Inspect your work before replying.`,
    requiredFiles: ['src/services/pricing.ts', 'src/cli/parse.ts'],
    patterns: [
      { name: 'discount in pricing', file: 'src/services/pricing.ts', pattern: /discountCode|discountApplied/i, min: 3 },
      { name: 'discount flag in cli', file: 'src/cli/parse.ts', pattern: /discount-code|discountCode/i, min: 2 },
      { name: 'handler surfaces discount', file: 'src/api/handlers.ts', pattern: /discountCode|discountApplied/i, min: 2 },
    ],
    verifier: verifyDiscountFlow,
  },
  {
    slug: 'fix-idempotent-renewal',
    title: 'Fix double-billing on rapid subscription renewals',
    prompt: `There is a billing bug: calling renew() twice within the same scheduler tick can bill the customer twice depending on how timestamps compare. Make renewal strictly idempotent: for a given subscription, renewing again while the previous renewal happened on the exact same instant (millisecond precision, UTC) must return alreadyBilled:true with the ORIGINAL invoice id and must not issue a new charge. Renewing at any later instant charges normally. Fix the root cause in src/services/renewal.ts (you may touch billing.ts only for read helpers, not its charging logic). Keep test/smoke.test.ts passing. Inspect your changes before replying.`,
    requiredFiles: ['src/services/renewal.ts'],
    patterns: [
      { name: 'renewal touched', file: 'src/services/renewal.ts', pattern: /alreadyBilled|lastRenewedAt/i, min: 3 },
    ],
    verifier: verifyIdempotentRenewal,
  },
  {
    slug: 'consolidate-money-rounding',
    title: 'Consolidate duplicated rounding into one util',
    prompt: `src/services/pricing.ts and src/services/billing.ts each define their own private round2 helper. Consolidate: add an exported function roundMoney(amountMinor: number): number to src/util/money.ts with IDENTICAL semantics (round to 2 decimal places), make both services import and use it, and remove their private copies. Every other module that needs rounding must also go through util/money.ts. Behavior must not change: all amounts stay in minor units and the arithmetic results must be bit-for-bit identical to before. Keep test/smoke.test.ts passing. Verify there are no remaining local round definitions in services. Inspect your work before replying.`,
    requiredFiles: ['src/util/money.ts'],
    patterns: [
      { name: 'util exports roundMoney', file: 'src/util/money.ts', pattern: /export function roundMoney/ },
      { name: 'pricing imports util', file: 'src/services/pricing.ts', pattern: /util\/money/ },
      { name: 'billing imports util', file: 'src/services/billing.ts', pattern: /util\/money/ },
    ],
    verifier: verifyMoneyConsolidation,
  },
  {
    slug: 'ordering-audit-before-notify',
    title: 'Guarantee audit-first ordering and resilient notifications',
    prompt: `Two defects in src/services/checkout.ts placeOrder: 1) the customer notification is sent BEFORE the audit entry is appended; the audit trail must always be written FIRST, then the notification. 2) A throwing notification sink crashes checkout; notification failures must never fail or block placement - the function must still return ok:true with the order marked placed and audited. Do not weaken the audit append. Keep test/smoke.test.ts passing and add a test asserting that a throwing notification sink still yields ok:true with an audit entry present (use __setNotifySink from notifications.ts and __resetNotifySink to restore). Inspect your work before replying.`,
    requiredFiles: ['src/services/checkout.ts'],
    patterns: [
      { name: 'try around notify', file: 'src/services/checkout.ts', pattern: /try|catch/i, min: 2 },
      { name: 'still appends audit', file: 'src/services/checkout.ts', pattern: /append\(/i, min: 2 },
    ],
    verifier: verifyAuditBeforeNotify,
  },
]

// ---------------------------------------------------------------------------
// Verifiers: execute the workspace code and assert real behavior.
// ---------------------------------------------------------------------------

function verifierSource(workspace: string, body: string): string {
  return `
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
${body}
console.log('VERIFIER-OK')
`.replaceAll('__WS__', JSON.stringify(workspace))
}

function verifyDeepRename(workspace: string): string {
  return verifierSource(workspace, `
const { createOrder } = await import(__WS__ + '/src/models/order.ts')
const { serializeOrder } = await import(__WS__ + '/src/api/handlers.ts')
const order = createOrder({ customerId: 'cus_x', plan: 'pro', seats: 3 })
assert.ok(!('totalAmount' in order), 'internal totalAmount must be renamed')
assert.equal(order.grandTotal, 29700, 'renamed field keeps value')
const payload = serializeOrder(order)
assert.deepEqual(Object.keys(payload), ['id','customerId','plan','seats','status','items','total','currency'])
assert.equal(payload.total, 29700)
`)
}

function verifyDiscountFlow(workspace: string): string {
  return verifierSource(workspace, `
const { createOrder } = await import(__WS__ + '/src/models/order.ts')
const { quote } = await import(__WS__ + '/src/services/pricing.ts')
const { parseArgs } = await import(__WS__ + '/src/cli/parse.ts')
const order = createOrder({ customerId: 'c', plan: 'starter', seats: 2 }) // 9800
const noCode = quote(order)
assert.equal(noCode.subtotal, 9800)
assert.ok(!(noCode.discountApplied > 0))
const save20 = quote(order, { discountCode: 'SAVE20' })
assert.equal(save20.discountApplied, 1960)
assert.equal(save20.total, Math.round((9800 - 1960) * 1.2))
const bad = quote(order, { discountCode: 'NOPE' })
assert.equal(bad.valid === false || bad.error !== undefined || bad.invalid === true, true, 'unknown code must be reported invalid')
const parsed = parseArgs(['--plan', 'pro', '--discount-code', 'SAVE10'])
assert.equal(parsed.discountCode, 'SAVE10')
`)
}

function verifyIdempotentRenewal(workspace: string): string {
  return verifierSource(workspace, `
const { createSubscription } = await import(__WS__ + '/src/models/subscription.ts')
const { renew } = await import(__WS__ + '/src/services/renewal.ts')
const { __reset, invoicesFor } = await import(__WS__ + '/src/services/billing.ts')
__reset()
const sub = createSubscription({ customerId: 'cus_r', plan: 'pro' })
const t1 = new Date('2026-03-01T09:30:00.000Z')
const first = renew(sub, t1)
assert.equal(first.alreadyBilled, false)
const dupe = renew(sub, new Date('2026-03-01T09:30:00.000Z'))
assert.equal(dupe.alreadyBilled, true)
assert.equal(dupe.invoiceId, first.invoiceId)
assert.equal(invoicesFor('cus_r').length, 1)
const later = renew(sub, new Date('2026-04-01T09:30:00.000Z'))
assert.equal(later.alreadyBilled, false)
assert.notEqual(later.invoiceId, first.invoiceId)
assert.equal(invoicesFor('cus_r').length, 2)
`)
}

function verifyMoneyConsolidation(workspace: string): string {
  return verifierSource(workspace, `
const fs = await import('node:fs/promises')
const { quote } = await import(__WS__ + '/src/services/pricing.ts')
const { createOrder } = await import(__WS__ + '/src/models/order.ts')
const money = await import(__WS__ + '/src/util/money.ts')
assert.equal(typeof money.roundMoney, 'function')
for (const rel of ['src/services/pricing.ts', 'src/services/billing.ts']) {
  const src = await fs.readFile(__WS__ + '/' + rel, 'utf8')
  assert.ok(!/function\\s+round2\\b/.test(src), rel + ' must not keep a private round2')
}
const order = createOrder({ customerId: 'c', plan: 'starter' })
const q = quote(order)
assert.equal(q.total, Math.round(q.subtotal * 1.2 * 100) / 100)
`)
}

function verifyAuditBeforeNotify(workspace: string): string {
  return verifierSource(workspace, `
const { createOrder } = await import(__WS__ + '/src/models/order.ts')
const { placeOrder } = await import(__WS__ + '/src/services/checkout.ts')
const audit = await import(__WS__ + '/src/services/audit.ts')
const notify = await import(__WS__ + '/src/services/notifications.ts')
const seen = []
audit.__setAuditSink(() => seen.push('audit'))
notify.__setNotifySink(() => seen.push('notify'))
const order = createOrder({ customerId: 'c', plan: 'starter' })
const result = placeOrder(order, { notifyEmail: 'x@example.com' })
assert.equal(result.ok, true)
assert.equal(order.status, 'placed')
assert.deepEqual(seen, ['audit', 'notify'])
seen.length = 0
notify.__setNotifySink(() => { throw new Error('smtp down') })
const resilient = placeOrder(order, { notifyEmail: 'x@example.com' })
assert.equal(resilient.ok, true)
assert.deepEqual(seen, ['audit'])
notify.__resetNotifySink()
audit.__reset()
`)
}

// ---------------------------------------------------------------------------
// Workspace + evaluation.
// ---------------------------------------------------------------------------

const fixture = Object.fromEntries(fixtureEntries)
fixtureHashInput.update(JSON.stringify(fixture)).update(hardTasks.map((task) => task.slug + task.prompt).join('\0'))

async function createWorkspace(workspace: string): Promise<void> {
  await mkdir(workspace, { recursive: true, mode: 0o700 })
  for (const [path, contents] of Object.entries(fixture)) {
    const target = join(workspace, path)
    await mkdir(join(target, '..'), { recursive: true, mode: 0o700 })
    await writeFile(target, contents, { encoding: 'utf8', mode: 0o600 })
  }
  mustPass(await runCommand('git', ['init', '--quiet'], workspace, 15_000), 'git init')
  mustPass(await runCommand('git', ['add', '.'], workspace, 15_000), 'git add')
  mustPass(
    await runCommand(
      'git',
      ['-c', 'user.name=Hard Benchmark', '-c', 'user.email=hard@example.invalid', 'commit', '--quiet', '-m', 'initial fixture'],
      workspace,
      15_000,
    ),
    'git commit',
  )
}

async function runVerifier(workspace: string, task: HardTask): Promise<CommandResult> {
  const stagingDir = join(project, 'benchmarks', 'results', 'verifier-tmp')
  await mkdir(stagingDir, { recursive: true, mode: 0o700 })
  const verifierPath = join(stagingDir, `${task.slug}-${randomBytes(4).toString('hex')}.mjs`)
  await writeFile(verifierPath, task.verifier(workspace), { mode: 0o600 })
  try {
    return await runCommand(process.execPath, ['--import', 'tsx', verifierPath], project, 60_000)
  } finally {
    await rm(verifierPath, { force: true }).catch(() => undefined)
  }
}

async function evaluateHardTask(workspace: string, task: HardTask): Promise<TaskEvaluation> {
  let files: string[] = []
  try {
    files = await listFiles(workspace)
  } catch {
    files = []
  }
  const sources = new Map<string, string>()
  for (const file of files) {
    if (!file.endsWith('.ts')) continue
    try {
      sources.set(file, await readFile(join(workspace, file), 'utf8'))
    } catch {}
  }
  const checks: Record<string, Check> = {}
  for (const file of task.requiredFiles) {
    const exists = sources.has(file)
    checks[`file:${file}`] = { passed: exists, detail: exists ? 'exists' : 'missing' }
  }
  for (const item of task.patterns) {
    if (item.name.includes('gone')) continue
    const source = sources.get(item.file) ?? ''
    const count = countMatches(source, item.pattern)
    checks[`pattern:${item.name}`] = { passed: count >= (item.min ?? 1), detail: `${item.file}: found ${count}` }
  }
  // Legacy-name elimination check for the rename task.
  const legacyGone = task.slug === 'deep-rename-grand-total'
    ? ![...sources.values()].some((source) => /totalAmount/.test(source))
    : true
  checks['pattern:no legacy totalAmount anywhere'] = { passed: legacyGone, detail: legacyGone ? 'clean' : 'totalAmount still referenced' }
  checks['behavior:verifier'] = await runVerifier(workspace, task).then(toCheck)
  // cwd must be the repo so `--import tsx` can resolve; the test file's own
  // imports resolve relative to its real path inside the workspace.
  const smoke = await runCommand(process.execPath, ['--import', 'tsx', join(workspace, 'test/smoke.test.ts')], project, 60_000)
  checks['regression:smoke-test'] = toCheck(smoke)
  const values = Object.values(checks)
  return { success: values.every((check) => check.passed), passedChecks: values.filter((check) => check.passed).length, totalChecks: values.length, checks }
}

function toCheck(result: CommandResult): Check {
  return {
    passed: result.passed,
    detail: result.passed ? 'ok' : compact(`${result.stderr} ${result.stdout}`, 400),
  }
}

// ---------------------------------------------------------------------------
// Runtime (mirrors the 10-task harness: concurrent arms, telemetry, guard).
// ---------------------------------------------------------------------------

type OpenCodeLiveArm = {
  arm: 'opencode' | 'cuppet'
  workspace: string
  runtimeRoot: string
  paths: Awaited<ReturnType<typeof createRuntimePaths>>
  gateway: OpenCodeGateway
  opencode: BenchmarkRuntime
  tst?: TstRuntime
  sessionID: string
  permissions: Set<string>
  lastUsageAt?: number
  errors: string[]
  report: ArmReport
  current?: TaskTelemetry
}

type DeepSeekLiveArm = {
  arm: 'deepseek-harness'
  workspace: string
  runtimeRoot: string
  sessionRoot: string
  harness: DeepSeekBenchmarkSession
  sessionID: string
  errors: string[]
  report: ArmReport
}

type LiveArm = OpenCodeLiveArm | DeepSeekLiveArm

type UsageSample = TokenUsage & { at: number }
type TaskTelemetry = {
  usageEvents: UsageSample[]
  costs: number[]
  toolCalls: number
  errors: string[]
}
type BenchmarkRuntime = { client: ReturnType<typeof createOpencodeClient>; close(): Promise<void> }

const CACHE_IDLE_GAP_SECONDS = 180

function verifyRetryLimit(): number {
  const requested = Number(process.env.CUPPET_HARD_VERIFY_RETRIES ?? '2')
  return Number.isFinite(requested) ? Math.max(0, Math.min(3, Math.floor(requested))) : 2
}

// ---------------------------------------------------------------------------
// Reference solutions. Applied during self-check to prove every task is
// solvable and every verifier accepts a correct implementation.
// ---------------------------------------------------------------------------

async function editFile(workspace: string, relative: string, transform: (source: string) => string): Promise<void> {
  const { readFile, writeFile } = await import('node:fs/promises')
  const path = join(workspace, relative)
  await writeFile(path, transform(await readFile(path, 'utf8')), 'utf8')
}

function replaceOnce(source: string, search: string, replacement: string): string {
  if (!source.includes(search)) throw new Error(`reference solution: pattern not found: ${compact(search, 80)}`)
  return source.replace(search, replacement)
}

async function applyReferenceSolutions(workspace: string): Promise<void> {
  // Task 1: internal rename totalAmount -> grandTotal; wire key "total" is a
  // literal in serializeOrder and therefore untouched.
  for (const file of ['src/models/order.ts', 'src/services/checkout.ts', 'src/api/handlers.ts', 'test/smoke.test.ts']) {
    await editFile(workspace, file, (source) => source.replaceAll('totalAmount', 'grandTotal'))
  }

  // Task 2: discounts end to end.
  await editFile(workspace, 'src/services/pricing.ts', (source) => {
    let next = replaceOnce(
      source,
      `export interface Quote {
  subtotal: number
  tax: number
  total: number
  discountApplied: number
}`,
      `export interface Quote {
  subtotal: number
  tax: number
  total: number
  discountApplied: number
  invalid?: boolean
}`,
    )
    next = replaceOnce(
      next,
      `export function quote(order: Order, options: { taxRate?: number } = {}): Quote {
  const subtotal = order.items.reduce((sum, item) => sum + item.qty * item.unitPrice, 0)
  const tax = computeTax(subtotal, options.taxRate ?? TAX_RATE)
  return { subtotal, tax, total: round2(subtotal + tax), discountApplied: 0 }
}`,
      `export function quote(order: Order, options: { taxRate?: number; discountCode?: string } = {}): Quote {
  const subtotal = order.items.reduce((sum, item) => sum + item.qty * item.unitPrice, 0)
  const discount = applyDiscount(subtotal, options.discountCode)
  if (options.discountCode && !discount.valid) {
    return { subtotal, tax: 0, total: 0, discountApplied: 0, invalid: true }
  }
  const tax = computeTax(discount.amountMinor, options.taxRate ?? TAX_RATE)
  return { subtotal, tax, total: round2(discount.amountMinor + tax), discountApplied: round2(subtotal - discount.amountMinor) }
}`,
    )
    return next
  })
  await editFile(workspace, 'src/cli/parse.ts', (source) => {
    let next = replaceOnce(
      source,
      `export interface CliOptions {
  plan?: 'starter' | 'pro' | 'enterprise'
  seats?: number
  customer?: string
}`,
      `export interface CliOptions {
  plan?: 'starter' | 'pro' | 'enterprise'
  seats?: number
  customer?: string
  discountCode?: string
}`,
    )
    next = replaceOnce(
      next,
      `else if (flag === '--customer') options.customer = argv[++index]`,
      `else if (flag === '--customer') options.customer = argv[++index]
    else if (flag === '--discount-code') options.discountCode = argv[++index]`,
    )
    return next
  })
  await editFile(workspace, 'src/cli/main.ts', (source) =>
    replaceOnce(source, `const q = quote(order)`, `const q = quote(order, { discountCode: options.discountCode })`))
  await editFile(workspace, 'src/api/handlers.ts', (source) =>
    replaceOnce(
      source,
      `export function handleQuote(body: { order: Order }): Result<{ subtotal: number; tax: number; total: number }> {
  const q = quote(body.order)
  return { ok: true, value: { subtotal: q.subtotal, tax: q.tax, total: q.total } }
}`,
      `export function handleQuote(body: { order: Order; discountCode?: string }): Result<{ subtotal: number; tax: number; total: number; discountApplied: number }> {
  const q = quote(body.order, { discountCode: body.discountCode })
  return { ok: true, value: { subtotal: q.subtotal, tax: q.tax, total: q.total, discountApplied: q.discountApplied } }
}`,
    ))

  // Task 3: idempotent renewal.
  await editFile(workspace, 'src/services/renewal.ts', (source) => {
    let next = replaceOnce(source, `import { charge } from './billing.js'`, `import { charge, invoicesFor } from './billing.js'`)
    next = replaceOnce(
      next,
      `export function renew(
  subscription: Subscription,
  now: Date = new Date(),
): { invoiceId: string; alreadyBilled: boolean } {
  const invoice = charge(subscription.customerId, subscription.priceMinor)
  subscription.lastRenewedAt = now.toISOString()
  return { invoiceId: invoice.id, alreadyBilled: false }
}`,
      `export function renew(
  subscription: Subscription,
  now: Date = new Date(),
): { invoiceId: string; alreadyBilled: boolean } {
  const stamp = now.toISOString()
  if (subscription.lastRenewedAt === stamp) {
    const existing = invoicesFor(subscription.customerId).at(-1)
    return { invoiceId: existing?.id ?? '', alreadyBilled: true }
  }
  const invoice = charge(subscription.customerId, subscription.priceMinor)
  subscription.lastRenewedAt = stamp
  return { invoiceId: invoice.id, alreadyBilled: false }
}`,
    )
    return next
  })

  // Task 4: consolidate rounding.
  await editFile(workspace, 'src/util/money.ts', (source) =>
    `${source.trimEnd()}\n\nexport function roundMoney(amountMinor: number): number {\n  return Math.round(amountMinor * 100) / 100\n}\n`)
  for (const [file, wart] of [
    ['src/services/pricing.ts', '// Local rounding helper. Billing keeps its own copy - a known wart.\n'],
    ['src/services/billing.ts', '// Second copy of the rounding wart from pricing.\n'],
  ] as const) {
    await editFile(workspace, file, (source) =>
      replaceOnce(source, `${wart}function round2(amountMinor: number): number {\n  return Math.round(amountMinor * 100) / 100\n}\n\n`, '')
        .replace(/import type \{ Order \} from '..\/models\/order.js'/, `import { roundMoney as round2 } from '../util/money.js'\nimport type { Order } from '../models/order.js'`)
        .replace(`import { nextId } from '../util/ids.js'\nimport type { Money } from '../types.js'`, `import { nextId } from '../util/ids.js'\nimport { roundMoney as round2 } from '../util/money.js'\nimport type { Money } from '../types.js'`),
    )
  }

  // Task 5: audit first, resilient notification.
  await editFile(workspace, 'src/services/checkout.ts', (source) =>
    replaceOnce(
      source,
      `export function placeOrder(order: Order, options: { notifyEmail?: string | null } = {}): CheckoutResult {
  const email = options.notifyEmail ?? null
  if (email) {
    send(email, 'Your order ' + order.id + ' is confirmed')
  }
  order.status = 'placed'
  append('order.placed', { orderId: order.id, grandTotal: order.grandTotal })
  return { ok: true, orderId: order.id }
}`,
      `export function placeOrder(order: Order, options: { notifyEmail?: string | null } = {}): CheckoutResult {
  order.status = 'placed'
  append('order.placed', { orderId: order.id, grandTotal: order.grandTotal })
  const email = options.notifyEmail ?? null
  if (email) {
    try {
      send(email, 'Your order ' + order.id + ' is confirmed')
    } catch {
      // Notification failures never block a placed order.
    }
  }
  return { ok: true, orderId: order.id }
}`,
    ))
}

async function main(): Promise<void> {
  // Self-check: build the fixture, ensure the seeded smoke test passes and
  // every post-change verifier fails against the unmodified code. Exits
  // without starting any model session.
  if (process.env.CUPPET_HARD_SELFCHECK === '1') {
    const { access } = await import('node:fs/promises')
    const scratch = await mkdtemp(join('/private/tmp', 'cuppet-hard-selfcheck-'))
    const workspace = join(scratch, 'workspace')
    await createWorkspace(workspace)
    await runCommand(process.execPath, ['--import', 'tsx', join(workspace, 'test/smoke.test.ts')], project, 60_000).then((result) => {
      if (!result.passed) throw new Error(`seeded smoke test failed: ${compact(result.stderr, 400)}`)
      process.stdout.write('selfcheck: seeded smoke test passes\n')
    })
    for (const task of hardTasks) {
      const result = await runVerifier(workspace, task)
      process.stdout.write(`selfcheck: ${task.slug} verifier pre-change → ${result.passed ? 'UNEXPECTED PASS' : 'fails (expected)'}\n`)
      if (result.passed) throw new Error(`${task.slug} verifier passes on the unmodified fixture`)
    }
    await access(join(workspace, 'src/services/renewal.ts'))
    process.stdout.write('selfcheck: applying reference solutions\n')
    await applyReferenceSolutions(workspace)
    for (const task of hardTasks) {
      const result = await runVerifier(workspace, task)
      process.stdout.write(`selfcheck: ${task.slug} verifier post-solution → ${result.passed ? 'passes (expected)' : `FAIL: ${compact(result.stderr, 300)}`}\n`)
      if (!result.passed) throw new Error(`${task.slug} verifier rejects the reference solution`)
    }
    await runCommand(process.execPath, ['--import', 'tsx', join(workspace, 'test/smoke.test.ts')], project, 60_000).then((result) => {
      if (!result.passed) throw new Error(`smoke test failed after reference solutions: ${compact(result.stderr, 400)}`)
      process.stdout.write('selfcheck: smoke test still passes\n')
    })
    process.stdout.write(`selfcheck ok: ${scratch}\n`)
    return
  }
  await mkdir(resultsDirectory, { recursive: true, mode: 0o700 })
  const assets = await resolveRuntimeAssets()
  if (!assets.opencode || !assets.tst || !assets.plugin) {
    throw new Error(`Cuppet runtime unavailable: ${assets.diagnostics.join('; ')}`)
  }
  const officialBinary = process.env.CUPPET_OFFICIAL_OPENCODE_BIN
    ?? '/private/tmp/cuppet-opencode-official-1.18.4/node_modules/opencode-darwin-arm64/bin/opencode'
  const officialVersion = await commandVersion(officialBinary)
  if (officialVersion.trim() !== OPENCODE_VERSION) {
    throw new Error(`Official OpenCode version mismatch: expected ${OPENCODE_VERSION}, received ${officialVersion || 'unknown'}`)
  }

  const root = await mkdtemp(join('/private/tmp', 'cuppet-hard-'))
  const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
  const finalJsonPath = join(resultsDirectory, `ab-opencode-cuppet-hard-${stamp}.json`)
  const finalMarkdownPath = join(resultsDirectory, `ab-opencode-cuppet-hard-${stamp}.md`)

  const live = new Map<Arm, LiveArm>()
  const reports: Partial<Record<Arm, ArmReport>> = {}
  try {
    const order: Arm[] = ['opencode', 'cuppet', 'deepseek-harness']
    for (const arm of order) {
      const armRoot = join(root, arm)
      await mkdir(armRoot, { recursive: true, mode: 0o700 })
      live.set(arm, await startArm(arm, armRoot, { opencode: assets.opencode, tst: assets.tst, plugin: assets.plugin }, officialBinary))
    }

    for (let index = 0; index < hardTasks.length; index += 1) {
      const task = hardTasks[index]!
      process.stdout.write(`[${index + 1}/${hardTasks.length}] ${task.slug} · ${order.join('+')}\n`)
      const outcomes = await Promise.allSettled(
        order.map(async (arm) => {
          const runtime = live.get(arm)
          if (!runtime) throw new Error(`${arm} runtime unavailable`)
          const result = await runTask(runtime, task, index)
          reports[arm] = runtime.report
          return result
        }),
      )
      const failure = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected')
      if (failure) throw failure.reason
    }

    const report = buildReport(reports, root)
    await writeAtomic(finalJsonPath, `${JSON.stringify(report, null, 2)}\n`)
    await writeAtomic(finalMarkdownPath, renderMarkdown(report))
    process.stdout.write(`Raw: ${finalJsonPath}\nSummary: ${finalMarkdownPath}\n`)
  } finally {
    for (const runtime of live.values()) {
      if (runtime.arm === 'deepseek-harness') {
        await runtime.harness.close().catch(() => undefined)
      } else {
        await runtime.gateway.close().catch(() => undefined)
        await runtime.opencode.close().catch(() => undefined)
        await runtime.tst?.close().catch(() => undefined)
      }
    }
    if (!keepWorkspaces) await rm(root, { recursive: true, force: true }).catch(() => undefined)
    else process.stdout.write(`Artifacts retained: ${root}\n`)
  }
}

async function startArm(
  arm: Arm,
  root: string,
  assets: { opencode: string; tst: string; plugin: string },
  officialBinary: string,
): Promise<LiveArm> {
  const workspace = join(root, 'workspace')
  const runtimeRoot = join(root, 'runtime')
  await createWorkspace(workspace)
  if (arm === 'deepseek-harness') {
    const sessionRoot = join(root, 'sessions')
    const provider = process.env.CUPPET_DSH_PROVIDER?.trim()
      ?? (model.providerID === 'openai' ? 'openai-codex' : undefined)
    const harness = await openDeepSeekBenchmarkSession({
      workspace,
      sessionRoot,
      model: model.modelID,
      ...(provider ? { provider } : {}),
      maxTokens: 16_384,
      requestTimeoutMs: 10 * 60_000,
      systemPrompt: `${DEEPSEEK_HARNESS_CODING_SYSTEM_PROMPT}\nWorkspace root: ${workspace}. Use absolute paths under this directory only.`,
    })
    const report: ArmReport = {
      arm,
      workspace,
      sessionID: '',
      tasks: [],
      finalSessionUsage: zeroUsage(),
      errors: [],
    }
    return {
      arm,
      workspace,
      runtimeRoot,
      sessionRoot,
      harness,
      sessionID: '',
      errors: [],
      report,
    }
  }
  const paths = await createRuntimePaths(workspace, runtimeRoot)
  await seedProviderState(paths)
  const logger = new RedactedLogger(paths.logs)
  let tst: TstRuntime | undefined
  let opencode: BenchmarkRuntime
  let gateway: OpenCodeGateway
  if (arm === 'cuppet') {
    tst = await startTstDaemon(assets.tst, paths, logger)
    await waitForIndex(tst)
    opencode = await startOpenCodeServer({
      binary: assets.opencode,
      paths,
      logger,
      plugin: assets.plugin,
      tst: { socket: tst.socket, token: tst.token },
      ...(process.env.CUPPET_ORCHESTRATOR === '1'
        ? { orchestrator: true, secondaryModel: undefined }
        : { taskContext: true, instructions: [DEFAULT_CUPPET_INSTRUCTION] }),
    })
    gateway = new OpenCodeGateway(opencode.client, workspace)
  } else {
    opencode = await startOfficialOpenCodeServer(officialBinary, paths, logger)
    gateway = new OpenCodeGateway(opencode.client, workspace, { foreground: 'build', background: 'general' })
  }
  const allowed = new Set([
    'read', 'edit', 'write', 'bash', 'glob', 'grep', 'lsp', 'question', 'todowrite',
    'cuppet_memory_search', 'cuppet_workspace_info', 'cuppet_graph_tree', 'cuppet_graph_search', 'cuppet_graph_trace',
  ])
  const session = await gateway.createSession(model)
  const report: ArmReport = {
    arm,
    workspace,
    sessionID: session.id,
    tasks: [],
    finalSessionUsage: zeroUsage(),
    errors: [],
  }
  const runtime: LiveArm = {
    arm,
    workspace,
    runtimeRoot,
    paths,
    gateway,
    opencode,
    ...(tst ? { tst } : {}),
    sessionID: session.id,
    permissions: new Set(),
    lastUsageAt: undefined,
    errors: [],
    report,
    current: undefined,
  }
  gateway.onEvent((event: AgentEvent) => {
    if (event.type === 'permission') {
      if (!runtime.permissions.has(event.request.id)) {
        runtime.permissions.add(event.request.id)
        void gateway.replyPermission(event.request.sessionID, event.request.id, allowed.has(event.request.action) ? 'once' : 'reject').catch(() => undefined)
      }
      return
    }
    const current = runtime.current
    if (!current) return
    if (event.type === 'usage') {
      const at = Date.now()
      runtime.lastUsageAt = at
      current.usageEvents.push({ at, ...event.usage })
      current.costs.push(event.cost)
    }
    if (event.type === 'tool-start') current.toolCalls += 1
    if (event.type === 'error') {
      current.errors.push(event.message)
      runtime.errors.push(event.message)
    }
  })
  gateway.startEvents()
  await delay(250)
  return runtime
}

async function runTask(runtime: LiveArm, task: HardTask, index: number): Promise<TaskResult> {
  if (runtime.arm === 'deepseek-harness') return runDeepSeekTask(runtime, task, index)
  const telemetry: TaskTelemetry = { usageEvents: [], costs: [], toolCalls: 0, errors: [] }
  runtime.current = telemetry
  const started = performance.now()
  let failure: string | undefined
  const sendAndSettle = async (prompt: string): Promise<boolean> => {
    try {
      await runtime.gateway.prompt(runtime.sessionID, prompt)
      await withTimeout(runtime.gateway.wait(runtime.sessionID), timeoutMs, `${runtime.arm}/${task.slug} timed out`)
      return true
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error)
      await runtime.gateway.interrupt(runtime.sessionID).catch(() => undefined)
      // Provider-side model rejection will never heal mid-run; abort loudly.
      if (/model not found|usage limit|quota/i.test(failure)) throw new Error(`[${runtime.arm}] ${compact(failure, 200)}`)
      return false
    }
  }

  const retries = verifyRetryLimit()
  let attempts = 0
  let firstAttemptSuccess = false
  let evaluation: TaskEvaluation | undefined
  while (attempts <= retries) {
    const prompt = attempts === 0 ? task.prompt : repairPromptFor(task, evaluation!)
    attempts += 1
    if (!await sendAndSettle(prompt)) break
    await delay(200)
    evaluation = await evaluateHardTask(runtime.workspace, task)
    if (attempts === 1) firstAttemptSuccess = evaluation.success
    if (evaluation.success || failure) break
    process.stdout.write(`  ${runtime.arm}/${task.slug}: attempt ${attempts} failed, feeding ${Object.values(evaluation.checks).filter((check) => !check.passed).length} failures back\n`)
  }
  evaluation ??= { success: false, passedChecks: 0, totalChecks: 0, checks: {} }
  const agentDurationMs = Math.round(performance.now() - started)
  const usageFromEvents = usageFromEventList(telemetry.usageEvents, telemetry.costs)
  const steps = buildUsageSteps(telemetry.usageEvents, runtime.lastUsageAt)
  const error = failure ?? telemetry.errors[0] ?? (!evaluation.success ? 'acceptance checks failed' : undefined)
  const result: TaskResult = {
    index: index + 1,
    slug: task.slug,
    title: task.title,
    success: !error,
    attempts,
    firstAttemptSuccess,
    repaired: attempts > 1 && !firstAttemptSuccess && !error,
    agentDurationMs,
    endToEndDurationMs: agentDurationMs,
    usage: { ...usageFromEvents, ...(steps.length > 0 ? { steps } : {}) },
    toolCalls: telemetry.toolCalls,
    evaluation,
    finalMessage: '',
    ...(error ? { error: compact(error, 500) } : {}),
  }
  runtime.report.tasks.push(result)
  runtime.report.finalSessionUsage = zeroUsage()
  runtime.current = undefined
  return result
}

async function runDeepSeekTask(runtime: DeepSeekLiveArm, task: HardTask, index: number): Promise<TaskResult> {
  const started = performance.now()
  const usageParts: DeepSeekTokenTotals[] = []
  let attempts = 0
  let firstAttemptSuccess = false
  let evaluation: TaskEvaluation | undefined
  let answer = ''
  let failure: string | undefined
  const retries = verifyRetryLimit()
  while (attempts <= retries) {
    const prompt = attempts === 0 ? task.prompt : repairPromptFor(task, evaluation!)
    attempts += 1
    try {
      const response = await runtime.harness.run(prompt, runtime.sessionID || undefined)
      runtime.sessionID = response.sessionID
      runtime.report.sessionID = response.sessionID
      answer = response.answer
      usageParts.push(response.usage)
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error)
      runtime.errors.push(failure)
      if (/model not found|usage limit|quota/i.test(failure)) throw new Error(`[${runtime.arm}] ${compact(failure, 200)}`)
      break
    }
    await delay(200)
    evaluation = await evaluateHardTask(runtime.workspace, task)
    if (attempts === 1) firstAttemptSuccess = evaluation.success
    if (evaluation.success) break
    process.stdout.write(`  ${runtime.arm}/${task.slug}: attempt ${attempts} failed, feeding ${Object.values(evaluation.checks).filter((check) => !check.passed).length} failures back\n`)
  }
  evaluation ??= { success: false, passedChecks: 0, totalChecks: 0, checks: {} }
  const usage = usageParts.reduce((sum, part) => addUsage(sum, deepSeekUsage(part)), zeroUsage())
  const error = failure ?? (!evaluation.success ? 'acceptance checks failed' : undefined)
  const result: TaskResult = {
    index: index + 1,
    slug: task.slug,
    title: task.title,
    success: !error,
    attempts,
    firstAttemptSuccess,
    repaired: attempts > 1 && !firstAttemptSuccess && !error,
    agentDurationMs: Math.round(performance.now() - started),
    endToEndDurationMs: Math.round(performance.now() - started),
    usage: {
      ...usage,
      eventCount: usageParts.reduce((sum, part) => sum + part.modelCalls, 0),
      cost: 0,
    },
    toolCalls: usageParts.reduce((sum, part) => sum + part.toolCalls, 0),
    evaluation,
    finalMessage: answer,
    ...(error ? { error: compact(error, 500) } : {}),
  }
  runtime.report.tasks.push(result)
  runtime.report.finalSessionUsage = usage
  return result
}

function deepSeekUsage(usage: DeepSeekTokenTotals): UsageStats {
  const totalModel = usage.totalModelTokens
  return {
    input: usage.inputTokens,
    output: usage.outputTokens,
    reasoning: usage.reasoningTokens,
    cacheRead: usage.cacheReadTokens,
    cacheWrite: usage.cacheWriteTokens,
    totalModel,
    totalWithCache: totalModel + usage.cacheReadTokens + usage.cacheWriteTokens,
  }
}

function repairPromptFor(task: HardTask, evaluation: TaskEvaluation): string {
  const failed = Object.entries(evaluation.checks).filter(([, check]) => !check.passed)
  return [
    'Your previous attempt did not fully satisfy the task. A deterministic verifier reported these exact problems:',
    ...failed.map(([name, check]) => `- ${name}: ${compact(check.detail, 260)}`),
    'Fix only these verified problems, keep everything else working, re-inspect your changes, then reply.',
  ].join('\n')
}

async function seedProviderState(paths: Awaited<ReturnType<typeof createRuntimePaths>>): Promise<void> {
  const persistentRoot = join(homedir(), '.cuppet', 'v2', 'opencode')
  for (const [source, target] of [
    [join(persistentRoot, 'data', 'opencode', 'auth.json'), join(paths.opencode.data, 'opencode', 'auth.json')],
    [join(persistentRoot, 'cache', 'opencode', 'models.json'), join(paths.opencode.cache, 'opencode', 'models.json')],
  ] as const) {
    try {
      await mkdir(join(target, '..'), { recursive: true, mode: 0o700 })
      await writeFile(target, await readFile(source), { mode: 0o600 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
}

async function waitForIndex(runtime: TstRuntime): Promise<void> {
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    const status = await runtime.client.call<{ graph?: { progress?: { complete?: boolean } } }>('status')
    if (status.graph?.progress?.complete) return
    await delay(100)
  }
  throw new Error('TST graph index timed out')
}

async function startOfficialOpenCodeServer(binary: string, paths: Awaited<ReturnType<typeof createRuntimePaths>>, logger: RedactedLogger): Promise<BenchmarkRuntime> {
  const username = 'official-hard-benchmark'
  const password = randomBytes(32).toString('base64url')
  const config = {
    $schema: 'https://opencode.ai/config.json',
    autoupdate: false,
    share: 'disabled',
    default_agent: 'build',
    server: { mdns: false },
    experimental: { openTelemetry: false },
  }
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    XDG_CONFIG_HOME: paths.opencode.config,
    XDG_DATA_HOME: paths.opencode.data,
    XDG_CACHE_HOME: paths.opencode.cache,
    XDG_STATE_HOME: paths.opencode.state,
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
    OPENCODE_SERVER_USERNAME: username,
    OPENCODE_SERVER_PASSWORD: password,
    OPENCODE_DISABLE_AUTOUPDATE: 'true',
  }
  for (const key of Object.keys(environment)) {
    if (key.startsWith('CUPPET_')) delete environment[key]
  }
  const child = spawn(binary, ['serve', '--hostname=127.0.0.1', '--port=0', '--mdns=false'], {
    cwd: paths.projectRealpath,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: environment,
  })
  child.stderr?.on('data', (chunk: Buffer) => void logger.write('warn', `official opencode: ${chunk.toString('utf8')}`))
  try {
    const url = await waitForListening(child)
    const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
    const client = createOpencodeClient({ baseUrl: url, directory: paths.projectRealpath, headers: { authorization } })
    const health = await client.global.health({ throwOnError: true })
    if (!(health.data as { healthy?: boolean } | undefined)?.healthy) throw new Error('official OpenCode health check failed')
    return {
      client,
      async close() {
        try {
          await Promise.race([client.global.dispose({ throwOnError: true }), new Promise((resolvePromise) => setTimeout(resolvePromise, 1_500))])
        } catch {}
        if (child.exitCode === null) child.kill('SIGTERM')
      },
    }
  } catch (error) {
    if (child.exitCode === null) child.kill('SIGTERM')
    throw error
  }
}

function waitForListening(child: ChildProcess): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    if (!child.stdout) return rejectPromise(new Error('OpenCode stdout is unavailable'))
    const stdout = child.stdout
    let output = ''
    const timeout = setTimeout(() => {
      cleanup()
      rejectPromise(new Error(`Timed out waiting for OpenCode: ${compact(output, 1_000)}`))
    }, 15_000)
    const onData = (chunk: Buffer) => {
      output += chunk.toString('utf8')
      for (const line of output.split(/\r?\n/)) {
        const match = /^opencode server listening on (https?:\/\/\S+)/.exec(line.trim())
        if (!match?.[1]) continue
        cleanup()
        resolvePromise(match[1])
        return
      }
    }
    const onExit = (code: number | null) => {
      cleanup()
      rejectPromise(new Error(`OpenCode server exited with code ${code}: ${compact(output, 1_000)}`))
    }
    const onError = (error: Error) => {
      cleanup()
      rejectPromise(error)
    }
    const cleanup = () => {
      clearTimeout(timeout)
      stdout.off('data', onData)
      child.off('exit', onExit)
      child.off('error', onError)
    }
    stdout.on('data', onData)
    child.once('exit', onExit)
    child.once('error', onError)
  })
}

// ---------------------------------------------------------------------------
// Reporting.
// ---------------------------------------------------------------------------

type Report = ReturnType<typeof buildReport>

function buildReport(reports: Partial<Record<Arm, ArmReport>>, artifacts: string) {
  const summarize = (report: ArmReport | undefined) => {
    const values = report?.tasks ?? []
    const usage = values.reduce((sum, task) => addUsage(sum, task.usage), zeroUsage())
    return {
      tasks: values.length,
      successes: values.filter((task) => task.success).length,
      firstAttemptSuccesses: values.filter((task) => task.firstAttemptSuccess).length,
      repairedTasks: values.filter((task) => task.repaired).length,
      totalAgentDurationMs: values.reduce((sum, task) => sum + task.agentDurationMs, 0),
      medianAgentDurationMs: median(values.map((task) => task.agentDurationMs)),
      uncachedInput: usage.input,
      cacheRead: usage.cacheRead,
      totalModelTokens: usage.totalModel,
      cacheShare: usage.input + usage.cacheRead === 0 ? 0 : usage.cacheRead / (usage.input + usage.cacheRead),
      adjustedCacheShare: (() => {
        let input = 0
        let read = 0
        for (const task of values) {
          for (const step of task.usage.steps ?? []) {
            if (step.gapSeconds === undefined || step.gapSeconds > CACHE_IDLE_GAP_SECONDS) continue
            input += step.input
            read += step.cacheRead
          }
        }
        return input + read === 0 ? 0 : read / (input + read)
      })(),
      toolCalls: values.reduce((sum, task) => sum + task.toolCalls, 0),
      passedChecks: values.reduce((sum, task) => sum + task.evaluation.passedChecks, 0),
      totalChecks: values.reduce((sum, task) => sum + task.evaluation.totalChecks, 0),
      errors: report?.errors ?? [],
    }
  }
  const opencode = summarize(reports.opencode)
  const cuppet = summarize(reports.cuppet)
  const deepseekHarness = summarize(reports['deepseek-harness'])
  const ratio = (numerator: number, denominator: number) => (denominator === 0 ? 0 : numerator / denominator)
  const compare = (baseline: ReturnType<typeof summarize>, candidate: ReturnType<typeof summarize>) => ({
    successDelta: candidate.successes - baseline.successes,
    timeReduction: ratio(baseline.totalAgentDurationMs - candidate.totalAgentDurationMs, baseline.totalAgentDurationMs),
    medianTimeReduction: ratio(baseline.medianAgentDurationMs - candidate.medianAgentDurationMs, baseline.medianAgentDurationMs),
    uncachedInputReduction: ratio(baseline.uncachedInput - candidate.uncachedInput, baseline.uncachedInput),
    totalTokenReduction: ratio(baseline.totalModelTokens - candidate.totalModelTokens, baseline.totalModelTokens),
    toolCallReduction: ratio(baseline.toolCalls - candidate.toolCalls, baseline.toolCalls),
    cacheShareDelta: candidate.cacheShare - baseline.cacheShare,
    checkDelta: candidate.passedChecks - baseline.passedChecks,
  })
  const comparisons = {
    'cuppet-vs-opencode': compare(opencode, cuppet),
    'deepseek-harness-vs-opencode': compare(opencode, deepseekHarness),
    'cuppet-vs-deepseek-harness': compare(deepseekHarness, cuppet),
  }
  return {
    schema: 1,
    createdAt: new Date().toISOString(),
    model,
    fixtureFiles: Object.keys(fixture).length,
    fixtureHash: fixtureHashInput.digest('hex'),
    artifacts,
    arms: {
      opencode: reports.opencode,
      cuppet: reports.cuppet,
      'deepseek-harness': reports['deepseek-harness'],
    },
    summary: {
      arms: { opencode, cuppet, 'deepseek-harness': deepseekHarness },
      opencode,
      cuppet,
      'deepseek-harness': deepseekHarness,
      comparisons,
      comparison: comparisons['cuppet-vs-opencode'],
    },
  }
}

/** Reductions print as −x% (improvement) or +x% (regression). */
function signedPct(reduction: number, lowerIsBetter = false): string {
  const value = Math.abs(reduction * 100).toFixed(1)
  if (lowerIsBetter) return `${reduction >= 0 ? '−' : '+'}${value}%${reduction < 0 ? ' (slower)' : ''}`
  return `${reduction >= 0 ? '−' : '+'}${value}%${reduction < 0 ? ' (more)' : ''}`
}

function renderMarkdown(report: Report): string {
  const { opencode, cuppet, 'deepseek-harness': deepseekHarness } = report.summary
  const arms: Array<[Arm, string, typeof opencode]> = [
    ['opencode', 'OpenCode', opencode],
    ['cuppet', 'Cuppet', cuppet],
    ['deepseek-harness', 'DeepSeek Harness', deepseekHarness],
  ]
  const rows = hardTasks.map((task) => {
    const find = (arm: ArmReport | undefined) => arm?.tasks.find((item) => item.slug === task.slug)
    const cell = (value: ReturnType<typeof find>) =>
      value ? `${value.success ? 'pass' : 'FAIL'}${value.repaired ? '*' : ''} (${value.evaluation.passedChecks}/${value.evaluation.totalChecks}) · ${Math.round(value.agentDurationMs / 1000)}s · in ${value.usage.input.toLocaleString()} / tok ${value.usage.totalModel.toLocaleString()}` : 'missing'
    return `| ${task.title} | ${arms.map(([arm]) => cell(find(report.arms[arm]))).join(' | ')} |`
  })
  return [
    `# Hard-fixture benchmark: OpenCode vs Cuppet vs DeepSeek Harness`,
    '',
    `- Created: ${report.createdAt}`,
    `- Model: \`${report.model.providerID}/${report.model.modelID}\`${report.model.variant ? ` @${report.model.variant}` : ''}`,
    `- Fixture: ${report.fixtureFiles} files, hash ${report.fixtureHash.slice(0, 12)}…`,
    `- All arms: persistent sessions, concurrent per task, verification guard enabled.`,
    '',
    `| Metric | ${arms.map(([, label]) => label).join(' | ')} |`,
    '|---|---:|---:|---:|',
    `| Correct tasks | ${arms.map(([, , summary]) => `${summary.successes}/${summary.tasks}`).join(' | ')} |`,
    `| First-attempt correct | ${arms.map(([, , summary]) => summary.firstAttemptSuccesses).join(' | ')} |`,
    `| Repairs needed | ${arms.map(([, , summary]) => summary.repairedTasks).join(' | ')} |`,
    `| Total agent time | ${arms.map(([, , summary]) => `${(summary.totalAgentDurationMs / 1000).toFixed(0)} s`).join(' | ')} |`,
    `| Median task time | ${arms.map(([, , summary]) => `${(summary.medianAgentDurationMs / 1000).toFixed(0)} s`).join(' | ')} |`,
    `| Uncached input | ${arms.map(([, , summary]) => summary.uncachedInput.toLocaleString()).join(' | ')} |`,
    `| Total model tokens | ${arms.map(([, , summary]) => summary.totalModelTokens.toLocaleString()).join(' | ')} |`,
    `| Tool calls | ${arms.map(([, , summary]) => summary.toolCalls).join(' | ')} |`,
    `| Cache share | ${arms.map(([, , summary]) => `${(summary.cacheShare * 100).toFixed(1)}%`).join(' | ')} |`,
    `| Acceptance checks | ${arms.map(([, , summary]) => `${summary.passedChecks}/${summary.totalChecks}`).join(' | ')} |`,
    '',
    `| Task | ${arms.map(([, label]) => label).join(' | ')} |`,
    `|---|${arms.map(() => '---').join('|')}|`,
    ...rows,
    '',
    '* = recovered by the verification guard. Time/tokens aggregate across all attempts of a task. Pairwise reductions remain in the JSON report under summary.comparisons.',
    '',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Shared small helpers.
// ---------------------------------------------------------------------------

function usageFromCuppet(value: TokenUsage): UsageStats {
  const totalModel = value.input + value.output + value.reasoning
  return {
    input: value.input,
    output: value.output,
    reasoning: value.reasoning,
    cacheRead: value.cacheRead,
    cacheWrite: value.cacheWrite,
    totalModel,
    totalWithCache: totalModel + value.cacheRead + value.cacheWrite,
  }
}
function zeroUsage(): UsageStats {
  return { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, totalModel: 0, totalWithCache: 0 }
}
function addUsage(left: UsageStats, right: UsageStats): UsageStats {
  const input = left.input + right.input
  const output = left.output + right.output
  const reasoning = left.reasoning + right.reasoning
  const cacheRead = left.cacheRead + right.cacheRead
  const cacheWrite = left.cacheWrite + right.cacheWrite
  const totalModel = input + output + reasoning
  return { input, output, reasoning, cacheRead, cacheWrite, totalModel, totalWithCache: totalModel + cacheRead + cacheWrite }
}
function usageFromEventList(events: UsageSample[], costs: number[]): TaskUsage {
  const usage = events.reduce((sum, value) => addUsage(sum, usageFromCuppet(value)), zeroUsage())
  return { ...usage, eventCount: events.length, cost: costs.reduce((sum, value) => sum + value, 0) }
}
function buildUsageSteps(events: UsageSample[], priorAt: number | undefined): UsageStep[] {
  return events.map((sample, index) => {
    const previousAt = index > 0 ? events[index - 1]!.at : priorAt
    const gapSeconds = previousAt === undefined ? undefined : Math.max(0, Math.round((sample.at - previousAt) / 1000))
    return { gapSeconds, ...usageFromCuppet(sample) }
  })
}
function countMatches(value: string, pattern: RegExp): number {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`
  return [...value.matchAll(new RegExp(pattern.source, flags))].length
}
async function listFiles(root: string, prefix = ''): Promise<string[]> {
  const { readdir } = await import('node:fs/promises')
  const entries = await readdir(join(root, prefix), { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const path = join(prefix, entry.name)
    if (entry.isDirectory()) files.push(...await listFiles(root, path))
    else if (entry.isFile()) files.push(path)
  }
  return files.sort()
}
async function runCommand(command: string, args: string[], cwd: string, timeout: number): Promise<CommandResult> {
  const started = performance.now()
  try {
    const result = await execFile(command, args, { cwd, env: { ...process.env, CI: '1', NO_COLOR: '1' }, timeout, maxBuffer: 1_000_000 })
    return { passed: true, code: 0, stdout: result.stdout, stderr: result.stderr, durationMs: Math.round(performance.now() - started) }
  } catch (error) {
    const failure = error as Error & { code?: number | string; stdout?: string; stderr?: string }
    return { passed: false, code: failure.code ?? 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? failure.message, durationMs: Math.round(performance.now() - started) }
  }
}
function mustPass(result: CommandResult, label: string): void {
  if (!result.passed) throw new Error(`${label} failed: ${compact(`${result.stderr} ${result.stdout}`, 500)}`)
}
async function commandVersion(command: string): Promise<string> {
  const result = await runCommand(command, ['--version'], project, 10_000)
  return compact(`${result.stdout} ${result.stderr}`, 300)
}
function compact(value: string, limit: number): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, limit)
}
function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}
function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2 : sorted[middle] ?? 0
}
function withTimeout<T>(promise: Promise<T>, timeout: number, message: string): Promise<T> {
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error(message)), timeout)
    promise.then(
      (value) => { clearTimeout(timer); resolvePromise(value) },
      (error) => { clearTimeout(timer); rejectPromise(error) },
    )
  })
}
async function writeAtomic(path: string, contents: string): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  await writeFile(temporary, contents, { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, path)
}

main().catch((error) => {
  process.stderr.write(`Hard-fixture benchmark failed: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})

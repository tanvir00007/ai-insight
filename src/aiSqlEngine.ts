import { getDb } from './db';
import { QueryResult } from './aiQueryEngine';
import { requestCanonicalIntent } from './aiIntentEngine';
import { defaultQueryPlan } from './aiSchema';
import { buildSqlPlanFromIntent } from './aiSqlTemplates';
import { logAiTrace } from './aiTrace';
import { Staff } from './types';

export type SqlQueryPlan = {
  sql: string;
  reasoning?: string;
  answerFocus?: string;
};

export type SqlQueryOptions = {
  forceLlmPlanner?: boolean;
  useLocalDraft?: boolean;
  allowReadyAnswer?: boolean;
};

const DEMO_SQL_PLAN_TIMEOUT_MS = 180000;

const ALLOWED_VIEWS = [
  'ai_members',
  'ai_loans',
  'ai_due_schedules',
  'ai_savings',
  'ai_transactions',
  'ai_cdo_portfolio',
];

const VIEW_COLUMNS: Record<string, string[]> = {
  ai_members: [
    'member_id',
    'member_code',
    'member_name',
    'phone',
    'spouse_name',
    'occupation',
    'address',
    'joined_at',
    'risk_note',
    'vo_id',
    'vo_code',
    'vo_name',
    'meeting_day',
    'meeting_time',
    'area',
    'cdo_id',
    'cdo_code',
    'cdo_name',
    'branch_id',
    'branch_code',
    'branch_name',
  ],
  ai_loans: [
    'loan_id',
    'member_id',
    'member_name',
    'vo_id',
    'vo_name',
    'cdo_id',
    'cdo_name',
    'branch_id',
    'product_name',
    'principal_amount',
    'outstanding_amount',
    'installment_amount',
    'disbursed_at',
    'status',
    'next_due_date',
  ],
  ai_due_schedules: [
    'schedule_id',
    'loan_id',
    'member_id',
    'member_name',
    'vo_id',
    'vo_name',
    'cdo_id',
    'cdo_name',
    'branch_id',
    'product_name',
    'loan_status',
    'installment_no',
    'due_date',
    'due_amount',
    'paid_amount',
    'pending_amount',
    'schedule_status',
    'overdue_days',
  ],
  ai_savings: [
    'member_id',
    'member_name',
    'vo_id',
    'vo_name',
    'cdo_id',
    'cdo_name',
    'branch_id',
    'savings_balance',
    'weekly_target',
    'dps_balance',
    'dps_monthly_target',
    'maturity_date',
  ],
  ai_transactions: [
    'transaction_id',
    'transaction_date',
    'member_id',
    'member_name',
    'vo_id',
    'vo_name',
    'cdo_id',
    'cdo_name',
    'branch_id',
    'staff_id',
    'product_type',
    'product_id',
    'transaction_type',
    'amount',
    'note',
  ],
  ai_cdo_portfolio: [
    'cdo_id',
    'cdo_code',
    'cdo_name',
    'branch_id',
    'vo_count',
    'member_count',
    'due_amount',
    'overdue_amount',
    'overdue_members',
    'collected_today',
    'savings_balance',
    'dps_balance',
  ],
};

const SQL_SCHEMA = {
  views: Object.entries(VIEW_COLUMNS).map(([name, columns]) => `${name}(${columns.join(', ')})`),
  notes: [
    'For CDO questions about their own portfolio, filter with cdo_id = staff.id.',
    'For BM questions, filter with branch_id = staff.branch_id.',
    'For CDO ranking/comparison questions, branch-level ai_cdo_portfolio is allowed with branch_id = staff.branch_id.',
    'For member names who paid/collected today, use ai_transactions with transaction_date = date("now").',
    'Use schedule_status != "PAID" for pending dues.',
    'Use due_date <= date("now") for due today or pending collection.',
    'Use due_date < date("now") for overdue.',
  ],
};

export function sqlPlannerSchema() {
  return SQL_SCHEMA;
}

export async function planAndRunIntentSqlQuery(
  gatewayUrls: string[],
  user: Staff,
  question: string,
  traceId: string,
  options: SqlQueryOptions = {},
): Promise<QueryResult | null> {
  const intentStartedAt = Date.now();
  const intent = await requestCanonicalIntent(gatewayUrls, user, question, traceId);
  logAiTrace(traceId, 'canonical_intent_result', {
    durationMs: Date.now() - intentStartedAt,
    intent,
  });
  if (!intent) return null;

  const sqlPlan = buildSqlPlanFromIntent(intent, user);
  logAiTrace(traceId, 'intent_sql_template_result', {
    intent,
    sqlPlan,
  });
  if (!sqlPlan) return null;

  const validationStartedAt = Date.now();
  const validated = validateSqlPlan(sqlPlan, user, question);
  logAiTrace(traceId, 'intent_sql_plan_validated', {
    durationMs: Date.now() - validationStartedAt,
    sqlPlan,
    validation: validated,
  });
  if (!validated.ok) return null;

  const queryStartedAt = Date.now();
  const db = await getDb();
  const rows = await db.getAllAsync<Record<string, unknown>>(validated.sql);
  const facts = {
    sqlPlan,
    canonicalIntent: intent,
    executedSql: validated.sql,
    rowCount: rows.length,
    readyAnswer: options.allowReadyAnswer === false ? false : canAnswerLocally(rows),
    scope: user.role === 'BM' ? { branch_id: user.branch_id } : { cdo_id: user.id, branch_id: user.branch_id },
  };
  const localDraftBangla = options.useLocalDraft === false ? '' : buildLocalSqlDraft(rows, sqlPlan);
  logAiTrace(traceId, 'intent_sql_query_result', {
    durationMs: Date.now() - queryStartedAt,
    facts,
    sampleRows: rows.slice(0, 5),
    localDraftBangla,
  });

  return {
    metric: intent.intent.includes('pending') ? 'collections_due' : 'collection_history',
    plan: {
      ...defaultQueryPlan,
      metric: intent.intent.includes('pending') ? 'collections_due' : 'collection_history',
      answer_type: 'summary',
      scope: user.role === 'BM' ? 'branch' : 'current_user',
      timeframe_days: 1,
      group_by: intent.intent.includes('members') ? 'member' : 'none',
      reasoning: `Canonical intent: ${intent.intent}`,
    },
    facts,
    rows,
    localDraftBangla,
  };
}

export async function planAndRunSqlQuery(
  gatewayUrls: string[],
  user: Staff,
  question: string,
  traceId: string,
  options: SqlQueryOptions = {},
): Promise<QueryResult | null> {
  let validationFeedback: string | undefined;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const sqlPlan = await requestSqlPlan(gatewayUrls, user, question, traceId, options, validationFeedback);
    if (!sqlPlan) return null;

    const validationStartedAt = Date.now();
    const validated = validateSqlPlan(sqlPlan, user, question);
    logAiTrace(traceId, 'sql_plan_validated', {
      attempt,
      durationMs: Date.now() - validationStartedAt,
      sqlPlan,
      validation: validated,
    });
    if (!validated.ok) {
      validationFeedback = validated.reason;
      logAiTrace(traceId, 'sql_plan_rejected', {
        attempt,
        reason: validationFeedback,
      });
      continue;
    }

    const queryStartedAt = Date.now();
    const db = await getDb();
    const rows = await db.getAllAsync<Record<string, unknown>>(validated.sql);
    const facts = {
      sqlPlan,
      executedSql: validated.sql,
      rowCount: rows.length,
      readyAnswer: options.allowReadyAnswer === false ? false : canAnswerLocally(rows),
      scope: user.role === 'BM' ? { branch_id: user.branch_id } : { cdo_id: user.id, branch_id: user.branch_id },
    };
    const localDraftBangla = options.useLocalDraft === false ? '' : buildLocalSqlDraft(rows, sqlPlan);
    logAiTrace(traceId, 'sql_query_result', {
      durationMs: Date.now() - queryStartedAt,
      facts,
      sampleRows: rows.slice(0, 5),
      localDraftBangla,
    });

    return {
      metric: 'portfolio_summary',
      plan: {
        ...defaultQueryPlan,
        metric: 'portfolio_summary',
        answer_type: 'summary',
        scope: user.role === 'BM' ? 'branch' : 'current_user',
        reasoning: `LLM SQL planner: ${sqlPlan.reasoning ?? 'dynamic SQL query'}`,
      },
      facts,
      rows,
      localDraftBangla,
    };
  }

  return null;
}

async function requestSqlPlan(
  gatewayUrls: string[],
  user: Staff,
  question: string,
  traceId: string,
  options: SqlQueryOptions,
  validationFeedback?: string,
) {
  for (const gatewayUrl of gatewayUrls) {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const startedAt = Date.now();
    try {
      const controller = new AbortController();
      timeout = setTimeout(() => controller.abort(), DEMO_SQL_PLAN_TIMEOUT_MS);
      const payload = {
        traceId,
        question,
        staff: { id: user.id, name: user.name, role: user.role, branch_id: user.branch_id },
        schema: sqlPlannerSchema(),
        forceLlmSqlPlanner: Boolean(options.forceLlmPlanner),
        validationFeedback,
      };
      logAiTrace(traceId, 'sql_plan_request_prepared', {
        gatewayUrl,
        payload,
      });
      const response = await fetch(`${gatewayUrl}/api/ai/query-plan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      timeout = null;
      if (!response.ok) throw new Error(`SQL plan failed ${response.status}`);
      const json = await response.json();
      logAiTrace(traceId, 'sql_plan_response', {
        gatewayUrl,
        durationMs: Date.now() - startedAt,
        response: json,
      });
      const sqlPlan = json.sqlPlan;
      if (!sqlPlan?.sql || json.source === 'fallback') {
        const clarification = json.queryPlan?.clarification ? ` Clarification: ${json.queryPlan.clarification}` : '';
        throw new Error(`${json.error ?? 'Query planner fallback'}${clarification}`);
      }
      return {
        sql: String(sqlPlan.sql),
        reasoning: sqlPlan.reasoning ? String(sqlPlan.reasoning) : undefined,
        answerFocus: sqlPlan.answerFocus ? String(sqlPlan.answerFocus) : undefined,
      } satisfies SqlQueryPlan;
    } catch (error) {
      logAiTrace(traceId, 'sql_plan_error', {
        gatewayUrl,
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
  return null;
}

function validateSqlPlan(sqlPlan: SqlQueryPlan, user: Staff, question: string): { ok: true; sql: string } | { ok: false; reason: string } {
  const raw = sqlPlan.sql.trim();
  const sql = raw.endsWith(';') ? raw.slice(0, -1).trim() : raw;
  const lower = sql.toLowerCase().replace(/\s+/g, ' ');

  if (!lower.startsWith('select ')) return { ok: false, reason: 'SQL must start with SELECT' };
  if (/[;]/.test(sql)) return { ok: false, reason: 'Multiple SQL statements are not allowed' };
  if (/--|\/\*|\*\//.test(sql)) return { ok: false, reason: 'SQL comments are not allowed' };
  if (/\b(insert|update|delete|drop|alter|create|pragma|attach|detach|replace|vacuum|with|union)\b/i.test(sql)) {
    return { ok: false, reason: 'Unsafe SQL keyword detected' };
  }

  const referencedViews = Array.from(sql.matchAll(/\b(?:from|join)\s+([a-zA-Z_][a-zA-Z0-9_]*)/gi)).map((match) => match[1].toLowerCase());
  if (referencedViews.length === 0) return { ok: false, reason: 'SQL must reference at least one analytics view' };
  const unknownView = referencedViews.find((view) => !ALLOWED_VIEWS.includes(view));
  if (unknownView) return { ok: false, reason: `View not allowed: ${unknownView}` };
  const invalidColumn = findInvalidColumn(sql, referencedViews);
  if (invalidColumn) return { ok: false, reason: `Column ${invalidColumn.column} is not available on ${invalidColumn.view}` };
  const semanticMismatch = findSemanticMismatch(question, referencedViews);
  if (semanticMismatch) return { ok: false, reason: semanticMismatch };

  if (!hasValidScope(lower, user, question, referencedViews)) {
    return { ok: false, reason: 'Required role scope filter is missing' };
  }

  const withoutLimit = sql.replace(/\s+limit\s+\d+\s*$/i, '').trim();
  return { ok: true, sql: `SELECT * FROM (${withoutLimit}) AS ai_safe_result LIMIT 20` };
}

function hasValidScope(sql: string, user: Staff, question: string, views: string[]) {
  const branchScoped = scopedEquals(sql, 'branch_id', user.branch_id);
  const cdoScoped = scopedEquals(sql, 'cdo_id', user.id) || scopedEquals(sql, 'staff_id', user.id);
  if (user.role === 'BM') return branchScoped;
  const peerComparison = views.includes('ai_cdo_portfolio') && /cdo|সিডিও|ranking|rank|compare|তুলনা|কার|কোন|বেশি/i.test(question);
  return cdoScoped || (peerComparison && branchScoped);
}

function scopedEquals(sql: string, column: string, value: number) {
  const pattern = new RegExp(`\\b${column}\\b\\s*=\\s*['"]?${value}['"]?\\b`, 'i');
  return pattern.test(sql);
}

function buildLocalSqlDraft(rows: Record<string, unknown>[], sqlPlan: SqlQueryPlan) {
  if (rows.length === 0) {
    return 'স্থানীয় ডাটায় এই প্রশ্নের জন্য কোনো মিল পাওয়া যায়নি। বানান একটু সহজ করে আবার লিখলে আমি আবার খুঁজে দেখব।';
  }
  if (rows.some((row) => 'member_name' in row)) {
    const names = Array.from(new Set(rows.map((row) => String(row.member_name ?? '')).filter(Boolean)));
    const totalAmount = rows.reduce((sum, row) => sum + Number(row.amount ?? 0), 0);
    const amountText = totalAmount > 0 ? ` মোট আদায় ${money(totalAmount)}।` : '';
    return `আজ collection হয়েছে এমন সদস্য ${names.length} জন: ${names.slice(0, 12).join(', ')}।${amountText}`;
  }
  if (rows.length === 1) {
    const row = rows[0];
    if ('pending_installments' in row || 'pending_members' in row || 'pending_amount' in row) {
      return `আজ এখনো ${row.pending_installments ?? 0}টি collection বাকি আছে, সদস্য ${row.pending_members ?? 0} জন, মোট বাকি ${money(Number(row.pending_amount ?? 0))}।`;
    }
  }
  const first = rows[0];
  const useful = Object.entries(first)
    .filter(([, value]) => value !== null && value !== undefined)
    .slice(0, 6)
    .map(([key, value]) => `${key}: ${String(value)}`)
    .join(', ');
  return `স্থানীয় ডাটায় ${rows.length}টি ফলাফল পাওয়া গেছে। প্রথম ফলাফল: ${useful}। ${sqlPlan.answerFocus ?? ''}`.trim();
}

function canAnswerLocally(rows: Record<string, unknown>[]) {
  if (rows.length === 0) return true;
  const first = rows[0];
  return 'member_name' in first || 'pending_installments' in first || 'pending_members' in first || 'pending_amount' in first;
}

function findInvalidColumn(sql: string, referencedViews: string[]) {
  if (referencedViews.length !== 1) return null;
  const view = referencedViews[0];
  const columns = VIEW_COLUMNS[view] ?? [];
  const knownColumns = Array.from(new Set(Object.values(VIEW_COLUMNS).flat()));
  for (const column of knownColumns) {
    if (!columns.includes(column) && new RegExp(`\\b${column}\\b`, 'i').test(sql)) {
      return { view, column };
    }
  }
  return null;
}

function findSemanticMismatch(question: string, referencedViews: string[]) {
  const normalized = question.toLowerCase();
  const hasPendingIntent =
    /\b(baki|pending|remaining|due|outstanding|pabo|paowa|payable)\b/i.test(normalized) ||
    /বাকি|পাব|পাওনা|আদায়যোগ্য|আদায়যোগ্য|দেয়|দেয়|কিস্তি বাকি/.test(normalized);
  const hasCompletedCollectionIntent =
    /\b(hoyeche|hoyeache|hoyese|hoyse|hoise|holo|hoilo|korechi|collected|paid)\b/i.test(normalized) ||
    /হয়েছে|হয়েছে|হলো|করেছি|আদায় হয়েছে|আদায় হয়েছে/.test(normalized);

  if (hasPendingIntent && referencedViews.includes('ai_transactions') && !referencedViews.includes('ai_due_schedules')) {
    return 'Semantic mismatch: this is a pending/due/remaining collection question, so use ai_due_schedules with schedule_status != "PAID" and pending_amount, not ai_transactions.';
  }
  if (hasCompletedCollectionIntent && referencedViews.includes('ai_due_schedules') && !referencedViews.includes('ai_transactions')) {
    return 'Semantic mismatch: this is a completed/collected/payment question, so use ai_transactions, not ai_due_schedules.';
  }
  return null;
}

function money(value: number) {
  return `৳${Math.round(value || 0).toLocaleString('en-US')}`;
}

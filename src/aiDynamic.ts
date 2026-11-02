import { getAiGatewayUrls } from './network';
import { defaultQueryPlan, QueryPlan, sanitizeQueryPlan, schemaPrompt } from './aiSchema';
import { executeQueryPlan, localPlanFromQuestion, QueryResult } from './aiQueryEngine';
import { planAndRunSqlQuery } from './aiSqlEngine';
import { createAiTraceId, logAiTrace } from './aiTrace';
import { Staff } from './types';

const DEMO_ONLINE_PLAN_TIMEOUT_MS = 180000;
const DEMO_COMPOSE_TIMEOUT_MS = 180000;

export type DynamicAnswer = {
  text: string;
  source: 'offline' | 'online';
  plan: QueryPlan;
  result: QueryResult;
};

export async function answerLlmSqlQuestion(user: Staff, question: string): Promise<DynamicAnswer> {
  const traceId = createAiTraceId();
  const totalStartedAt = Date.now();
  const gatewayUrls = getAiGatewayUrls();
  logAiTrace(traceId, 'user_input', {
    mode: 'strict_llm_sql',
    question,
    staff: { id: user.id, name: user.name, role: user.role, branch_id: user.branch_id },
    gatewayUrls,
  });

  const sqlStartedAt = Date.now();
  const sqlResult = await planAndRunSqlQuery(gatewayUrls, user, question, traceId, {
    forceLlmPlanner: true,
    useLocalDraft: false,
    allowReadyAnswer: false,
  });
  logAiTrace(traceId, 'strict_sql_path_result', {
    durationMs: Date.now() - sqlStartedAt,
    usedSqlPath: Boolean(sqlResult),
  });
  if (!sqlResult) {
    throw new Error('LLM SQL planner did not return a valid local query.');
  }

  const onlineText = await composeOnlineAnswer(gatewayUrls, user, question, sqlResult, true, traceId, {
    includeSuggestedAnswer: false,
    strictLlmSqlMode: true,
  });
  if (!onlineText) {
    throw new Error('LLM final answer was not available.');
  }

  logAiTrace(traceId, 'final_answer', {
    durationMs: Date.now() - totalStartedAt,
    source: 'online',
    text: onlineText,
    strictLlmSqlMode: true,
  });

  return {
    text: onlineText,
    source: 'online',
    plan: sqlResult.plan,
    result: sqlResult,
  };
}

export async function answerDynamicQuestion(user: Staff, question: string): Promise<DynamicAnswer> {
  const traceId = createAiTraceId();
  const totalStartedAt = Date.now();
  const gatewayUrls = getAiGatewayUrls();
  logAiTrace(traceId, 'user_input', {
    question,
    staff: { id: user.id, name: user.name, role: user.role, branch_id: user.branch_id },
    gatewayUrls,
  });

  const sqlStartedAt = Date.now();
  const sqlResult = await planAndRunSqlQuery(gatewayUrls, user, question, traceId);
  logAiTrace(traceId, 'sql_first_path_result', {
    durationMs: Date.now() - sqlStartedAt,
    usedSqlPath: Boolean(sqlResult),
  });
  if (sqlResult) {
    if (sqlResult.facts.readyAnswer === true) {
      logAiTrace(traceId, 'final_answer', {
        durationMs: Date.now() - totalStartedAt,
        source: 'offline',
        text: sqlResult.localDraftBangla,
        skippedCompose: true,
      });
      return {
        text: sqlResult.localDraftBangla,
        source: 'offline',
        plan: sqlResult.plan,
        result: sqlResult,
      };
    }
    const onlineText = await composeOnlineAnswer(gatewayUrls, user, question, sqlResult, true, traceId);
    logAiTrace(traceId, 'final_answer', {
      durationMs: Date.now() - totalStartedAt,
      source: onlineText ? 'online' : 'offline',
      text: onlineText ?? sqlResult.localDraftBangla,
    });
    return {
      text: onlineText ?? sqlResult.localDraftBangla,
      source: onlineText ? 'online' : 'offline',
      plan: sqlResult.plan,
      result: sqlResult,
    };
  }

  const planStartedAt = Date.now();
  const plan = localPlanFromQuestion(question, user);
  logAiTrace(traceId, 'planner_prepared', {
    durationMs: Date.now() - planStartedAt,
    plan,
  });

  const queryStartedAt = Date.now();
  const result = await executeQueryPlan(user, plan);
  logAiTrace(traceId, 'local_query_result', {
    durationMs: Date.now() - queryStartedAt,
    metric: result.metric,
    plan: result.plan,
    facts: result.facts,
    rowCount: result.rows.length,
    sampleRows: result.rows.slice(0, 5),
    localDraftBangla: result.localDraftBangla,
  });

  const onlineText = await composeOnlineAnswer(gatewayUrls, user, question, result, false, traceId);
  logAiTrace(traceId, 'final_answer', {
    durationMs: Date.now() - totalStartedAt,
    source: onlineText ? 'online' : 'offline',
    text: onlineText ?? result.localDraftBangla,
  });

  return {
    text: onlineText ?? result.localDraftBangla,
    source: onlineText ? 'online' : 'offline',
    plan,
    result,
  };
}

async function getOnlinePlan(gatewayUrls: string[], user: Staff, question: string) {
  for (const gatewayUrl of gatewayUrls) {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    try {
      const controller = new AbortController();
      timeout = setTimeout(() => controller.abort(), DEMO_ONLINE_PLAN_TIMEOUT_MS);
      const response = await fetch(`${gatewayUrl}/api/ai/plan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question,
          staff: { id: user.id, name: user.name, role: user.role, branch_id: user.branch_id },
          schema: schemaPrompt(user.role),
        }),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      timeout = null;
      if (!response.ok) throw new Error(`Plan failed ${response.status}`);
      const json = await response.json();
      if (!json.plan) throw new Error('No plan');
      return sanitizeQueryPlan(json.plan, user.role);
    } catch {
      continue;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  return null;
}

async function composeOnlineAnswer(
  gatewayUrls: string[],
  user: Staff,
  question: string,
  result: QueryResult,
  usedOnlinePlan: boolean,
  traceId: string,
  options: { includeSuggestedAnswer?: boolean; strictLlmSqlMode?: boolean } = {},
) {
  for (const gatewayUrl of gatewayUrls) {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const startedAt = Date.now();
    const payload: Record<string, unknown> = {
      traceId,
      question,
      staff: { id: user.id, name: user.name, role: user.role, branch_id: user.branch_id },
      plan: result.plan,
      facts: result.facts,
      rows: result.rows,
      usedOnlinePlan,
      strictLlmSqlMode: Boolean(options.strictLlmSqlMode),
    };
    if (options.includeSuggestedAnswer !== false) {
      payload.suggestedBanglaAnswer = result.localDraftBangla;
    }
    try {
      const controller = new AbortController();
      timeout = setTimeout(() => controller.abort(), DEMO_COMPOSE_TIMEOUT_MS);
      logAiTrace(traceId, 'llm_gateway_request_prepared', {
        gatewayUrl,
        payload,
      });
      const response = await fetch(`${gatewayUrl}/api/ai/compose`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      timeout = null;
      if (!response.ok) throw new Error(`Compose failed ${response.status}`);
      const json = await response.json();
      logAiTrace(traceId, 'llm_gateway_response', {
        gatewayUrl,
        durationMs: Date.now() - startedAt,
        response: json,
      });
      if (!json.text || json.source === 'fallback') throw new Error(json.error ?? 'Compose fallback');
      return String(json.text);
    } catch (error) {
      logAiTrace(traceId, 'llm_gateway_error', {
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

export function fallbackPlan() {
  return defaultQueryPlan;
}

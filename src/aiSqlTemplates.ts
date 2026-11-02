import type { CanonicalIntent } from './aiIntentEngine';
import type { SqlQueryPlan } from './aiSqlEngine';
import { Staff } from './types';

export function buildSqlPlanFromIntent(intent: CanonicalIntent, user: Staff): SqlQueryPlan | null {
  if (intent.confidence < 0.55 || intent.intent === 'unsupported') return null;

  const scope = user.role === 'BM' ? `branch_id = ${Number(user.branch_id)}` : `cdo_id = ${Number(user.id)}`;

  if (intent.intent === 'collection_completed_members_today') {
    return {
      sql: `SELECT DISTINCT member_name, vo_name, product_type, amount FROM ai_transactions WHERE ${scope} AND transaction_date = date("now") ORDER BY member_name LIMIT 20`,
      reasoning: `Intent template: ${intent.intent}`,
      answerFocus: 'member_name, vo_name, product_type, amount',
    };
  }

  if (intent.intent === 'collection_completed_today') {
    return {
      sql: `SELECT COUNT(*) AS collected_transactions, COUNT(DISTINCT member_id) AS collected_members, SUM(amount) AS collected_amount FROM ai_transactions WHERE ${scope} AND transaction_date = date("now") LIMIT 1`,
      reasoning: `Intent template: ${intent.intent}`,
      answerFocus: 'collected_transactions, collected_members, collected_amount',
    };
  }

  if (intent.intent === 'collection_pending_members_today') {
    return {
      sql: `SELECT member_name, vo_name, product_name, pending_amount FROM ai_due_schedules WHERE ${scope} AND schedule_status != "PAID" AND due_date <= date("now") ORDER BY pending_amount DESC LIMIT 20`,
      reasoning: `Intent template: ${intent.intent}`,
      answerFocus: 'member_name, vo_name, product_name, pending_amount',
    };
  }

  if (intent.intent === 'collection_pending_today') {
    return {
      sql: `SELECT COUNT(*) AS pending_installments, COUNT(DISTINCT member_id) AS pending_members, SUM(pending_amount) AS pending_amount FROM ai_due_schedules WHERE ${scope} AND schedule_status != "PAID" AND due_date <= date("now") LIMIT 1`,
      reasoning: `Intent template: ${intent.intent}`,
      answerFocus: 'pending_installments, pending_members, pending_amount',
    };
  }

  return null;
}

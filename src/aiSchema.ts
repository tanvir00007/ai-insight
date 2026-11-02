import { Role } from './types';

export type QueryMetric =
  | 'portfolio_summary'
  | 'overdue_members'
  | 'recent_members'
  | 'recent_disbursements'
  | 'collection_history'
  | 'savings_summary'
  | 'vo_priority'
  | 'cdo_ranking'
  | 'cdo_overdue_comparison'
  | 'disbursement_candidates'
  | 'member_search'
  | 'collections_due';

export type QueryPlan = {
  metric: QueryMetric;
  answer_type:
    | 'summary'
    | 'count'
    | 'count_with_examples'
    | 'ranked_list'
    | 'advice'
    | 'member_detail';
  scope: 'current_user' | 'branch';
  timeframe_days?: number;
  group_by?: 'vo' | 'cdo' | 'member' | 'product' | 'none';
  mentioned_member?: string | null;
  limit?: number;
  needs_advice?: boolean;
  reasoning?: string;
};

export const allowedMetrics: QueryMetric[] = [
  'portfolio_summary',
  'overdue_members',
  'recent_members',
  'recent_disbursements',
  'collection_history',
  'savings_summary',
  'vo_priority',
  'cdo_ranking',
  'cdo_overdue_comparison',
  'disbursement_candidates',
  'member_search',
  'collections_due',
];

export const defaultQueryPlan: QueryPlan = {
  metric: 'portfolio_summary',
  answer_type: 'summary',
  scope: 'current_user',
  timeframe_days: 60,
  group_by: 'none',
  mentioned_member: null,
  limit: 10,
  needs_advice: true,
};

export const businessDictionary = {
  portfolio_summary: {
    meaning: 'Overall member, VO, due, overdue, collection, savings, DPS and loan health summary.',
    terms: ['summary', 'portfolio', 'obostha', 'status', 'সারাংশ', 'অবস্থা', 'পোর্টফোলিও'],
  },
  overdue_members: {
    meaning: 'Members with unpaid loan schedules before today, sorted by overdue days and amount.',
    terms: ['risk', 'risky', 'overdue', 'late', 'nibl', 'bokea', 'ঝুঁকি', 'বকেয়া', 'দেরি'],
  },
  recent_disbursements: {
    meaning: 'Members who received new loan disbursement in a recent time period.',
    terms: ['new disbursement', 'notun loan', 'notun rin', 'kotojon loan', 'নতুন ঋণ', 'ঋণ বিতরণ কতজন'],
  },
  recent_members: {
    meaning: 'Members newly admitted or enrolled in a recent time period using members.joined_at.',
    terms: ['new member', 'notun member', 'new client', 'notun client', 'ভর্তি', 'নতুন সদস্য', 'নতুন ক্লায়েন্ট'],
  },
  collection_history: {
    meaning: 'Collections posted in transactions over a time period, including loan installment, savings and DPS deposits.',
    terms: ['last week collection', 'collection hoyeche', 'kotogula collection', 'koto taka collect', 'গত সপ্তাহ আদায়', 'আদায় হয়েছে'],
  },
  savings_summary: {
    meaning: 'Savings and DPS balance, weak VO, low-savings members and weekly savings target.',
    terms: ['savings', 'dps', 'deposit', 'sonchoy', 'sanchay', 'সঞ্চয়', 'জমা', 'ডিপিএস'],
  },
  vo_priority: {
    meaning: 'Which VO to visit or focus first based on due, overdue and member count.',
    terms: ['which vo', 'vo first', 'kothay focus', 'age jabo', 'কোন VO', 'আগে যাব', 'ফোকাস'],
  },
  cdo_ranking: {
    meaning: 'CDO performance comparison for BM or peer competition.',
    terms: ['rank', 'ranking', 'performance', 'compare', 'top cdo', 'র‍্যাংক', 'পারফরম্যান্স'],
  },
  cdo_overdue_comparison: {
    meaning: 'Compare CDOs by overdue amount, overdue member count and risky loan accounts.',
    terms: ['cdo overdue', 'cdo der moddhe', 'which cdo overdue', 'kar overdue beshi', 'whose overdue is highest', 'kon cdo', 'সিডিও', 'কার overdue বেশি'],
  },
  disbursement_candidates: {
    meaning: 'Potential members for new loan based on Current status, savings and transaction history.',
    terms: ['loan barabo', 'disbursement barabo', 'rin barabo', 'ঋণ বাড়াব', 'লোন বাড়াব'],
  },
  member_search: {
    meaning: 'Find a named member and summarize profile, risk, overdue and product behavior.',
    terms: ['member', 'client', 'profile', 'behavior', 'সদস্য', 'প্রোফাইল', 'আচরণ'],
  },
  collections_due: {
    meaning: 'Today due collection target and pending collections.',
    terms: ['collection', 'kisti', 'due today', 'target', 'আদায়', 'কিস্তি', 'লক্ষ্যমাত্রা'],
  },
};

export function schemaPrompt(role: Role) {
  return {
    role,
    instruction:
      'Return only JSON matching QueryPlan. Choose one metric from allowedMetrics. Do not write SQL. The mobile app will execute safe local queries.',
    allowedMetrics,
    defaultScope: role === 'BM' ? 'branch or current_user' : 'current_user only',
    businessDictionary,
    queryPlanShape: {
      metric: 'one allowed metric',
      answer_type: 'summary | count | count_with_examples | ranked_list | advice | member_detail',
      scope: 'current_user | branch',
      timeframe_days: 'optional number, default 60 for recent questions',
      group_by: 'vo | cdo | member | product | none',
      mentioned_member: 'optional member name found in question',
      limit: 'optional number, max 20',
      needs_advice: 'boolean',
      reasoning: 'short English reason',
    },
  };
}

export function sanitizeQueryPlan(input: Partial<QueryPlan> | null | undefined, role: Role): QueryPlan {
  const metric = input?.metric && allowedMetrics.includes(input.metric) ? input.metric : defaultQueryPlan.metric;
  const rawLimit = Number(input?.limit ?? defaultQueryPlan.limit);
  const rawDays = Number(input?.timeframe_days ?? defaultQueryPlan.timeframe_days);

  return {
    metric,
    answer_type: input?.answer_type ?? defaultQueryPlan.answer_type,
    scope:
      role === 'CDO' && metric !== 'cdo_ranking' && metric !== 'cdo_overdue_comparison'
        ? 'current_user'
        : input?.scope === 'branch' || metric === 'cdo_ranking' || metric === 'cdo_overdue_comparison'
          ? 'branch'
          : 'current_user',
    timeframe_days: Number.isFinite(rawDays) ? Math.min(Math.max(Math.round(rawDays), 1), 365) : 60,
    group_by: input?.group_by ?? 'none',
    mentioned_member: input?.mentioned_member ?? null,
    limit: Number.isFinite(rawLimit) ? Math.min(Math.max(Math.round(rawLimit), 1), 20) : 10,
    needs_advice: input?.needs_advice ?? true,
    reasoning: input?.reasoning ?? 'sanitized plan',
  };
}

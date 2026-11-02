import { getBranchSummary, getCdoSummary, getDb } from './db';
import { QueryPlan, sanitizeQueryPlan } from './aiSchema';
import { Staff } from './types';

export type QueryResult = {
  metric: QueryPlan['metric'];
  plan: QueryPlan;
  facts: Record<string, unknown>;
  rows: Record<string, unknown>[];
  localDraftBangla: string;
};

type Scope = {
  where: string;
  params: number[];
  label: string;
};

export function localPlanFromQuestion(question: string, user: Staff): QueryPlan {
  const text = question.toLowerCase();
  const mentioned = extractLikelyMemberName(question);
  const plan: Partial<QueryPlan> = {
    scope: user.role === 'BM' && /branch|শাখা|sob|all/i.test(question) ? 'branch' : 'current_user',
    limit: 10,
    timeframe_days: /month|mas|মাস|1/.test(text) ? 30 : 60,
    mentioned_member: mentioned,
    needs_advice: true,
  };

  if (isCdoOverdueComparisonQuestion(text)) {
    return sanitizeQueryPlan({ ...plan, metric: 'cdo_overdue_comparison', answer_type: 'ranked_list', scope: 'branch', group_by: 'cdo' }, user.role);
  }
  if (isOverdueMemberListQuestion(text)) {
    return sanitizeQueryPlan({ ...plan, metric: 'overdue_members', answer_type: 'ranked_list' }, user.role);
  }
  if (isTodayCollectionRemainingQuestion(text)) {
    return sanitizeQueryPlan({ ...plan, metric: 'collections_due', answer_type: 'summary', timeframe_days: 1 }, user.role);
  }
  if (isTodayCollectionHistoryQuestion(text)) {
    return sanitizeQueryPlan({ ...plan, metric: 'collection_history', answer_type: 'summary', timeframe_days: 1, group_by: 'product' }, user.role);
  }

  if (/notun\s+(member|client)|new\s+(member|client)|নতুন\s+(সদস্য|ক্লায়েন্ট|ক্লায়েন্ট)|ভর্তি/.test(text)) {
    return sanitizeQueryPlan({ ...plan, metric: 'recent_members', answer_type: 'count_with_examples' }, user.role);
  }
  if (/notun|new|recent|disbursed|disbursement koto|kotojon|কতজন|নতুন/.test(text)) {
    if (/member|client|সদস্য|ভর্তি|admit|enroll/.test(text) && !/loan|rin|ঋণ|disburse|disbursement/.test(text)) {
      return sanitizeQueryPlan({ ...plan, metric: 'recent_members', answer_type: 'count_with_examples' }, user.role);
    }
    return sanitizeQueryPlan({ ...plan, metric: 'recent_disbursements', answer_type: 'count_with_examples' }, user.role);
  }
  if (/aj|ajker|today|aaj|আজ|আজকে/.test(text) && /collection|collect|adaya|aday|holo|hoilo|hoyeche|hoyeache|আদায়|আদায়/.test(text)) {
    return sanitizeQueryPlan({ ...plan, metric: 'collection_history', answer_type: 'summary', timeframe_days: 1, group_by: 'product' }, user.role);
  }
  if (/last\s*1\s*week|last week|7 din|7 days|week|সপ্তাহ/.test(text) && /collection|collect|adaya|aday|আদায়|আদায়/.test(text)) {
    return sanitizeQueryPlan({ ...plan, metric: 'collection_history', answer_type: 'summary', timeframe_days: 7, group_by: 'product' }, user.role);
  }
  if (/collection hoy|collection hol|collection holo|collection hoilo|collection hoise|collection hoyeache|collection hoyeche|kotogula collection|koyta collection|কত.*আদায়|আদায় হয়েছে/.test(text)) {
    return sanitizeQueryPlan({ ...plan, metric: 'collection_history', answer_type: 'summary', timeframe_days: plan.timeframe_days ?? 7, group_by: 'product' }, user.role);
  }
  if (/saving|savings|dps|deposit|sonchoy|sanchay|সঞ্চয়|জমা|ডিপিএস/.test(text)) {
    return sanitizeQueryPlan({ ...plan, metric: 'savings_summary', answer_type: 'advice', group_by: 'vo' }, user.role);
  }
  if (/(cdo|সিডিও|officer|field officer|কর্মী)/.test(text) && /(overdue|bokea|bokeya|risk|risky|late|beshi|highest|kar|কার|কোন|সবচেয়ে|সবচেয়ে|top)/.test(text)) {
    return sanitizeQueryPlan({ ...plan, metric: 'cdo_overdue_comparison', answer_type: 'ranked_list', scope: 'branch', group_by: 'cdo' }, user.role);
  }
  if (/rank|ranking|performance|compare|top cdo|র‍্যাংক|পারফরম্যান্স/.test(text)) {
    return sanitizeQueryPlan({ ...plan, metric: 'cdo_ranking', answer_type: 'ranked_list', group_by: 'cdo' }, user.role);
  }
  if (/which vo|vo first|age jabo|focus|কোন vo|আগে যাব|ফোকাস/.test(text)) {
    return sanitizeQueryPlan({ ...plan, metric: 'vo_priority', answer_type: 'ranked_list', group_by: 'vo' }, user.role);
  }
  if (/loan barabo|disbursement barabo|rin barabo|ঋণ বাড়|লোন বাড়/.test(text)) {
    return sanitizeQueryPlan({ ...plan, metric: 'disbursement_candidates', answer_type: 'advice' }, user.role);
  }
  if (/risk|risky|overdue|late|nibl|bokea|ঝুঁকি|বকেয়া/.test(text)) {
    return sanitizeQueryPlan({ ...plan, metric: 'overdue_members', answer_type: 'ranked_list' }, user.role);
  }
  if (mentioned || /member|client|profile|behavior|সদস্য|প্রোফাইল/.test(text)) {
    return sanitizeQueryPlan({ ...plan, metric: 'member_search', answer_type: 'member_detail' }, user.role);
  }
  if (/collection|kisti|due|target|আদায়|কিস্তি|লক্ষ্যমাত্রা/.test(text)) {
    return sanitizeQueryPlan({ ...plan, metric: 'collections_due', answer_type: 'summary' }, user.role);
  }

  return sanitizeQueryPlan({ ...plan, metric: 'portfolio_summary', answer_type: 'summary' }, user.role);
}

export async function executeQueryPlan(user: Staff, rawPlan: QueryPlan): Promise<QueryResult> {
  const plan = sanitizeQueryPlan(rawPlan, user.role);
  const scope = getScope(user, plan);

  if (plan.metric === 'portfolio_summary') return executePortfolioSummary(user, plan);
  if (plan.metric === 'overdue_members') return executeOverdueMembers(plan, scope);
  if (plan.metric === 'recent_members') return executeRecentMembers(plan, scope);
  if (plan.metric === 'recent_disbursements') return executeRecentDisbursements(plan, scope);
  if (plan.metric === 'collection_history') return executeCollectionHistory(plan, scope);
  if (plan.metric === 'savings_summary') return executeSavingsSummary(plan, scope);
  if (plan.metric === 'vo_priority') return executeVoPriority(plan, scope);
  if (plan.metric === 'cdo_ranking') return executeCdoRanking(user, plan);
  if (plan.metric === 'cdo_overdue_comparison') return executeCdoOverdueComparison(user, plan);
  if (plan.metric === 'disbursement_candidates') return executeDisbursementCandidates(plan, scope);
  if (plan.metric === 'member_search') return executeMemberSearch(plan, scope);
  return executeCollectionsDue(user, plan, scope);
}

function getScope(user: Staff, plan: QueryPlan): Scope {
  if (user.role === 'BM' && plan.scope === 'branch') {
    return { where: 'vo.branch_id = ?', params: [user.branch_id], label: 'শাখায়' };
  }
  return user.role === 'BM'
    ? { where: 'vo.branch_id = ?', params: [user.branch_id], label: 'শাখায়' }
    : { where: 'vo.cdo_id = ?', params: [user.id], label: 'আপনার পোর্টফোলিওতে' };
}

async function executePortfolioSummary(user: Staff, plan: QueryPlan): Promise<QueryResult> {
  const summary = user.role === 'BM' && plan.scope === 'branch'
    ? await getBranchSummary(user.branch_id)
    : await getCdoSummary(user.id);
  const draft = `${user.role === 'BM' ? 'আপনার শাখায়' : 'আপনার পোর্টফোলিওতে'} ${summary.members} জন সদস্য ও ${summary.vos}টি VO আছে। আজ আদায়যোগ্য ${money(summary.target)}, আদায় হয়েছে ${money(summary.collected)}, overdue ${money(summary.overdue)}।`;
  return { metric: plan.metric, plan, facts: summary as unknown as Record<string, unknown>, rows: [], localDraftBangla: draft };
}

async function executeOverdueMembers(plan: QueryPlan, scope: Scope): Promise<QueryResult> {
  const db = await getDb();
  const rows = await db.getAllAsync<Record<string, unknown>>(
    `SELECT
       m.id AS member_id,
       m.name AS member_name,
       vo.name AS vo_name,
       SUM(ls.due_amount - ls.paid_amount) AS overdue_amount,
       CAST(julianday(date('now')) - julianday(MIN(ls.due_date)) AS INTEGER) AS overdue_days
     FROM loan_schedules ls
     JOIN loan_accounts la ON la.id = ls.loan_id
     JOIN members m ON m.id = la.member_id
     JOIN village_organizations vo ON vo.id = m.vo_id
     WHERE ${scope.where}
       AND ls.status != 'PAID'
       AND ls.due_date < date('now')
     GROUP BY m.id, vo.id
     ORDER BY overdue_days DESC, overdue_amount DESC
     LIMIT ?`,
    [...scope.params, plan.limit ?? 10],
  );
  const top = rows[0];
  const draft = top
    ? `${scope.label} ${rows.length} জন ঝুঁকিপূর্ণ সদস্য পাওয়া গেছে। সবচেয়ে ঝুঁকিপূর্ণ ${top.member_name}, ${top.vo_name}; overdue ${money(Number(top.overdue_amount))}, বকেয়া ${top.overdue_days} দিনের।`
    : `${scope.label} এই মুহূর্তে overdue সদস্য পাওয়া যায়নি।`;
  return { metric: plan.metric, plan, facts: { count: rows.length }, rows, localDraftBangla: draft };
}

async function executeRecentDisbursements(plan: QueryPlan, scope: Scope): Promise<QueryResult> {
  const db = await getDb();
  const days = plan.timeframe_days ?? 60;
  const rows = await db.getAllAsync<Record<string, unknown>>(
    `SELECT
       m.id AS member_id,
       m.name AS member_name,
       vo.name AS vo_name,
       la.product_name,
       la.principal_amount,
       la.disbursed_at
     FROM loan_accounts la
     JOIN members m ON m.id = la.member_id
     JOIN village_organizations vo ON vo.id = m.vo_id
     WHERE ${scope.where}
       AND date(la.disbursed_at) >= date('now', ?)
     ORDER BY la.disbursed_at DESC, la.principal_amount DESC
     LIMIT ?`,
    [...scope.params, `-${days} day`, plan.limit ?? 10],
  );
  const memberCount = new Set(rows.map((row) => row.member_id)).size;
  const totalAmount = rows.reduce((sum, row) => sum + Number(row.principal_amount ?? 0), 0);
  const examples = rows.slice(0, 3).map((row) => `${row.member_name} (${row.vo_name})`).join(', ');
  const draft = rows.length > 0
    ? `গত ${days} দিনে ${scope.label} ${memberCount} জন সদস্যের ${rows.length}টি নতুন ঋণ বিতরণ হয়েছে। মোট বিতরণ ${money(totalAmount)}। উদাহরণ: ${examples}।`
    : `গত ${days} দিনে ${scope.label} কোনো নতুন ঋণ বিতরণ পাওয়া যায়নি।`;
  return { metric: plan.metric, plan, facts: { memberCount, loanCount: rows.length, totalAmount, days }, rows, localDraftBangla: draft };
}

async function executeRecentMembers(plan: QueryPlan, scope: Scope): Promise<QueryResult> {
  const db = await getDb();
  const days = plan.timeframe_days ?? 60;
  const rows = await db.getAllAsync<Record<string, unknown>>(
    `SELECT
       m.id AS member_id,
       m.name AS member_name,
       m.member_code,
       m.phone,
       m.joined_at,
       vo.name AS vo_name
     FROM members m
     JOIN village_organizations vo ON vo.id = m.vo_id
     WHERE ${scope.where}
       AND date(m.joined_at) >= date('now', ?)
     ORDER BY m.joined_at DESC, m.id DESC
     LIMIT ?`,
    [...scope.params, `-${days} day`, plan.limit ?? 10],
  );
  const draft = rows.length > 0
    ? `গত ${days} দিনে ${scope.label} ${rows.length} জন নতুন সদস্য ভর্তি হয়েছে। সাম্প্রতিক উদাহরণ: ${rows
        .slice(0, 3)
        .map((row) => `${row.member_name} (${row.vo_name})`)
        .join(', ')}।`
    : `গত ${days} দিনে ${scope.label} কোনো নতুন সদস্য ভর্তি পাওয়া যায়নি।`;
  return { metric: plan.metric, plan, facts: { memberCount: rows.length, days }, rows, localDraftBangla: draft };
}

async function executeCollectionHistory(plan: QueryPlan, scope: Scope): Promise<QueryResult> {
  const db = await getDb();
  const days = plan.timeframe_days ?? 7;
  const dateFilter = days <= 1 ? "date(t.transaction_date) = date('now')" : "date(t.transaction_date) >= date('now', ?)";
  const dateParams = days <= 1 ? [] : [`-${days} day`];
  const rows = await db.getAllAsync<Record<string, unknown>>(
    `SELECT
       t.product_type,
       t.transaction_type,
       COUNT(*) AS transaction_count,
       COUNT(DISTINCT t.member_id) AS member_count,
       SUM(t.amount) AS total_amount
     FROM transactions t
     JOIN village_organizations vo ON vo.id = t.vo_id
     WHERE ${scope.where}
       AND ${dateFilter}
     GROUP BY t.product_type, t.transaction_type
     ORDER BY total_amount DESC
     LIMIT ?`,
    [...scope.params, ...dateParams, plan.limit ?? 10],
  );
  const totalTransactions = rows.reduce((sum, row) => sum + Number(row.transaction_count ?? 0), 0);
  const totalMembers = rows.reduce((sum, row) => sum + Number(row.member_count ?? 0), 0);
  const totalAmount = rows.reduce((sum, row) => sum + Number(row.total_amount ?? 0), 0);
  const loanAmount = rows
    .filter((row) => row.product_type === 'LOAN')
    .reduce((sum, row) => sum + Number(row.total_amount ?? 0), 0);
  const savingsAmount = rows
    .filter((row) => row.product_type === 'SAVINGS' || row.product_type === 'DPS')
    .reduce((sum, row) => sum + Number(row.total_amount ?? 0), 0);
  const period = days <= 1 ? 'আজ' : `গত ${days} দিনে`;
  const draft = totalTransactions > 0
    ? `${period} ${scope.label} ${totalTransactions}টি collection transaction হয়েছে। মোট আদায় ${money(totalAmount)}; loan collection ${money(loanAmount)}, savings/DPS ${money(savingsAmount)}।`
    : `${period} ${scope.label} কোনো collection transaction পাওয়া যায়নি।`;
  return {
    metric: plan.metric,
    plan,
    facts: { days, totalTransactions, totalMembers, totalAmount, loanAmount, savingsAmount },
    rows,
    localDraftBangla: draft,
  };
}

async function executeSavingsSummary(plan: QueryPlan, scope: Scope): Promise<QueryResult> {
  const db = await getDb();
  const facts = await db.getFirstAsync<Record<string, unknown>>(
    `SELECT
       COALESCE(SUM(sa.balance), 0) AS total_savings,
       COALESCE(SUM(da.balance), 0) AS total_dps,
       COALESCE(SUM(sa.weekly_target), 0) AS weekly_target,
       COUNT(DISTINCT m.id) AS members,
       COUNT(DISTINCT CASE WHEN sa.balance < 1500 THEN m.id END) AS low_savings_members
     FROM members m
     JOIN village_organizations vo ON vo.id = m.vo_id
     LEFT JOIN savings_accounts sa ON sa.member_id = m.id
     LEFT JOIN dps_accounts da ON da.member_id = m.id
     WHERE ${scope.where}`,
    scope.params,
  );
  const rows = await db.getAllAsync<Record<string, unknown>>(
    `SELECT vo.name AS vo_name, COALESCE(SUM(sa.balance), 0) AS savings
     FROM village_organizations vo
     LEFT JOIN members m ON m.vo_id = vo.id
     LEFT JOIN savings_accounts sa ON sa.member_id = m.id
     WHERE ${scope.where}
     GROUP BY vo.id
     ORDER BY savings ASC
     LIMIT ?`,
    [...scope.params, plan.limit ?? 10],
  );
  const weakVo = rows[0];
  const draft = `${scope.label} মোট সঞ্চয় ${money(Number(facts?.total_savings ?? 0))}, DPS ${money(Number(facts?.total_dps ?? 0))}। কম সঞ্চয় আছে ${facts?.low_savings_members ?? 0} জন সদস্যের। সবচেয়ে দুর্বল VO: ${weakVo?.vo_name ?? 'N/A'}।`;
  return { metric: plan.metric, plan, facts: facts ?? {}, rows, localDraftBangla: draft };
}

async function executeVoPriority(plan: QueryPlan, scope: Scope): Promise<QueryResult> {
  const db = await getDb();
  const rows = await db.getAllAsync<Record<string, unknown>>(
    `SELECT
       vo.id AS vo_id,
       vo.name AS vo_name,
       vo.meeting_day,
       vo.meeting_time,
       COUNT(DISTINCT m.id) AS members,
       COALESCE(SUM(CASE WHEN ls.status != 'PAID' AND ls.due_date <= date('now')
         THEN ls.due_amount - ls.paid_amount ELSE 0 END), 0) AS due_amount,
       COALESCE(SUM(CASE WHEN ls.status != 'PAID' AND ls.due_date < date('now')
         THEN ls.due_amount - ls.paid_amount ELSE 0 END), 0) AS overdue_amount
     FROM village_organizations vo
     LEFT JOIN members m ON m.vo_id = vo.id
     LEFT JOIN loan_accounts la ON la.member_id = m.id
     LEFT JOIN loan_schedules ls ON ls.loan_id = la.id
     WHERE ${scope.where}
     GROUP BY vo.id
     ORDER BY overdue_amount DESC, due_amount DESC
     LIMIT ?`,
    [...scope.params, plan.limit ?? 10],
  );
  const top = rows[0];
  const draft = top
    ? `আজ আগে ${top.vo_name} ফোকাস করুন। এখানে overdue ${money(Number(top.overdue_amount))}, due ${money(Number(top.due_amount))}, সদস্য ${top.members} জন।`
    : 'VO অগ্রাধিকার বের করার মতো তথ্য পাওয়া যায়নি।';
  return { metric: plan.metric, plan, facts: { count: rows.length }, rows, localDraftBangla: draft };
}

async function executeCdoRanking(user: Staff, plan: QueryPlan): Promise<QueryResult> {
  const db = await getDb();
  const rows = await db.getAllAsync<Record<string, unknown>>(
    `SELECT
       s.id AS cdo_id,
       s.name AS cdo_name,
       s.staff_code,
       COALESCE(SUM(CASE WHEN ls.status != 'PAID' AND ls.due_date <= date('now') THEN ls.due_amount - ls.paid_amount ELSE 0 END), 0) AS target,
       COALESCE(SUM(CASE WHEN ls.status != 'PAID' AND ls.due_date < date('now') THEN ls.due_amount - ls.paid_amount ELSE 0 END), 0) AS overdue
     FROM staff s
     LEFT JOIN village_organizations vo ON vo.cdo_id = s.id
     LEFT JOIN members m ON m.vo_id = vo.id
     LEFT JOIN loan_accounts la ON la.member_id = m.id
     LEFT JOIN loan_schedules ls ON ls.loan_id = la.id
     WHERE s.role = 'CDO'
       AND s.branch_id = ?
     GROUP BY s.id
     ORDER BY overdue ASC, target DESC
     LIMIT ?`,
    [user.branch_id, plan.limit ?? 10],
  );
  const top = rows[0];
  const draft = top
    ? `বর্তমানে ${top.cdo_name} সবচেয়ে ভালো অবস্থানে আছে; তার overdue ${money(Number(top.overdue))}। তুলনার জন্য ranking তালিকা দেখুন।`
    : 'CDO ranking বের করার মতো তথ্য পাওয়া যায়নি।';
  return { metric: plan.metric, plan, facts: { count: rows.length }, rows, localDraftBangla: draft };
}

async function executeCdoOverdueComparison(user: Staff, plan: QueryPlan): Promise<QueryResult> {
  const db = await getDb();
  const rows = await db.getAllAsync<Record<string, unknown>>(
    `SELECT
       s.id AS cdo_id,
       s.name AS cdo_name,
       s.staff_code,
       COUNT(DISTINCT m.id) AS member_count,
       COUNT(DISTINCT CASE WHEN ls.status != 'PAID' AND ls.due_date < date('now') THEN m.id END) AS overdue_members,
       COALESCE(SUM(CASE WHEN ls.status != 'PAID' AND ls.due_date < date('now') THEN ls.due_amount - ls.paid_amount ELSE 0 END), 0) AS overdue_amount,
       COUNT(DISTINCT CASE WHEN la.status IN ('Late 2', 'NIBL 1', 'NIBL 2') THEN la.id END) AS risk_accounts
     FROM staff s
     LEFT JOIN village_organizations vo ON vo.cdo_id = s.id
     LEFT JOIN members m ON m.vo_id = vo.id
     LEFT JOIN loan_accounts la ON la.member_id = m.id
     LEFT JOIN loan_schedules ls ON ls.loan_id = la.id
     WHERE s.role = 'CDO'
       AND s.branch_id = ?
     GROUP BY s.id
     ORDER BY overdue_amount DESC, overdue_members DESC, risk_accounts DESC
     LIMIT ?`,
    [user.branch_id, plan.limit ?? 10],
  );
  const top = rows[0];
  const next = rows
    .slice(1, 3)
    .map((row) => `${row.cdo_name}: ${money(Number(row.overdue_amount))}`)
    .join(', ');
  const draft = top
    ? `CDOদের মধ্যে সবচেয়ে বেশি overdue আছে ${top.cdo_name}-এর। মোট overdue ${money(Number(top.overdue_amount))}, overdue সদস্য ${top.overdue_members} জন, ঝুঁকিপূর্ণ loan account ${top.risk_accounts}টি।${next ? ` এরপর আছে ${next}।` : ''}`
    : 'এই শাখায় CDO অনুযায়ী overdue তুলনা করার মতো তথ্য পাওয়া যায়নি।';
  return {
    metric: plan.metric,
    plan,
    facts: { count: rows.length, topCdo: top ?? null, branchId: user.branch_id },
    rows,
    localDraftBangla: draft,
  };
}

async function executeDisbursementCandidates(plan: QueryPlan, scope: Scope): Promise<QueryResult> {
  const db = await getDb();
  const rows = await db.getAllAsync<Record<string, unknown>>(
    `SELECT
       m.id AS member_id,
       m.name AS member_name,
       vo.name AS vo_name,
       COALESCE(sa.balance, 0) AS savings_balance,
       COUNT(DISTINCT la.id) AS active_loans,
       COALESCE(SUM(la.outstanding_amount), 0) AS outstanding_amount
     FROM members m
     JOIN village_organizations vo ON vo.id = m.vo_id
     LEFT JOIN savings_accounts sa ON sa.member_id = m.id
     LEFT JOIN loan_accounts la ON la.member_id = m.id AND la.outstanding_amount > 0
     WHERE ${scope.where}
       AND NOT EXISTS (
         SELECT 1 FROM loan_accounts risky
         WHERE risky.member_id = m.id
           AND risky.status IN ('Late 1', 'Late 2', 'NIBL 1', 'NIBL 2')
       )
     GROUP BY m.id, vo.id
     HAVING savings_balance >= 1500
     ORDER BY savings_balance DESC, outstanding_amount ASC
     LIMIT ?`,
    [...scope.params, plan.limit ?? 10],
  );
  const top = rows[0];
  const draft = top
    ? `ঋণ বিতরণের জন্য ${rows.length} জন সম্ভাব্য সদস্য পাওয়া গেছে। সেরা প্রার্থী ${top.member_name}, ${top.vo_name}; সঞ্চয় ${money(Number(top.savings_balance))}।`
    : 'নতুন ঋণের জন্য স্পষ্ট যোগ্য সদস্য কম দেখা যাচ্ছে। Current status ও ভালো সঞ্চয় আছে এমন সদস্য shortlist করুন।';
  return { metric: plan.metric, plan, facts: { count: rows.length }, rows, localDraftBangla: draft };
}

async function executeMemberSearch(plan: QueryPlan, scope: Scope): Promise<QueryResult> {
  const db = await getDb();
  const name = plan.mentioned_member ?? '';
  const rows = await db.getAllAsync<Record<string, unknown>>(
    `SELECT
       m.id AS member_id,
       m.name AS member_name,
       m.phone,
       m.risk_note,
       vo.name AS vo_name,
       COALESCE(SUM(la.outstanding_amount), 0) AS outstanding_amount,
       COALESCE(SUM(CASE WHEN ls.status != 'PAID' AND ls.due_date < date('now') THEN ls.due_amount - ls.paid_amount ELSE 0 END), 0) AS overdue_amount
     FROM members m
     JOIN village_organizations vo ON vo.id = m.vo_id
     LEFT JOIN loan_accounts la ON la.member_id = m.id
     LEFT JOIN loan_schedules ls ON ls.loan_id = la.id
     WHERE ${scope.where}
       AND (? = '' OR LOWER(m.name) LIKE LOWER(?))
     GROUP BY m.id, vo.id
     ORDER BY overdue_amount DESC
     LIMIT ?`,
    [...scope.params, name, `%${name}%`, plan.limit ?? 10],
  );
  const top = rows[0];
  const draft = top
    ? `${top.member_name}, ${top.vo_name}: outstanding ${money(Number(top.outstanding_amount))}, overdue ${money(Number(top.overdue_amount))}।`
    : 'এই নামে সদস্য পাওয়া যায়নি। নামের বানান একটু সহজ করে লিখলে খুঁজে দেখা যাবে।';
  return { metric: plan.metric, plan, facts: { count: rows.length }, rows, localDraftBangla: draft };
}

async function executeCollectionsDue(user: Staff, plan: QueryPlan, scope: Scope): Promise<QueryResult> {
  const db = await getDb();
  const summary = user.role === 'BM' && plan.scope === 'branch'
    ? await getBranchSummary(user.branch_id)
    : await getCdoSummary(user.id);
  const due = await db.getFirstAsync<Record<string, unknown>>(
    `SELECT
       COUNT(DISTINCT ls.id) AS pending_installments,
       COUNT(DISTINCT m.id) AS pending_members,
       COALESCE(SUM(ls.due_amount - ls.paid_amount), 0) AS pending_amount
     FROM loan_schedules ls
     JOIN loan_accounts la ON la.id = ls.loan_id
     JOIN members m ON m.id = la.member_id
     JOIN village_organizations vo ON vo.id = m.vo_id
     WHERE ${scope.where}
       AND ls.status != 'PAID'
       AND ls.due_date <= date('now')`,
    scope.params,
  );
  const collected = await db.getFirstAsync<Record<string, unknown>>(
    `SELECT
       COUNT(*) AS collection_transactions,
       COUNT(DISTINCT t.member_id) AS collected_members,
       COALESCE(SUM(t.amount), 0) AS collected_amount
     FROM transactions t
     JOIN village_organizations vo ON vo.id = t.vo_id
     WHERE ${scope.where}
       AND date(t.transaction_date) = date('now')`,
    scope.params,
  );
  const pendingAmount = Number(due?.pending_amount ?? Math.max(summary.target - summary.collected, 0));
  const draft = `আজ ${scope.label} ${collected?.collection_transactions ?? 0}টি collection transaction হয়েছে, ${collected?.collected_members ?? 0} জন সদস্য থেকে ${money(Number(collected?.collected_amount ?? summary.collected))} আদায় হয়েছে। এখনো ${due?.pending_installments ?? 0}টি collection বাকি, সদস্য ${due?.pending_members ?? 0} জন, বাকি টাকা ${money(pendingAmount)}। overdue ${money(summary.overdue)}।`;
  return {
    metric: plan.metric,
    plan,
    facts: {
      ...(summary as unknown as Record<string, unknown>),
      pendingInstallments: due?.pending_installments ?? 0,
      pendingMembers: due?.pending_members ?? 0,
      pendingAmount,
      collectionTransactions: collected?.collection_transactions ?? 0,
      collectedMembers: collected?.collected_members ?? 0,
      collectedAmount: collected?.collected_amount ?? summary.collected,
    },
    rows: [],
    localDraftBangla: draft,
  };
}

function extractLikelyMemberName(question: string) {
  const words = question
    .replace(/[^a-zA-Z\u0980-\u09FF\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const stopWords = new Set([
    'member',
    'client',
    'profile',
    'behavior',
    'jodi',
    'taka',
    'dite',
    'dity',
    'chai',
    'ki',
    'korbo',
    'আজ',
    'আজকে',
    'আমার',
    'আর',
    'কয়টা',
    'কয়টা',
    'কতটা',
    'কতগুলো',
    'কালেকশন',
    'আদায়',
    'আদায়',
    'সংগ্রহ',
    'কিস্তি',
    'হল',
    'হলো',
    'হয়েছে',
    'হয়েছে',
    'বাকি',
    'আছে',
    'কার',
    'কারা',
    'কাদের',
    'ওভারডিউ',
    'বকেয়া',
    'বকেয়া',
    'ঝুঁকি',
    'ঝুঁকিপূর্ণ',
  ]);
  const candidate = words.find((word) => word.length >= 4 && !stopWords.has(word.toLowerCase()));
  return candidate ?? null;
}

function isCdoOverdueComparisonQuestion(text: string) {
  return hasAny(text, ['cdo', 'সিডিও', 'কর্মী', 'অফিসার']) && hasAny(text, ['overdue', 'ওভারডিউ', 'বকেয়া', 'বকেয়া', 'ঝুঁকি', 'কার', 'কোন', 'বেশি', 'সবচেয়ে', 'সবচেয়ে']);
}

function isOverdueMemberListQuestion(text: string) {
  return hasAny(text, ['overdue', 'ওভারডিউ', 'বকেয়া', 'বকেয়া', 'ঝুঁকি', 'ঝুঁকিপূর্ণ'])
    && hasAny(text, ['কার', 'কারা', 'কাদের', 'কে', 'তালিকা', 'বাকি', 'আছে', 'সদস্য', 'member']);
}

function isTodayCollectionRemainingQuestion(text: string) {
  return hasAny(text, ['আজ', 'আজকে', 'aj', 'ajker', 'today'])
    && hasAny(text, ['collection', 'কালেকশন', 'আদায়', 'আদায়', 'কিস্তি', 'সংগ্রহ'])
    && hasAny(text, ['বাকি', 'আর', 'কয়টা', 'কয়টা', 'কতটা', 'কতগুলো', 'pending', 'remaining', 'due']);
}

function isTodayCollectionHistoryQuestion(text: string) {
  return hasAny(text, ['আজ', 'আজকে', 'aj', 'ajker', 'today'])
    && hasAny(text, ['collection', 'কালেকশন', 'আদায়', 'আদায়', 'কিস্তি', 'সংগ্রহ'])
    && hasAny(text, ['হল', 'হলো', 'হয়েছে', 'হয়েছে', 'holo', 'hoyeche', 'hoyeache']);
}

function hasAny(text: string, terms: string[]) {
  return terms.some((term) => text.includes(term));
}

function money(value: number) {
  return `৳${Math.round(value || 0).toLocaleString('en-US')}`;
}

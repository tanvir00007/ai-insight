import {
  getBranchSummary,
  getCdoSummary,
  getCdoVos,
  getCdosForBm,
  getDb,
  getMemberPortfolio,
  getVoMembers,
  isoDate,
} from './db';
import { getAiGatewayUrls } from './network';
import { buildOnlineInstruction, ChatIntent, classifyChatIntent, intentTitleBangla } from './aiConversation';
import { answerDynamicQuestion, answerLlmSqlQuestion } from './aiDynamic';
import {
  buildDisbursementAdvice,
  buildNonPaymentAdvice,
  buildRecentDisbursementAnswer,
  buildSavingsAdvice,
  getDisbursementFocusForBranch,
  getDisbursementFocusForCdo,
  getRecentDisbursementForBranch,
  getRecentDisbursementForCdo,
  money,
  translateRankingAdvice,
} from './aiDomain';
import { AiInsight, CdoRanking, ChatMessage, Staff } from './types';

type CompletionRow = { insight_key: string };
type CountRow = { count: number };
type TopRiskRow = {
  member_id: number;
  member_name: string;
  vo_id: number;
  vo_name: string;
  overdue_amount: number;
  overdue_days: number;
};

type MentionedMemberRisk = TopRiskRow & {
  phone: string;
  risk_note: string;
};

type CdoScoreRow = {
  cdo_id: number;
  staff_code: string;
  name: string;
  target: number | null;
  collected: number | null;
  overdue_amount: number | null;
  overdue_members: number | null;
  risk_accounts: number | null;
  savings_balance: number | null;
};

type SavingsFocus = {
  totalSavings: number;
  totalDps: number;
  weeklyTarget: number;
  members: number;
  lowSavingsMembers: number;
  topVoName: string | null;
  topVoSavings: number;
  lowestVoName: string | null;
  lowestVoSavings: number;
};

type DisbursementCandidate = {
  member_id: number;
  member_name: string;
  vo_name: string;
  savings_balance: number;
  active_loans: number;
  outstanding_amount: number;
  recent_transactions: number;
};

type DisbursementFocus = {
  candidates: DisbursementCandidate[];
  currentAccounts: number;
  riskyAccounts: number;
};

const DEMO_CHAT_TIMEOUT_MS = 180000;

export async function getAiInsights(user: Staff): Promise<AiInsight[]> {
  if (user.role === 'BM') return getBmInsights(user);
  return getCdoInsights(user);
}

export async function completeInsight(staffId: number, insightKey: string) {
  const db = await getDb();
  await db.runAsync(
    `INSERT INTO ai_actions (insight_key, staff_id, action_type, completed_at)
     VALUES (?, ?, ?, datetime('now'))`,
    [insightKey, staffId, 'COMPLETED'],
  );
}

export async function getCdoRankings(branchId: number): Promise<CdoRanking[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<CdoScoreRow>(
    `SELECT
       s.id AS cdo_id,
       s.staff_code,
       s.name,
       COALESCE(due_stats.target, 0) AS target,
       COALESCE(collection_stats.collected, 0) AS collected,
       COALESCE(overdue_stats.overdue_amount, 0) AS overdue_amount,
       COALESCE(overdue_member_stats.overdue_members, 0) AS overdue_members,
       COALESCE(risk_stats.risk_accounts, 0) AS risk_accounts,
       COALESCE(savings_stats.savings_balance, 0) AS savings_balance
     FROM staff s
     LEFT JOIN (
       SELECT vo.cdo_id, SUM(ls.due_amount - ls.paid_amount) AS target
       FROM loan_schedules ls
       JOIN loan_accounts la ON la.id = ls.loan_id
       JOIN members m ON m.id = la.member_id
       JOIN village_organizations vo ON vo.id = m.vo_id
       WHERE ls.status != 'PAID'
         AND ls.due_date <= date('now')
       GROUP BY vo.cdo_id
     ) due_stats ON due_stats.cdo_id = s.id
     LEFT JOIN (
       SELECT staff_id, SUM(amount) AS collected
       FROM transactions
       WHERE transaction_date = date('now')
       GROUP BY staff_id
     ) collection_stats ON collection_stats.staff_id = s.id
     LEFT JOIN (
       SELECT vo.cdo_id, SUM(ls.due_amount - ls.paid_amount) AS overdue_amount
       FROM loan_schedules ls
       JOIN loan_accounts la ON la.id = ls.loan_id
       JOIN members m ON m.id = la.member_id
       JOIN village_organizations vo ON vo.id = m.vo_id
       WHERE ls.status != 'PAID'
         AND ls.due_date < date('now')
       GROUP BY vo.cdo_id
     ) overdue_stats ON overdue_stats.cdo_id = s.id
     LEFT JOIN (
       SELECT vo.cdo_id, COUNT(DISTINCT m.id) AS overdue_members
       FROM loan_schedules ls
       JOIN loan_accounts la ON la.id = ls.loan_id
       JOIN members m ON m.id = la.member_id
       JOIN village_organizations vo ON vo.id = m.vo_id
       WHERE ls.status != 'PAID'
         AND ls.due_date < date('now')
       GROUP BY vo.cdo_id
     ) overdue_member_stats ON overdue_member_stats.cdo_id = s.id
     LEFT JOIN (
       SELECT vo.cdo_id, COUNT(*) AS risk_accounts
       FROM loan_accounts la
       JOIN members m ON m.id = la.member_id
       JOIN village_organizations vo ON vo.id = m.vo_id
       WHERE la.status IN ('Late 2', 'NIBL 1', 'NIBL 2')
       GROUP BY vo.cdo_id
     ) risk_stats ON risk_stats.cdo_id = s.id
     LEFT JOIN (
       SELECT vo.cdo_id, SUM(sa.balance) AS savings_balance
       FROM savings_accounts sa
       JOIN members m ON m.id = sa.member_id
       JOIN village_organizations vo ON vo.id = m.vo_id
       GROUP BY vo.cdo_id
     ) savings_stats ON savings_stats.cdo_id = s.id
     WHERE s.role = 'CDO'
       AND s.branch_id = ?
     ORDER BY s.name`,
    [branchId],
  );

  const scored = rows.map((row) => {
    const target = row.target ?? 0;
    const collected = row.collected ?? 0;
    const overdueAmount = row.overdue_amount ?? 0;
    const overdueMembers = row.overdue_members ?? 0;
    const riskAccounts = row.risk_accounts ?? 0;
    const savingsBalance = row.savings_balance ?? 0;
    const collectionRate = target > 0 ? Math.min(collected / target, 1) : 1;
    const overduePenalty = Math.min(overdueAmount / 250000, 1);
    const riskPenalty = Math.min((overdueMembers + riskAccounts * 1.5) / 45, 1);
    const savingsBonus = Math.min(savingsBalance / 250000, 1);
    const score = Math.max(
      0,
      Math.round(collectionRate * 45 + (1 - overduePenalty) * 25 + (1 - riskPenalty) * 20 + savingsBonus * 10),
    );

    return {
      cdo_id: row.cdo_id,
      staff_code: row.staff_code,
      name: row.name,
      rank: 0,
      score,
      collection_rate: Math.round(collectionRate * 100),
      overdue_amount: overdueAmount,
      overdue_members: overdueMembers,
      risk_accounts: riskAccounts,
      savings_balance: savingsBalance,
      advice: buildRankingAdvice(score, overdueMembers, riskAccounts, collectionRate),
    };
  });

  scored.sort((a, b) => b.score - a.score || a.overdue_amount - b.overdue_amount);

  return scored.map((item, index) => ({ ...item, rank: index + 1 }));
}

export async function answerSmartChat(user: Staff, question: string, useLocalAi = false): Promise<ChatMessage> {
  if (useLocalAi) {
    try {
      const dynamic = await answerLlmSqlQuestion(user, question);
      await storeChatPair(user.id, question, dynamic.text, dynamic.source);
      return {
        id: `${Date.now()}-assistant`,
        role: 'assistant',
        text: dynamic.text,
        created_at: new Date().toISOString(),
        source: dynamic.source,
      };
    } catch {
      const text = 'AI সার্ভার থেকে সঠিক উত্তর পাওয়া যায়নি। মডেল সার্ভার চালু আছে কি না দেখে আবার প্রশ্ন করুন।';
      await storeChatPair(user.id, question, text, 'offline');
      return {
        id: `${Date.now()}-assistant`,
        role: 'assistant',
        text,
        created_at: new Date().toISOString(),
        source: 'offline',
      };
    }
  }

  try {
    const dynamic = await answerDynamicQuestion(user, question);
    await storeChatPair(user.id, question, dynamic.text, dynamic.source);
    return {
      id: `${Date.now()}-assistant`,
      role: 'assistant',
      text: dynamic.text,
      created_at: new Date().toISOString(),
      source: dynamic.source,
    };
  } catch {
    // Keep the previous intent-based path as a stability fallback.
  }

  const intent = classifyChatIntent(question, user.role);
  const context = await buildChatContext(user, question, intent);
  const gatewayUrls = getAiGatewayUrls();

  for (const gatewayUrl of gatewayUrls) {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    try {
      const controller = new AbortController();
      timeout = setTimeout(() => controller.abort(), DEMO_CHAT_TIMEOUT_MS);
      const response = await fetch(`${gatewayUrl}/api/ai/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          staff: {
            id: user.id,
            name: user.name,
            role: user.role,
            branch_id: user.branch_id,
          },
          question,
          intent,
          instruction: buildOnlineInstruction(user, intent),
          context,
        }),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      timeout = null;

      if (!response.ok) throw new Error(`AI gateway returned ${response.status}`);
      const json = await response.json();
      if (!json.text || json.source === 'fallback') throw new Error(json.error ?? 'AI gateway fallback');

      await storeChatPair(user.id, question, json.text, 'online');
      return {
        id: `${Date.now()}-assistant`,
        role: 'assistant',
        text: json.text,
        created_at: new Date().toISOString(),
        source: 'online',
      };
    } catch {
      continue;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  return answerOfflineChat(user, question);
}

export async function answerOfflineChat(user: Staff, question: string): Promise<ChatMessage> {
  const db = await getDb();
  const intent = classifyChatIntent(question, user.role);
  let answer = '';
  let context: unknown = {};

  if (intent === 'greeting') {
    const summary = user.role === 'BM' ? await getBranchSummary(user.branch_id) : await getCdoSummary(user.id);
    context = summary;
    answer =
      user.role === 'BM'
        ? `${user.name}, আজ আপনার শাখায় ${summary.members} জন সদস্য, ${money(summary.overdue)} overdue এবং ${summary.nibl1 + summary.nibl2}টি NIBL হিসাব আছে। আগে দুর্বল CDO ও ঝুঁকিপূর্ণ সদস্যদের তদারকি করুন।`
        : `${user.name}, আজ আপনার ${money(summary.target)} আদায়যোগ্য, ${money(summary.collected)} আদায় হয়েছে এবং ${money(summary.overdue)} overdue আছে। আগে সবচেয়ে ঝুঁকিপূর্ণ VO ও সদস্যদের অনুসরণ করুন।`;
  } else if (intent === 'savings_growth') {
    const focus = user.role === 'BM' ? await getSavingsFocusForBranch(user.branch_id) : await getSavingsFocusForCdo(user.id);
    context = focus;
    answer = buildSavingsAdvice(focus, user.role);
  } else if (intent === 'loan_disbursement') {
    const focus = user.role === 'BM' ? await getDisbursementFocusForBranch(user.branch_id) : await getDisbursementFocusForCdo(user.id);
    context = focus;
    answer = buildDisbursementAdvice(focus, user.role);
  } else if (intent === 'recent_disbursement_count') {
    const recent =
      user.role === 'BM' ? await getRecentDisbursementForBranch(user.branch_id) : await getRecentDisbursementForCdo(user.id);
    context = recent;
    answer = buildRecentDisbursementAnswer(recent, user.role);
  } else if (intent === 'non_payment_handling') {
    const risk =
      (await getMentionedMemberRisk(user, question)) ??
      (user.role === 'BM' ? await getTopRiskForBranch(user.branch_id) : await getTopRiskForCdo(user.id));
    context = risk;
    answer = buildNonPaymentAdvice({
      memberName: risk?.member_name,
      voName: risk?.vo_name,
      overdueAmount: risk?.overdue_amount,
      overdueDays: risk?.overdue_days,
    });
  } else if (intent === 'ranking') {
    const rankings = await getCdoRankings(user.branch_id);
    const myRank = rankings.find((item) => item.cdo_id === user.id);
    context = user.role === 'BM' ? rankings : myRank;
    answer =
      user.role === 'BM'
        ? `${rankings[0]?.name ?? 'কেউ'} বর্তমানে সেরা CDO, স্কোর ${rankings[0]?.score ?? 0}। ${rankings[rankings.length - 1]?.name ?? 'দুর্বল CDO'}-এর স্কোর সবচেয়ে কম, তাই তার overdue ও VO follow-up আগে দেখুন।`
        : `আপনার বর্তমান র‍্যাংক ${myRank?.rank ?? '-'} এবং স্কোর ${myRank?.score ?? 0}। ${translateRankingAdvice(myRank?.advice)}`;
  } else if (intent === 'risk_followup') {
    const risk = user.role === 'BM' ? await getTopRiskForBranch(user.branch_id) : await getTopRiskForCdo(user.id);
    context = risk;
    answer = risk
      ? `সবচেয়ে ঝুঁকিপূর্ণ সদস্য ${risk.member_name}, ${risk.vo_name}। তার overdue ${money(risk.overdue_amount)} এবং সবচেয়ে পুরোনো বকেয়া ${risk.overdue_days} দিনের। আজ প্রথমে তার সঙ্গে যোগাযোগ করুন, এরপর VO সভায় আংশিক হলেও আদায় নিশ্চিত করুন।`
      : 'এই মুহূর্তে স্থানীয় ডাটায় কোনো ঝুঁকিপূর্ণ overdue সদস্য পাওয়া যায়নি। তবুও আজকের due তালিকা দেখে follow-up চালিয়ে যান।';
  } else if (intent === 'vo_priority' || intent === 'work_plan') {
    const vos = user.role === 'CDO' ? await getCdoVos(user.id) : [];
    const topVo = [...vos].sort((a, b) => (b.due_amount ?? 0) - (a.due_amount ?? 0))[0];
    context = topVo;
    answer = topVo
      ? `আজ ${topVo.name} আগে শুরু করুন। এই VO-তে ${money(topVo.due_amount ?? 0)} আদায়যোগ্য এবং ${topVo.member_count ?? 0} জন সদস্য আছে। প্রথমে overdue সদস্য, তারপর নিয়মিত কিস্তি ও সঞ্চয় আদায় সম্পন্ন করুন।`
      : 'BM হিসেবে আগে CDO ranking দেখুন। যার স্কোর কম এবং overdue বেশি, তার VO ও সদস্য তালিকা খুলে তদারকি করুন।';
  } else if (intent === 'collection_improvement') {
    const summary = user.role === 'BM' ? await getBranchSummary(user.branch_id) : await getCdoSummary(user.id);
    context = summary;
    answer = `আদায় বাড়াতে আজ ${money(summary.target)} লক্ষ্যমাত্রার মধ্যে overdue অংশ আগে ধরুন। নিয়মিত সদস্যদের দ্রুত সংগ্রহ শেষ করে যাদের Late বা NIBL ঝুঁকি আছে তাদের আলাদা follow-up করুন। দিনের শেষে অন্তত ${money(Math.max(summary.target - summary.collected, 0))} বাকি টার্গেট কমানোর চেষ্টা করুন।`;
  } else if (intent === 'member_portfolio') {
    const risk = user.role === 'BM' ? await getTopRiskForBranch(user.branch_id) : await getTopRiskForCdo(user.id);
    if (risk) {
      const portfolio = await getMemberPortfolio(risk.member_id);
      context = portfolio;
      answer = `${portfolio?.member.name ?? risk.member_name}-এর ${portfolio?.loans.length ?? 0}টি ঋণ হিসাব আছে, মোট outstanding ${money(
        portfolio?.loans.reduce((sum, loan) => sum + loan.outstanding_amount, 0) ?? 0,
      )}। সাম্প্রতিক ${portfolio?.transactions.length ?? 0}টি transaction দেখা যাচ্ছে। আগে তার repayment behavior ও overdue schedule যাচাই করুন।`;
    } else {
      answer = 'স্থানীয় ডাটায় সারাংশ করার মতো কোনো ঝুঁকিপূর্ণ সদস্য পাওয়া যায়নি। নির্দিষ্ট সদস্য নির্বাচন করলে আরও ভালো বিশ্লেষণ দেওয়া যাবে।';
    }
  } else {
    const summary = user.role === 'BM' ? await getBranchSummary(user.branch_id) : await getCdoSummary(user.id);
    context = summary;
    answer = `আপনার পোর্টফোলিওতে ${summary.members} জন সদস্য এবং ${summary.vos}টি VO আছে। আজ আদায়যোগ্য ${money(summary.target)}, ইতিমধ্যে আদায় হয়েছে ${money(summary.collected)}, আর overdue আছে ${money(summary.overdue)}। আগে overdue ও high-risk সদস্যদের follow-up করুন।`;
  }

  await db.runAsync(
    `INSERT INTO ai_chat_context_snapshots (staff_id, question, context_json, created_at)
     VALUES (?, ?, ?, datetime('now'))`,
    [user.id, question, JSON.stringify(context)],
  );

  await storeChatPair(user.id, question, answer, 'offline');

  return {
    id: `${Date.now()}-assistant`,
    role: 'assistant',
    text: answer,
    created_at: new Date().toISOString(),
    source: 'offline',
  };
}

async function buildChatContext(user: Staff, question: string, intent: ChatIntent) {
  const baseSummary = user.role === 'BM' ? await getBranchSummary(user.branch_id) : await getCdoSummary(user.id);
  const rankings = await getCdoRankings(user.branch_id);
  const risk = user.role === 'BM' ? await getTopRiskForBranch(user.branch_id) : await getTopRiskForCdo(user.id);
  const recentMessages = await getRecentChatContext(user.id);

  if (intent === 'savings_growth') {
    const savingsFocus = user.role === 'BM' ? await getSavingsFocusForBranch(user.branch_id) : await getSavingsFocusForCdo(user.id);
    const suggestedBanglaAnswer = buildSavingsAdvice(savingsFocus, user.role);
    return {
      intent,
      intentTitle: intentTitleBangla(intent),
      summary: baseSummary,
      rankings,
      risk,
      savingsFocus,
      recentMessages,
      suggestedBanglaAnswer,
      instruction: buildOnlineInstruction(user, intent),
    };
  }

  if (intent === 'loan_disbursement') {
    const disbursementFocus =
      user.role === 'BM' ? await getDisbursementFocusForBranch(user.branch_id) : await getDisbursementFocusForCdo(user.id);
    const suggestedBanglaAnswer = buildDisbursementAdvice(disbursementFocus, user.role);
    return {
      intent,
      intentTitle: intentTitleBangla(intent),
      summary: baseSummary,
      rankings,
      risk,
      disbursementFocus,
      recentMessages,
      suggestedBanglaAnswer,
      instruction: buildOnlineInstruction(user, intent),
    };
  }

  if (intent === 'recent_disbursement_count') {
    const recentDisbursement =
      user.role === 'BM' ? await getRecentDisbursementForBranch(user.branch_id) : await getRecentDisbursementForCdo(user.id);
    const suggestedBanglaAnswer = buildRecentDisbursementAnswer(recentDisbursement, user.role);
    return {
      intent,
      intentTitle: intentTitleBangla(intent),
      summary: baseSummary,
      rankings,
      risk,
      recentDisbursement,
      recentMessages,
      suggestedBanglaAnswer,
      instruction: buildOnlineInstruction(user, intent),
    };
  }

  if (intent === 'non_payment_handling') {
    const namedRisk = await getMentionedMemberRisk(user, question);
    const effectiveRisk = namedRisk ?? risk;
    const suggestedBanglaAnswer = buildNonPaymentAdvice({
      memberName: effectiveRisk?.member_name,
      voName: effectiveRisk?.vo_name,
      overdueAmount: effectiveRisk?.overdue_amount,
      overdueDays: effectiveRisk?.overdue_days,
    });
    return {
      intent,
      intentTitle: intentTitleBangla(intent),
      summary: baseSummary,
      rankings,
      risk: effectiveRisk,
      recentMessages,
      suggestedBanglaAnswer,
      instruction: buildOnlineInstruction(user, intent),
    };
  }

  if (intent === 'member_portfolio') {
    const portfolio = risk ? await getMemberPortfolio(risk.member_id) : null;
    return {
      intent,
      intentTitle: intentTitleBangla(intent),
      summary: baseSummary,
      rankings,
      risk,
      portfolio,
      recentMessages,
      suggestedBanglaAnswer: risk
        ? `${risk.member_name}-এর পোর্টফোলিও আগে যাচাই করুন। ${risk.vo_name}-এ তার overdue ${money(risk.overdue_amount)} এবং সবচেয়ে পুরোনো বকেয়া ${risk.overdue_days} দিনের।`
        : 'নির্দিষ্ট সদস্য নির্বাচন করলে সদস্যভিত্তিক বিশ্লেষণ আরও ভালো হবে।',
      instruction: buildOnlineInstruction(user, intent),
    };
  }

  if (user.role === 'CDO') {
    const vos = await getCdoVos(user.id);
    return {
      intent,
      intentTitle: intentTitleBangla(intent),
      summary: baseSummary,
      rankings,
      risk,
      vos,
      recentMessages,
      suggestedBanglaAnswer: buildGeneralDraft(user, baseSummary, risk),
      instruction: buildOnlineInstruction(user, intent),
    };
  }

  return {
    intent,
    intentTitle: intentTitleBangla(intent),
    summary: baseSummary,
    rankings,
    risk,
    recentMessages,
    suggestedBanglaAnswer: buildGeneralDraft(user, baseSummary, risk),
    instruction: buildOnlineInstruction(user, intent),
  };
}

async function storeChatPair(
  staffId: number,
  question: string,
  answer: string,
  source: 'offline' | 'online',
) {
  const db = await getDb();
  await db.runAsync(
    `INSERT INTO ai_chat_messages (staff_id, role, message, source, created_at)
     VALUES (?, ?, ?, ?, datetime('now'))`,
    [staffId, 'user', question, source],
  );
  await db.runAsync(
    `INSERT INTO ai_chat_messages (staff_id, role, message, source, created_at)
     VALUES (?, ?, ?, ?, datetime('now'))`,
    [staffId, 'assistant', answer, source],
  );
}

function buildGeneralDraft(user: Staff, summary: Awaited<ReturnType<typeof getCdoSummary>>, risk: TopRiskRow | null) {
  const base =
    user.role === 'BM'
      ? `আপনার শাখায় ${summary.members} জন সদস্য এবং ${summary.vos}টি VO আছে। আজ আদায়যোগ্য ${money(summary.target)}, আদায় হয়েছে ${money(summary.collected)}, overdue ${money(summary.overdue)}।`
      : `আপনার পোর্টফোলিওতে ${summary.members} জন সদস্য এবং ${summary.vos}টি VO আছে। আজ আদায়যোগ্য ${money(summary.target)}, আদায় হয়েছে ${money(summary.collected)}, overdue ${money(summary.overdue)}।`;
  const riskLine = risk
    ? `প্রথম follow-up করুন ${risk.member_name}-এর সঙ্গে; ${risk.vo_name}-এ তার overdue ${money(risk.overdue_amount)} এবং সবচেয়ে পুরোনো বকেয়া ${risk.overdue_days} দিনের।`
    : 'ঝুঁকিপূর্ণ overdue সদস্য না থাকলে নিয়মিত collection ও savings target শেষ করুন।';
  return `${base} ${riskLine}`;
}

export async function getChatHistory(staffId: number): Promise<ChatMessage[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{
    id: number;
    role: 'user' | 'assistant';
    message: string;
    source: 'offline' | 'online';
    created_at: string;
  }>(
    `SELECT id, role, message, source, created_at
     FROM ai_chat_messages
     WHERE staff_id = ?
     ORDER BY id DESC
     LIMIT 30`,
    [staffId],
  );

  return rows.reverse().map((row) => ({
    id: String(row.id),
    role: row.role,
    text: row.message,
    source: row.source,
    created_at: row.created_at,
  }));
}

async function getRecentChatContext(staffId: number) {
  const db = await getDb();
  const rows = await db.getAllAsync<{
    role: 'user' | 'assistant';
    message: string;
    source: 'offline' | 'online';
  }>(
    `SELECT role, message, source
     FROM ai_chat_messages
     WHERE staff_id = ?
     ORDER BY id DESC
     LIMIT 6`,
    [staffId],
  );
  return rows.reverse();
}

async function getCdoInsights(user: Staff): Promise<AiInsight[]> {
  const [summary, vos, completed, risk] = await Promise.all([
    getCdoSummary(user.id),
    getCdoVos(user.id),
    getCompletedInsightKeys(user.id),
    getTopRiskForCdo(user.id),
  ]);
  const pendingMembers = await getPendingCollectionMembersForCdo(user.id);
  const topVo = [...vos].sort((a, b) => (b.due_amount ?? 0) - (a.due_amount ?? 0))[0];
  const today = new Date().toLocaleDateString(undefined, { weekday: 'long' });
  const todayVo = vos.find((vo) => vo.meeting_day === today) ?? topVo;
  const insights: AiInsight[] = [];

  if (pendingMembers > 0) {
    insights.push(makeInsight(user.id, completed, {
      key: `cdo-${user.id}-pending-${isoDate()}`,
      title: 'Today collection focus',
      message: `You have ${pendingMembers} pending member collections and ${money(summary.target)} due today.`,
      priority: 'high',
      action_label: todayVo ? `Open ${todayVo.code}` : 'Open VO list',
      target: todayVo ? 'vo' : 'home',
      target_id: todayVo?.id ?? null,
    }));
  }

  if (risk) {
    insights.push(makeInsight(user.id, completed, {
      key: `cdo-${user.id}-risk-${risk.member_id}-${isoDate()}`,
      title: 'Risk follow-up',
      message: `Top risky member: ${risk.member_name}, overdue ${risk.overdue_days} days with ${money(risk.overdue_amount)} pending.`,
      priority: 'high',
      action_label: 'Open member',
      target: 'member',
      target_id: risk.member_id,
    }));
  }

  if (topVo) {
    insights.push(makeInsight(user.id, completed, {
      key: `cdo-${user.id}-vo-${topVo.id}-${isoDate()}`,
      title: 'Suggested route',
      message: `Start with ${topVo.name}. It has the highest open due amount: ${money(topVo.due_amount ?? 0)}.`,
      priority: 'medium',
      action_label: 'View VO',
      target: 'vo',
      target_id: topVo.id,
    }));
  }

  if (summary.target > 0 && summary.collected >= summary.target) {
    insights.push(makeInsight(user.id, completed, {
      key: `cdo-${user.id}-cheer-${isoDate()}`,
      title: 'Target completed',
      message: `Excellent work. You completed today's collection target and kept the portfolio moving.`,
      priority: 'success',
      action_label: 'See ranking',
      target: 'ranking',
      target_id: null,
    }));
  } else {
    insights.push(makeInsight(user.id, completed, {
      key: `cdo-${user.id}-sync-${isoDate()}`,
      title: 'AI guidance mode',
      message: 'Offline guidance is active. Sync when internet is available for richer AI coaching.',
      priority: 'low',
      action_label: 'Ask assistant',
      target: 'chat',
      target_id: null,
    }));
  }

  return insights;
}

async function getBmInsights(user: Staff): Promise<AiInsight[]> {
  const [summary, rankings, completed, risk] = await Promise.all([
    getBranchSummary(user.branch_id),
    getCdoRankings(user.branch_id),
    getCompletedInsightKeys(user.id),
    getTopRiskForBranch(user.branch_id),
  ]);
  const lowest = rankings[rankings.length - 1];
  const top = rankings[0];
  const insights: AiInsight[] = [];

  if (lowest) {
    insights.push(makeInsight(user.id, completed, {
      key: `bm-${user.id}-supervise-${lowest.cdo_id}-${isoDate()}`,
      title: 'Supervision focus',
      message: `${lowest.name} needs the closest support today. Score ${lowest.score}, ${lowest.overdue_members} overdue members.`,
      priority: lowest.score < 65 ? 'high' : 'medium',
      action_label: 'Open CDO',
      target: 'cdo',
      target_id: lowest.cdo_id,
    }));
  }

  if (risk) {
    insights.push(makeInsight(user.id, completed, {
      key: `bm-${user.id}-risk-${risk.member_id}-${isoDate()}`,
      title: 'Branch risk alert',
      message: `${risk.member_name} is the branch top risk: ${money(risk.overdue_amount)} overdue for ${risk.overdue_days} days.`,
      priority: 'high',
      action_label: 'Open member',
      target: 'member',
      target_id: risk.member_id,
    }));
  }

  insights.push(makeInsight(user.id, completed, {
    key: `bm-${user.id}-portfolio-${isoDate()}`,
    title: 'Branch portfolio',
    message: `${summary.members} members, ${money(summary.overdue)} overdue, and ${summary.nibl1 + summary.nibl2} NIBL accounts need monitoring.`,
    priority: summary.nibl1 + summary.nibl2 > 0 ? 'medium' : 'success',
    action_label: 'View ranking',
    target: 'ranking',
    target_id: null,
  }));

  if (top) {
    insights.push(makeInsight(user.id, completed, {
      key: `bm-${user.id}-cheer-${top.cdo_id}-${isoDate()}`,
      title: 'Recognize performance',
      message: `${top.name} is leading today with score ${top.score}. Use this as a positive example in the branch check-in.`,
      priority: 'success',
      action_label: 'View ranking',
      target: 'ranking',
      target_id: null,
    }));
  }

  return insights;
}

async function getCompletedInsightKeys(staffId: number) {
  const db = await getDb();
  const rows = await db.getAllAsync<CompletionRow>(
    `SELECT DISTINCT insight_key
     FROM ai_actions
     WHERE staff_id = ?`,
    [staffId],
  );
  return new Set(rows.map((row) => row.insight_key));
}

function makeInsight(
  staffId: number,
  completedKeys: Set<string>,
  input: Omit<AiInsight, 'source' | 'completed'>,
): AiInsight {
  return {
    ...input,
    source: 'offline',
    completed: completedKeys.has(input.key),
  };
}

async function getPendingCollectionMembersForCdo(cdoId: number) {
  const db = await getDb();
  const row = await db.getFirstAsync<CountRow>(
    `SELECT COUNT(DISTINCT m.id) AS count
     FROM loan_schedules ls
     JOIN loan_accounts la ON la.id = ls.loan_id
     JOIN members m ON m.id = la.member_id
     JOIN village_organizations vo ON vo.id = m.vo_id
     WHERE vo.cdo_id = ?
       AND ls.status != 'PAID'
       AND ls.due_date <= date('now')`,
    [cdoId],
  );
  return row?.count ?? 0;
}

async function getTopRiskForCdo(cdoId: number) {
  return getTopRisk('vo.cdo_id = ?', [cdoId]);
}

async function getTopRiskForBranch(branchId: number) {
  return getTopRisk('vo.branch_id = ?', [branchId]);
}

async function getTopRisk(whereClause: string, params: number[]) {
  const db = await getDb();
  return db.getFirstAsync<TopRiskRow>(
    `SELECT
       m.id AS member_id,
       m.name AS member_name,
       vo.id AS vo_id,
       vo.name AS vo_name,
       SUM(ls.due_amount - ls.paid_amount) AS overdue_amount,
       CAST(julianday(date('now')) - julianday(MIN(ls.due_date)) AS INTEGER) AS overdue_days
     FROM loan_schedules ls
     JOIN loan_accounts la ON la.id = ls.loan_id
     JOIN members m ON m.id = la.member_id
     JOIN village_organizations vo ON vo.id = m.vo_id
     WHERE ${whereClause}
       AND ls.status != 'PAID'
       AND ls.due_date < date('now')
     GROUP BY m.id, vo.id
     ORDER BY overdue_days DESC, overdue_amount DESC
     LIMIT 1`,
    params,
  );
}

async function getMentionedMemberRisk(user: Staff, question: string) {
  const db = await getDb();
  const tokens = question
    .toLowerCase()
    .replace(/[^a-zA-Z\u0980-\u09FF\s]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length >= 3);

  if (tokens.length === 0) return null;

  const scopeWhere = user.role === 'BM' ? 'vo.branch_id = ?' : 'vo.cdo_id = ?';
  const scopeParam = user.role === 'BM' ? user.branch_id : user.id;

  for (const token of tokens) {
    const row = await db.getFirstAsync<MentionedMemberRisk>(
      `SELECT
         m.id AS member_id,
         m.name AS member_name,
         m.phone,
         m.risk_note,
         vo.id AS vo_id,
         vo.name AS vo_name,
         COALESCE(SUM(CASE WHEN ls.status != 'PAID' AND ls.due_date < date('now')
           THEN ls.due_amount - ls.paid_amount ELSE 0 END), 0) AS overdue_amount,
         COALESCE(CAST(julianday(date('now')) - julianday(MIN(CASE WHEN ls.status != 'PAID' AND ls.due_date < date('now')
           THEN ls.due_date END)) AS INTEGER), 0) AS overdue_days
       FROM members m
       JOIN village_organizations vo ON vo.id = m.vo_id
       LEFT JOIN loan_accounts la ON la.member_id = m.id
       LEFT JOIN loan_schedules ls ON ls.loan_id = la.id
       WHERE ${scopeWhere}
         AND LOWER(m.name) LIKE ?
       GROUP BY m.id, vo.id
       LIMIT 1`,
      [scopeParam, `%${token}%`],
    );

    if (row) return row;
  }

  return null;
}

function buildRankingAdvice(score: number, overdueMembers: number, riskAccounts: number, collectionRate: number) {
  if (score >= 85) return 'Keep the rhythm and help peers with your follow-up pattern.';
  if (collectionRate < 0.5) return 'Prioritize today due members and close at least the first VO target.';
  if (overdueMembers > 10) return 'Block time for overdue calls before the next VO meeting.';
  if (riskAccounts > 4) return 'Review Late 2 and NIBL members with the BM before field visits.';
  return 'Good base. Improve the score by clearing the oldest overdue account first.';
}

async function getSavingsFocusForCdo(cdoId: number): Promise<SavingsFocus> {
  return getSavingsFocus('vo.cdo_id = ?', [cdoId]);
}

async function getSavingsFocusForBranch(branchId: number): Promise<SavingsFocus> {
  return getSavingsFocus('vo.branch_id = ?', [branchId]);
}

async function getSavingsFocus(whereClause: string, params: number[]): Promise<SavingsFocus> {
  const db = await getDb();
  const totals = await db.getFirstAsync<{
    total_savings: number | null;
    total_dps: number | null;
    weekly_target: number | null;
    members: number;
    low_savings_members: number;
  }>(
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
     WHERE ${whereClause}`,
    params,
  );
  const voRows = await db.getAllAsync<{ vo_name: string; savings: number }>(
    `SELECT
       vo.name AS vo_name,
       COALESCE(SUM(sa.balance), 0) AS savings
     FROM village_organizations vo
     LEFT JOIN members m ON m.vo_id = vo.id
     LEFT JOIN savings_accounts sa ON sa.member_id = m.id
     WHERE ${whereClause}
     GROUP BY vo.id
     ORDER BY savings DESC`,
    params,
  );
  const topVo = voRows[0];
  const lowestVo = voRows[voRows.length - 1];

  return {
    totalSavings: totals?.total_savings ?? 0,
    totalDps: totals?.total_dps ?? 0,
    weeklyTarget: totals?.weekly_target ?? 0,
    members: totals?.members ?? 0,
    lowSavingsMembers: totals?.low_savings_members ?? 0,
    topVoName: topVo?.vo_name ?? null,
    topVoSavings: topVo?.savings ?? 0,
    lowestVoName: lowestVo?.vo_name ?? null,
    lowestVoSavings: lowestVo?.savings ?? 0,
  };
}

function buildSavingsAdviceLegacy(focus: SavingsFocus, role: Staff['role']) {
  const scope = role === 'BM' ? 'branch' : 'portfolio';
  const targetLine = `Your ${scope} has ${money(focus.totalSavings)} savings and ${money(focus.totalDps)} DPS across ${focus.members} members.`;
  const lowLine =
    focus.lowSavingsMembers > 0
      ? `${focus.lowSavingsMembers} members have low savings balance, so start with them before routine collections.`
      : 'No low-savings group is flagged, so focus on consistency in weekly deposits.';
  const voLine = focus.lowestVoName
    ? `The weakest savings VO is ${focus.lowestVoName} with ${money(focus.lowestVoSavings)} savings.`
    : 'VO-wise savings data is not available yet.';
  return `${targetLine} ${lowLine} ${voLine} Next action: set a weekly savings target of ${money(
    focus.weeklyTarget,
  )}, remind members during VO meetings, and encourage DPS for members with stable repayment behavior.`;
}

function isSavingsQuestion(text: string) {
  return (
    text.includes('saving') ||
    text.includes('savings') ||
    text.includes('dps') ||
    text.includes('deposit') ||
    text.includes('increase portfolio')
  );
}

function isGreeting(text: string) {
  const cleaned = text.trim().toLowerCase();
  return ['hi', 'hello', 'hey', 'assalamualaikum', 'salam'].includes(cleaned);
}

function moneyLegacy(value: number) {
  return `৳${Math.round(value).toLocaleString('en-US')}`;
}

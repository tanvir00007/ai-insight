import { getDb } from './db';
import { Staff } from './types';

export type SavingsFocusLike = {
  totalSavings: number;
  totalDps: number;
  weeklyTarget: number;
  members: number;
  lowSavingsMembers: number;
  lowestVoName: string | null;
  lowestVoSavings: number;
};

export type DisbursementCandidate = {
  member_id: number;
  member_name: string;
  vo_name: string;
  savings_balance: number;
  active_loans: number;
  outstanding_amount: number;
  recent_transactions: number;
};

export type DisbursementFocus = {
  candidates: DisbursementCandidate[];
  currentAccounts: number;
  riskyAccounts: number;
};

export type RecentDisbursementMember = {
  member_id: number;
  member_name: string;
  vo_name: string;
  product_name: string;
  principal_amount: number;
  disbursed_at: string;
};

export type RecentDisbursementSummary = {
  totalMembers: number;
  totalLoans: number;
  totalAmount: number;
  days: number;
  members: RecentDisbursementMember[];
};

export function buildSavingsAdvice(focus: SavingsFocusLike, role: Staff['role']) {
  const scope = role === 'BM' ? 'শাখায়' : 'পোর্টফোলিওতে';
  const targetLine = `আপনার ${scope} ${focus.members} জন সদস্যের মোট সঞ্চয় ${money(focus.totalSavings)} এবং DPS ${money(focus.totalDps)}।`;
  const lowLine =
    focus.lowSavingsMembers > 0
      ? `${focus.lowSavingsMembers} জন সদস্যের সঞ্চয় কম, তাই নিয়মিত কিস্তির আগে তাদের সঞ্চয় follow-up করুন।`
      : 'কম সঞ্চয়ের আলাদা ঝুঁকি দেখা যাচ্ছে না, তাই সাপ্তাহিক জমার ধারাবাহিকতা ধরে রাখুন।';
  const voLine = focus.lowestVoName
    ? `সঞ্চয়ে সবচেয়ে দুর্বল VO হলো ${focus.lowestVoName}, যেখানে সঞ্চয় ${money(focus.lowestVoSavings)}।`
    : 'VO অনুযায়ী সঞ্চয়ের তথ্য এখনো পাওয়া যাচ্ছে না।';

  return `${targetLine} ${lowLine} ${voLine} আজকের করণীয়: ${money(
    focus.weeklyTarget,
  )} সাপ্তাহিক সঞ্চয় লক্ষ্যমাত্রা ধরে VO সভায় সদস্যদের মনে করিয়ে দিন এবং যাদের repayment নিয়মিত তাদের DPS-এর জন্য উৎসাহিত করুন।`;
}

export async function getDisbursementFocusForCdo(cdoId: number): Promise<DisbursementFocus> {
  return getDisbursementFocus('vo.cdo_id = ?', [cdoId]);
}

export async function getDisbursementFocusForBranch(branchId: number): Promise<DisbursementFocus> {
  return getDisbursementFocus('vo.branch_id = ?', [branchId]);
}

export async function getRecentDisbursementForCdo(cdoId: number, days = 60): Promise<RecentDisbursementSummary> {
  return getRecentDisbursement('vo.cdo_id = ?', [cdoId], days);
}

export async function getRecentDisbursementForBranch(branchId: number, days = 60): Promise<RecentDisbursementSummary> {
  return getRecentDisbursement('vo.branch_id = ?', [branchId], days);
}

export function buildRecentDisbursementAnswer(summary: RecentDisbursementSummary, role: Staff['role']) {
  const scope = role === 'BM' ? 'শাখায়' : 'আপনার পোর্টফোলিওতে';
  if (summary.totalLoans === 0) {
    return `গত ${summary.days} দিনে ${scope} কোনো নতুন ঋণ বিতরণ পাওয়া যায়নি। আজ Current status ও ভালো সঞ্চয় আছে এমন সদস্যদের shortlist করে BM-এর সঙ্গে আলোচনা করুন।`;
  }
  const examples = summary.members
    .slice(0, 3)
    .map((member) => `${member.member_name} (${member.vo_name}, ${money(member.principal_amount)})`)
    .join(', ');
  return `গত ${summary.days} দিনে ${scope} ${summary.totalMembers} জন সদস্যের মধ্যে ${summary.totalLoans}টি নতুন ঋণ বিতরণ হয়েছে। মোট বিতরণ ${money(summary.totalAmount)}। উদাহরণ: ${examples}। নতুন disbursement follow-up করতে এই সদস্যদের প্রথম কিস্তি ও সঞ্চয় আচরণ নিয়মিত পর্যবেক্ষণ করুন।`;
}

export function buildNonPaymentAdvice(input: {
  memberName?: string;
  voName?: string;
  overdueAmount?: number;
  overdueDays?: number;
}) {
  const memberLine = input.memberName
    ? `যদি ${input.memberName} (${input.voName}) টাকা না দেন, আগে কারণটি শান্তভাবে জানুন। তার overdue ${money(input.overdueAmount ?? 0)} এবং বকেয়া ${input.overdueDays ?? 0} দিনের।`
    : 'কোনো সদস্য টাকা না দিলে আগে কারণটি শান্তভাবে জানুন এবং তাকে চাপ না দিয়ে সমাধানের পথ দিন।';

  return `${memberLine} করণীয়: ১) পুরো টাকা না পারলে আংশিক কিস্তি নেওয়ার চেষ্টা করুন, ২) পরবর্তী VO সভার আগেই নির্দিষ্ট follow-up সময় ঠিক করুন, ৩) বারবার না দিলে BM-কে জানিয়ে repayment plan করুন। কোনো প্রতিশ্রুতি পেলে সেটি transaction note বা follow-up note হিসেবে লিখে রাখুন।`;
}

export function buildDisbursementAdvice(focus: DisbursementFocus, role: Staff['role']) {
  const candidateLine =
    focus.candidates.length > 0
      ? `প্রাথমিকভাবে ${focus.candidates.length} জন সম্ভাব্য সদস্য পাওয়া গেছে। সবচেয়ে শক্তিশালী প্রার্থী ${focus.candidates[0].member_name}, ${focus.candidates[0].vo_name}; তার সঞ্চয় ${money(focus.candidates[0].savings_balance)}।`
      : 'বর্তমানে নিয়মিত repayment ও ভালো সঞ্চয়ের ভিত্তিতে স্পষ্ট প্রার্থী কম দেখা যাচ্ছে।';
  const scopeLine =
    role === 'BM'
      ? `শাখায় ${focus.currentAccounts}টি Current ঋণ হিসাব আছে, আর ${focus.riskyAccounts}টি ঝুঁকিপূর্ণ হিসাব আগে নিয়ন্ত্রণে রাখা দরকার।`
      : `আপনার পোর্টফোলিওতে ${focus.currentAccounts}টি Current ঋণ হিসাব আছে, আর ${focus.riskyAccounts}টি ঝুঁকিপূর্ণ হিসাব আগে follow-up করা দরকার।`;

  return `${scopeLine} ${candidateLine} ঋণ বিতরণ বাড়াতে আজ Current status, ভালো সঞ্চয় এবং নিয়মিত transaction আছে এমন সদস্যদের shortlist করুন। তারপর ২-৩ জন যোগ্য সদস্যের তথ্য BM-এর সঙ্গে যাচাই করুন।`;
}

export function translateRankingAdvice(advice?: string) {
  if (!advice) return 'আজ overdue সদস্যদের আগে follow-up করুন এবং collection update নিয়মিত রাখুন।';
  if (advice.includes('Keep the rhythm')) return 'আপনার কাজের গতি ভালো। একই follow-up পদ্ধতি ধরে রাখুন এবং দুর্বল VO-তে একটু বেশি সময় দিন।';
  if (advice.includes('Prioritize today')) return 'আজকের due সদস্যদের অগ্রাধিকার দিন এবং প্রথম VO-এর target আগে শেষ করুন।';
  if (advice.includes('overdue calls')) return 'পরবর্তী VO সভার আগে overdue সদস্যদের ফোন follow-up করার জন্য আলাদা সময় রাখুন।';
  if (advice.includes('Late 2')) return 'Late 2 ও NIBL সদস্যদের BM-এর সঙ্গে আলোচনা করে মাঠে follow-up করুন।';
  return 'সবচেয়ে পুরোনো overdue হিসাবটি আগে কমাতে পারলে আপনার স্কোর দ্রুত উন্নত হবে।';
}

export function money(value: number) {
  return `৳${Math.round(value).toLocaleString('en-US')}`;
}

async function getDisbursementFocus(whereClause: string, params: number[]): Promise<DisbursementFocus> {
  const db = await getDb();
  const candidates = await db.getAllAsync<DisbursementCandidate>(
    `SELECT
       m.id AS member_id,
       m.name AS member_name,
       vo.name AS vo_name,
       COALESCE(sa.balance, 0) AS savings_balance,
       COUNT(DISTINCT la.id) AS active_loans,
       COALESCE(SUM(la.outstanding_amount), 0) AS outstanding_amount,
       COUNT(DISTINCT t.id) AS recent_transactions
     FROM members m
     JOIN village_organizations vo ON vo.id = m.vo_id
     LEFT JOIN savings_accounts sa ON sa.member_id = m.id
     LEFT JOIN loan_accounts la ON la.member_id = m.id AND la.outstanding_amount > 0
     LEFT JOIN transactions t ON t.member_id = m.id AND t.transaction_date >= date('now', '-90 day')
     WHERE ${whereClause}
       AND NOT EXISTS (
         SELECT 1
         FROM loan_accounts risky
         WHERE risky.member_id = m.id
           AND risky.status IN ('Late 1', 'Late 2', 'NIBL 1', 'NIBL 2')
       )
     GROUP BY m.id, vo.id
     HAVING savings_balance >= 1500
     ORDER BY savings_balance DESC, recent_transactions DESC, outstanding_amount ASC
     LIMIT 5`,
    params,
  );
  const status = await db.getFirstAsync<{ current_accounts: number; risky_accounts: number }>(
    `SELECT
       COUNT(CASE WHEN la.status = 'Current' THEN 1 END) AS current_accounts,
       COUNT(CASE WHEN la.status IN ('Late 1', 'Late 2', 'NIBL 1', 'NIBL 2') THEN 1 END) AS risky_accounts
     FROM loan_accounts la
     JOIN members m ON m.id = la.member_id
     JOIN village_organizations vo ON vo.id = m.vo_id
     WHERE ${whereClause}`,
    params,
  );

  return {
    candidates,
    currentAccounts: status?.current_accounts ?? 0,
    riskyAccounts: status?.risky_accounts ?? 0,
  };
}

async function getRecentDisbursement(
  whereClause: string,
  params: number[],
  days: number,
): Promise<RecentDisbursementSummary> {
  const db = await getDb();
  const members = await db.getAllAsync<RecentDisbursementMember>(
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
     WHERE ${whereClause}
       AND date(la.disbursed_at) >= date('now', ?)
     ORDER BY la.disbursed_at DESC, la.principal_amount DESC`,
    [...params, `-${days} day`],
  );

  const memberIds = new Set(members.map((member) => member.member_id));
  return {
    totalMembers: memberIds.size,
    totalLoans: members.length,
    totalAmount: members.reduce((sum, member) => sum + member.principal_amount, 0),
    days,
    members,
  };
}

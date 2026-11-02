export type Role = 'BM' | 'CDO';

export type LoanStatus = 'Current' | 'Late 1' | 'Late 2' | 'NIBL 1' | 'NIBL 2';

export type Staff = {
  id: number;
  staff_code: string;
  name: string;
  role: Role;
  pin: string;
  branch_id: number;
  supervisor_id: number | null;
};

export type Branch = {
  id: number;
  name: string;
  code: string;
  district: string;
};

export type VillageOrganization = {
  id: number;
  code: string;
  name: string;
  meeting_day: string;
  meeting_time: string;
  area: string;
  cdo_id: number;
  member_count?: number;
  due_amount?: number;
  collected_amount?: number;
};

export type Member = {
  id: number;
  member_code: string;
  name: string;
  phone: string;
  spouse_name: string;
  occupation: string;
  address: string;
  vo_id: number;
  joined_at: string;
  risk_note: string;
  active_loans?: number;
  due_amount?: number;
  savings_balance?: number;
};

export type LoanAccount = {
  id: number;
  member_id: number;
  product_name: string;
  principal_amount: number;
  outstanding_amount: number;
  installment_amount: number;
  disbursed_at: string;
  status: LoanStatus;
  next_due_date: string;
};

export type SavingsAccount = {
  id: number;
  member_id: number;
  product_name: string;
  balance: number;
  weekly_target: number;
};

export type DpsAccount = {
  id: number;
  member_id: number;
  product_name: string;
  balance: number;
  monthly_target: number;
  maturity_date: string;
};

export type LoanSchedule = {
  id: number;
  loan_id: number;
  installment_no: number;
  due_date: string;
  due_amount: number;
  paid_amount: number;
  status: 'PENDING' | 'PARTIAL' | 'PAID';
};

export type Transaction = {
  id: number;
  transaction_date: string;
  member_id: number;
  vo_id: number;
  staff_id: number;
  product_type: 'LOAN' | 'SAVINGS' | 'DPS';
  product_id: number;
  transaction_type: string;
  amount: number;
  note: string;
};

export type DashboardSummary = {
  members: number;
  vos: number;
  target: number;
  collected: number;
  overdue: number;
  savings: number;
  dps: number;
  current: number;
  late1: number;
  late2: number;
  nibl1: number;
  nibl2: number;
};

export type MemberPortfolio = {
  member: Member;
  loans: LoanAccount[];
  savings: SavingsAccount[];
  dps: DpsAccount[];
  schedules: LoanSchedule[];
  transactions: Transaction[];
};

export type AiPriority = 'low' | 'medium' | 'high' | 'success';

export type AiActionTarget = 'home' | 'vo' | 'member' | 'cdo' | 'ranking' | 'chat';

export type AiInsight = {
  key: string;
  title: string;
  message: string;
  priority: AiPriority;
  source: 'offline' | 'online';
  action_label: string;
  target: AiActionTarget;
  target_id: number | null;
  completed: boolean;
};

export type CdoRanking = {
  cdo_id: number;
  staff_code: string;
  name: string;
  rank: number;
  score: number;
  collection_rate: number;
  overdue_amount: number;
  overdue_members: number;
  risk_accounts: number;
  savings_balance: number;
  advice: string;
};

export type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  created_at: string;
  source: 'offline' | 'online';
};

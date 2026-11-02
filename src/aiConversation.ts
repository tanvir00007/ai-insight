import { Role, Staff } from './types';

export type ChatIntent =
  | 'greeting'
  | 'work_plan'
  | 'collection_improvement'
  | 'non_payment_handling'
  | 'risk_followup'
  | 'vo_priority'
  | 'savings_growth'
  | 'loan_disbursement'
  | 'recent_disbursement_count'
  | 'ranking'
  | 'bm_supervision'
  | 'member_portfolio'
  | 'summary';

const intentTerms: Record<ChatIntent, string[]> = {
  greeting: ['hi', 'hello', 'hey', 'salam', 'assalamualaikum', 'আসসালামু', 'সালাম', 'হ্যালো', 'হাই'],
  work_plan: ['work plan', 'kaj', 'কাজ', 'পরিকল্পনা', 'আজ কী', 'today plan', 'focus'],
  collection_improvement: [
    'collection',
    'collect',
    'adaya',
    'aday',
    'kisti',
    'kisti',
    'কিস্তি',
    'আদায়',
    'আদায়',
    'কালেকশন',
    'সংগ্রহ',
  ],
  non_payment_handling: [
    'taka na dei',
    'taka na dey',
    'tk na dei',
    'kisti na dei',
    'kisti na dey',
    'pay na kore',
    'payment na kore',
    'member taka',
    'dite chai',
    'dity chai',
    'dite na chai',
    'dity na chai',
    'na dity',
    'na dite',
    'না দিলে',
    'টাকা না',
    'কিস্তি না',
    'পরিশোধ না',
    'আদায় না',
    'দিতে না চাই',
  ],
  risk_followup: ['risk', 'risky', 'overdue', 'late', 'nibl', 'ঝুঁকি', 'ঝুঁকিপূর্ণ', 'বকেয়া', 'বকেয়া', 'দেরি'],
  vo_priority: ['vo', 'visit', 'jabo', 'যাব', 'আগে যাব', 'কোন vo', 'সভা', 'village'],
  savings_growth: [
    'saving',
    'savings',
    'dps',
    'deposit',
    'sonchoy',
    'shonchoy',
    'sanchay',
    'সঞ্চয়',
    'সঞ্চয়',
    'জমা',
    'ডিপিএস',
  ],
  loan_disbursement: [
    'disbursement',
    'disburse',
    'loan barabo',
    'loan barbe',
    'rin barabo',
    'ঋণ বিতরণ',
    'লোন বিতরণ',
    'ঋণ বাড়',
    'ঋণ বাড়',
    'লোন বাড়',
    'লোন বাড়',
    'নতুন ঋণ',
  ],
  recent_disbursement_count: [
    'new disbursement',
    'notun disbursement',
    'notun disbursed',
    'disbursed member',
    'disbursement koto',
    'disbursement kotogon',
    'disbursement kotojon',
    'kotojon',
    'কতজন',
    'নতুন বিতরণ',
    'নতুন ঋণ নিয়েছে',
    'নতুন ঋণ নিয়েছে',
    'ঋণ বিতরণ কত',
  ],
  ranking: ['rank', 'ranking', 'performance', 'compare', 'top cdo', 'র‍্যাংক', 'র‌্যাংক', 'পারফরম্যান্স', 'তুলনা'],
  bm_supervision: ['supervision', 'support', 'bm', 'monitor', 'তদারকি', 'সহায়তা', 'সহায়তা', 'পর্যবেক্ষণ'],
  member_portfolio: ['member portfolio', 'client profile', 'member profile', 'সদস্য প্রোফাইল', 'সদস্য পোর্টফোলিও'],
  summary: ['summary', 'portfolio', 'সারাংশ', 'পোর্টফোলিও', 'অবস্থা'],
};

export function classifyChatIntent(question: string, role: Role): ChatIntent {
  const normalized = normalizeQuestion(question);

  if (isExactGreeting(normalized)) return 'greeting';
  if (matches(normalized, intentTerms.savings_growth)) return 'savings_growth';
  if (matches(normalized, intentTerms.recent_disbursement_count)) return 'recent_disbursement_count';
  if (matches(normalized, intentTerms.loan_disbursement) || normalized.includes('barabo kamne')) return 'loan_disbursement';
  if (matches(normalized, intentTerms.non_payment_handling)) return 'non_payment_handling';
  if (matches(normalized, intentTerms.ranking)) return 'ranking';
  if (role === 'BM' && matches(normalized, intentTerms.bm_supervision)) return 'bm_supervision';
  if (matches(normalized, intentTerms.risk_followup)) return 'risk_followup';
  if (matches(normalized, intentTerms.vo_priority)) return 'vo_priority';
  if (matches(normalized, intentTerms.collection_improvement)) return 'collection_improvement';
  if (matches(normalized, intentTerms.work_plan)) return 'work_plan';
  if (matches(normalized, intentTerms.member_portfolio)) return 'member_portfolio';
  return 'summary';
}

export function buildOnlineInstruction(user: Staff, intent: ChatIntent) {
  return [
    'উত্তর অবশ্যই প্রাঞ্জল, শুদ্ধ বাংলায় দিন।',
    'ব্যবহারকারী ইংরেজি, বাংলা, Banglish বা মিশ্র ভাষায় প্রশ্ন করলেও উত্তর বাংলাতেই দিন।',
    'Banglish বাক্য ব্যবহার করবেন না। প্রয়োজন হলে শুধু CDO, BM, VO, DPS, NIBL, overdue, Current শব্দগুলো রাখুন।',
    'মাঠপর্যায়ের সহায়ক সুপারভাইজারের মতো বন্ধুসুলভ কিন্তু পেশাদার ভঙ্গিতে উত্তর দিন।',
    'দেওয়া তথ্য ছাড়া কোনো নাম, টাকা, তারিখ বা সংখ্যা বানাবেন না।',
    'উত্তরে ২-৩টি বাস্তব করণীয় দিন। অকারণে "তথ্য নেই" বলবেন না।',
    `ব্যবহারকারী: ${user.name}, ভূমিকা: ${user.role}, intent: ${intent}`,
  ].join('\n');
}

export function intentTitleBangla(intent: ChatIntent) {
  const titles: Record<ChatIntent, string> = {
    greeting: 'স্বাগত',
    work_plan: 'আজকের কাজের পরিকল্পনা',
    collection_improvement: 'আদায় উন্নয়ন',
    non_payment_handling: 'সদস্য টাকা না দিলে করণীয়',
    risk_followup: 'ঝুঁকিপূর্ণ সদস্য',
    vo_priority: 'VO অগ্রাধিকার',
    savings_growth: 'সঞ্চয় ও DPS বৃদ্ধি',
    loan_disbursement: 'ঋণ বিতরণ বৃদ্ধি',
    recent_disbursement_count: 'নতুন ঋণ বিতরণ সংখ্যা',
    ranking: 'পারফরম্যান্স র‍্যাংকিং',
    bm_supervision: 'BM তদারকি',
    member_portfolio: 'সদস্য পোর্টফোলিও',
    summary: 'পোর্টফোলিও সারাংশ',
  };
  return titles[intent];
}

function normalizeQuestion(question: string) {
  return question
    .toLowerCase()
    .replace(/[?।!,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function matches(text: string, terms: string[]) {
  return terms.some((term) => text.includes(term.toLowerCase()));
}

function isExactGreeting(text: string) {
  return ['hi', 'hello', 'hey', 'salam', 'assalamualaikum', 'হাই', 'হ্যালো', 'সালাম'].includes(text);
}

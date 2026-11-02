import * as SQLite from 'expo-sqlite';
import {
  Branch,
  DashboardSummary,
  DpsAccount,
  LoanAccount,
  LoanSchedule,
  LoanStatus,
  Member,
  MemberPortfolio,
  SavingsAccount,
  Staff,
  Transaction,
  VillageOrganization,
} from './types';

const DB_NAME = 'microfinance-mvp.db';
const SEED_VERSION = '2026-05-08-v1';

let database: SQLite.SQLiteDatabase | null = null;

type CountRow = { count: number };
type SumRow = { total: number | null };

export async function getDb() {
  if (!database) {
    database = await SQLite.openDatabaseAsync(DB_NAME);
  }

  return database;
}

export function isoDate(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function weekdayFromOffset(offset: number) {
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  return days[offset % days.length];
}

function calculateStatus(overdueCount: number): LoanStatus {
  if (overdueCount <= 0) return 'Current';
  if (overdueCount === 1) return 'Late 1';
  if (overdueCount === 2) return 'Late 2';
  if (overdueCount <= 5) return 'NIBL 1';
  return 'NIBL 2';
}

export async function initDatabase() {
  const db = await getDb();

  await db.execAsync(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS app_meta (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS branches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL,
      name TEXT NOT NULL,
      district TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS staff (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      staff_code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      role TEXT NOT NULL,
      pin TEXT NOT NULL,
      branch_id INTEGER NOT NULL,
      supervisor_id INTEGER,
      FOREIGN KEY (branch_id) REFERENCES branches(id),
      FOREIGN KEY (supervisor_id) REFERENCES staff(id)
    );

    CREATE TABLE IF NOT EXISTS village_organizations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL,
      name TEXT NOT NULL,
      meeting_day TEXT NOT NULL,
      meeting_time TEXT NOT NULL,
      area TEXT NOT NULL,
      cdo_id INTEGER NOT NULL,
      branch_id INTEGER NOT NULL,
      FOREIGN KEY (cdo_id) REFERENCES staff(id),
      FOREIGN KEY (branch_id) REFERENCES branches(id)
    );

    CREATE TABLE IF NOT EXISTS members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      member_code TEXT NOT NULL,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      spouse_name TEXT NOT NULL,
      occupation TEXT NOT NULL,
      address TEXT NOT NULL,
      vo_id INTEGER NOT NULL,
      joined_at TEXT NOT NULL,
      risk_note TEXT NOT NULL,
      FOREIGN KEY (vo_id) REFERENCES village_organizations(id)
    );

    CREATE TABLE IF NOT EXISTS loan_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      member_id INTEGER NOT NULL,
      product_name TEXT NOT NULL,
      principal_amount REAL NOT NULL,
      outstanding_amount REAL NOT NULL,
      installment_amount REAL NOT NULL,
      disbursed_at TEXT NOT NULL,
      status TEXT NOT NULL,
      next_due_date TEXT NOT NULL,
      FOREIGN KEY (member_id) REFERENCES members(id)
    );

    CREATE TABLE IF NOT EXISTS loan_schedules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      loan_id INTEGER NOT NULL,
      installment_no INTEGER NOT NULL,
      due_date TEXT NOT NULL,
      due_amount REAL NOT NULL,
      paid_amount REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      FOREIGN KEY (loan_id) REFERENCES loan_accounts(id)
    );

    CREATE TABLE IF NOT EXISTS savings_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      member_id INTEGER NOT NULL,
      product_name TEXT NOT NULL,
      balance REAL NOT NULL,
      weekly_target REAL NOT NULL,
      FOREIGN KEY (member_id) REFERENCES members(id)
    );

    CREATE TABLE IF NOT EXISTS dps_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      member_id INTEGER NOT NULL,
      product_name TEXT NOT NULL,
      balance REAL NOT NULL,
      monthly_target REAL NOT NULL,
      maturity_date TEXT NOT NULL,
      FOREIGN KEY (member_id) REFERENCES members(id)
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      transaction_date TEXT NOT NULL,
      member_id INTEGER NOT NULL,
      vo_id INTEGER NOT NULL,
      staff_id INTEGER NOT NULL,
      product_type TEXT NOT NULL,
      product_id INTEGER NOT NULL,
      transaction_type TEXT NOT NULL,
      amount REAL NOT NULL,
      note TEXT NOT NULL,
      FOREIGN KEY (member_id) REFERENCES members(id),
      FOREIGN KEY (vo_id) REFERENCES village_organizations(id),
      FOREIGN KEY (staff_id) REFERENCES staff(id)
    );

    CREATE TABLE IF NOT EXISTS ai_insights (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      insight_key TEXT NOT NULL,
      staff_id INTEGER NOT NULL,
      role TEXT NOT NULL,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      priority TEXT NOT NULL,
      source TEXT NOT NULL,
      action_label TEXT NOT NULL,
      target TEXT NOT NULL,
      target_id INTEGER,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS ai_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      insight_key TEXT NOT NULL,
      staff_id INTEGER NOT NULL,
      action_type TEXT NOT NULL,
      completed_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ai_chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      staff_id INTEGER NOT NULL,
      role TEXT NOT NULL,
      message TEXT NOT NULL,
      source TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ai_chat_context_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      staff_id INTEGER NOT NULL,
      question TEXT NOT NULL,
      context_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cdo_rank_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      branch_id INTEGER NOT NULL,
      cdo_id INTEGER NOT NULL,
      score REAL NOT NULL,
      rank_no INTEGER NOT NULL,
      calculated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ai_settings (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL
    );

    CREATE VIEW IF NOT EXISTS ai_members AS
      SELECT
        m.id AS member_id,
        m.member_code,
        m.name AS member_name,
        m.phone,
        m.spouse_name,
        m.occupation,
        m.address,
        m.joined_at,
        m.risk_note,
        vo.id AS vo_id,
        vo.code AS vo_code,
        vo.name AS vo_name,
        vo.meeting_day,
        vo.meeting_time,
        vo.area,
        s.id AS cdo_id,
        s.staff_code AS cdo_code,
        s.name AS cdo_name,
        b.id AS branch_id,
        b.code AS branch_code,
        b.name AS branch_name
      FROM members m
      JOIN village_organizations vo ON vo.id = m.vo_id
      JOIN staff s ON s.id = vo.cdo_id
      JOIN branches b ON b.id = vo.branch_id;

    CREATE VIEW IF NOT EXISTS ai_loans AS
      SELECT
        la.id AS loan_id,
        la.member_id,
        m.name AS member_name,
        vo.id AS vo_id,
        vo.name AS vo_name,
        vo.cdo_id,
        s.name AS cdo_name,
        vo.branch_id,
        la.product_name,
        la.principal_amount,
        la.outstanding_amount,
        la.installment_amount,
        la.disbursed_at,
        la.status,
        la.next_due_date
      FROM loan_accounts la
      JOIN members m ON m.id = la.member_id
      JOIN village_organizations vo ON vo.id = m.vo_id
      JOIN staff s ON s.id = vo.cdo_id;

    CREATE VIEW IF NOT EXISTS ai_due_schedules AS
      SELECT
        ls.id AS schedule_id,
        ls.loan_id,
        la.member_id,
        m.name AS member_name,
        vo.id AS vo_id,
        vo.name AS vo_name,
        vo.cdo_id,
        s.name AS cdo_name,
        vo.branch_id,
        la.product_name,
        la.status AS loan_status,
        ls.installment_no,
        ls.due_date,
        ls.due_amount,
        ls.paid_amount,
        (ls.due_amount - ls.paid_amount) AS pending_amount,
        ls.status AS schedule_status,
        CAST(julianday(date('now')) - julianday(ls.due_date) AS INTEGER) AS overdue_days
      FROM loan_schedules ls
      JOIN loan_accounts la ON la.id = ls.loan_id
      JOIN members m ON m.id = la.member_id
      JOIN village_organizations vo ON vo.id = m.vo_id
      JOIN staff s ON s.id = vo.cdo_id;

    CREATE VIEW IF NOT EXISTS ai_savings AS
      SELECT
        m.id AS member_id,
        m.name AS member_name,
        vo.id AS vo_id,
        vo.name AS vo_name,
        vo.cdo_id,
        s.name AS cdo_name,
        vo.branch_id,
        COALESCE(sa.balance, 0) AS savings_balance,
        COALESCE(sa.weekly_target, 0) AS weekly_target,
        COALESCE(da.balance, 0) AS dps_balance,
        COALESCE(da.monthly_target, 0) AS dps_monthly_target,
        da.maturity_date
      FROM members m
      JOIN village_organizations vo ON vo.id = m.vo_id
      JOIN staff s ON s.id = vo.cdo_id
      LEFT JOIN savings_accounts sa ON sa.member_id = m.id
      LEFT JOIN dps_accounts da ON da.member_id = m.id;

    CREATE VIEW IF NOT EXISTS ai_transactions AS
      SELECT
        t.id AS transaction_id,
        t.transaction_date,
        t.member_id,
        m.name AS member_name,
        t.vo_id,
        vo.name AS vo_name,
        vo.cdo_id,
        s.name AS cdo_name,
        vo.branch_id,
        t.staff_id,
        t.product_type,
        t.product_id,
        t.transaction_type,
        t.amount,
        t.note
      FROM transactions t
      JOIN members m ON m.id = t.member_id
      JOIN village_organizations vo ON vo.id = t.vo_id
      JOIN staff s ON s.id = vo.cdo_id;

    CREATE VIEW IF NOT EXISTS ai_cdo_portfolio AS
      SELECT
        s.id AS cdo_id,
        s.staff_code AS cdo_code,
        s.name AS cdo_name,
        s.branch_id,
        COUNT(DISTINCT vo.id) AS vo_count,
        COUNT(DISTINCT m.id) AS member_count,
        COALESCE(SUM(CASE WHEN ls.status != 'PAID' AND ls.due_date <= date('now')
          THEN ls.due_amount - ls.paid_amount ELSE 0 END), 0) AS due_amount,
        COALESCE(SUM(CASE WHEN ls.status != 'PAID' AND ls.due_date < date('now')
          THEN ls.due_amount - ls.paid_amount ELSE 0 END), 0) AS overdue_amount,
        COUNT(DISTINCT CASE WHEN ls.status != 'PAID' AND ls.due_date < date('now') THEN m.id END) AS overdue_members,
        COALESCE(SUM(CASE WHEN t.transaction_date = date('now') THEN t.amount ELSE 0 END), 0) AS collected_today,
        COALESCE(SUM(sa.balance), 0) AS savings_balance,
        COALESCE(SUM(da.balance), 0) AS dps_balance
      FROM staff s
      LEFT JOIN village_organizations vo ON vo.cdo_id = s.id
      LEFT JOIN members m ON m.vo_id = vo.id
      LEFT JOIN loan_accounts la ON la.member_id = m.id
      LEFT JOIN loan_schedules ls ON ls.loan_id = la.id
      LEFT JOIN transactions t ON t.member_id = m.id AND t.vo_id = vo.id
      LEFT JOIN savings_accounts sa ON sa.member_id = m.id
      LEFT JOIN dps_accounts da ON da.member_id = m.id
      WHERE s.role = 'CDO'
      GROUP BY s.id;
  `);

  const seeded = await db.getFirstAsync<{ value: string }>(
    'SELECT value FROM app_meta WHERE key = ?',
    ['seed_version'],
  );

  if (seeded?.value !== SEED_VERSION) {
    await resetAndSeedDatabase();
  } else {
    await refreshLoanStatuses();
  }
}

export async function resetAndSeedDatabase() {
  const db = await getDb();

  await db.execAsync(`
    DELETE FROM transactions;
    DELETE FROM dps_accounts;
    DELETE FROM savings_accounts;
    DELETE FROM loan_schedules;
    DELETE FROM loan_accounts;
    DELETE FROM members;
    DELETE FROM village_organizations;
    DELETE FROM staff;
    DELETE FROM branches;
    DELETE FROM app_meta;

    DELETE FROM sqlite_sequence WHERE name IN (
      'transactions',
      'dps_accounts',
      'savings_accounts',
      'loan_schedules',
      'loan_accounts',
      'members',
      'village_organizations',
      'staff',
      'branches'
    );
  `);

  await seedDemoData(db);
  await db.runAsync('INSERT INTO app_meta (key, value) VALUES (?, ?)', ['seed_version', SEED_VERSION]);
  await refreshLoanStatuses();
}

async function seedDemoData(db: SQLite.SQLiteDatabase) {
  const today = new Date();
  const branch = await db.runAsync(
    'INSERT INTO branches (code, name, district) VALUES (?, ?, ?)',
    ['BR-01', 'Ashulia Branch', 'Dhaka'],
  );

  const bm = await db.runAsync(
    'INSERT INTO staff (staff_code, name, role, pin, branch_id, supervisor_id) VALUES (?, ?, ?, ?, ?, ?)',
    ['BM001', 'Nadia Rahman', 'BM', '1234', branch.lastInsertRowId, null],
  );

  const cdoRows = [
    ['CDO101', 'Farhana Akter', '1111'],
    ['CDO102', 'Mizanur Islam', '2222'],
    ['CDO103', 'Shaila Begum', '3333'],
  ];
  const cdoIds: number[] = [];

  for (const cdo of cdoRows) {
    const result = await db.runAsync(
      'INSERT INTO staff (staff_code, name, role, pin, branch_id, supervisor_id) VALUES (?, ?, ?, ?, ?, ?)',
      [cdo[0], cdo[1], 'CDO', cdo[2], branch.lastInsertRowId, bm.lastInsertRowId],
    );
    cdoIds.push(result.lastInsertRowId);
  }

  const occupations = ['Tailor', 'Dairy farmer', 'Grocery owner', 'Vegetable trader', 'Poultry farmer'];
  const riskNotes = [
    'Reliable repayment history',
    'Seasonal income pattern',
    'Needs close follow-up this month',
    'Strong savings behavior',
    'Recently missed one VO meeting',
  ];
  const names = [
    'Ayesha',
    'Rokeya',
    'Salma',
    'Rina',
    'Nasima',
    'Momena',
    'Jahanara',
    'Khadija',
    'Sufia',
    'Fatema',
    'Parvin',
    'Hasina',
  ];

  let voSerial = 1;
  let memberSerial = 1;

  for (let cdoIndex = 0; cdoIndex < cdoIds.length; cdoIndex += 1) {
    for (let voIndex = 0; voIndex < 4; voIndex += 1) {
      const vo = await db.runAsync(
        `INSERT INTO village_organizations
          (code, name, meeting_day, meeting_time, area, cdo_id, branch_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          `VO-${String(voSerial).padStart(3, '0')}`,
          `Uttoron VO ${voSerial}`,
          weekdayFromOffset(voSerial),
          voIndex % 2 === 0 ? '09:30 AM' : '02:30 PM',
          ['North Para', 'Bazar Road', 'Char Para', 'School Field'][voIndex],
          cdoIds[cdoIndex],
          branch.lastInsertRowId,
        ],
      );

      const memberCount = 16 + ((voIndex + cdoIndex) % 5);
      for (let i = 0; i < memberCount; i += 1) {
        const memberName = `${names[(memberSerial + i) % names.length]} ${['Begum', 'Akter', 'Khatun'][i % 3]}`;
        const member = await db.runAsync(
          `INSERT INTO members
            (member_code, name, phone, spouse_name, occupation, address, vo_id, joined_at, risk_note)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            `M-${String(memberSerial).padStart(5, '0')}`,
            memberName,
            `017${String(30000000 + memberSerial * 37).slice(0, 8)}`,
            ['Rahim', 'Karim', 'Jamal', 'Babul'][i % 4],
            occupations[(i + voIndex) % occupations.length],
            `House ${12 + i}, ${['Ashulia', 'Savar', 'Dhamrai'][cdoIndex]}`,
            vo.lastInsertRowId,
            isoDate(addDays(today, -420 - i * 3)),
            riskNotes[(i + voIndex + cdoIndex) % riskNotes.length],
          ],
        );

        const savings = 800 + (i % 8) * 450 + cdoIndex * 250;
        await db.runAsync(
          'INSERT INTO savings_accounts (member_id, product_name, balance, weekly_target) VALUES (?, ?, ?, ?)',
          [member.lastInsertRowId, 'General Savings', savings, 100 + (i % 3) * 50],
        );

        if (i % 3 === 0) {
          await db.runAsync(
            `INSERT INTO dps_accounts
              (member_id, product_name, balance, monthly_target, maturity_date)
             VALUES (?, ?, ?, ?, ?)`,
            [
              member.lastInsertRowId,
              'DPS 3 Year',
              3000 + i * 600,
              500,
              isoDate(addDays(today, 480 + i * 10)),
            ],
          );
        }

        const hasSecondLoan = i % 7 === 0;
        await createSeedLoan(db, member.lastInsertRowId, today, i, voIndex, 'Micro Enterprise Loan');
        if (hasSecondLoan) {
          await createSeedLoan(db, member.lastInsertRowId, today, i + 3, voIndex, 'Livelihood Loan');
        }

        memberSerial += 1;
      }

      voSerial += 1;
    }
  }

  await seedHistoricalTransactions(db, today);
}

async function createSeedLoan(
  db: SQLite.SQLiteDatabase,
  memberId: number,
  today: Date,
  memberIndex: number,
  voIndex: number,
  productName: string,
) {
  const principal = productName === 'Livelihood Loan' ? 30000 : 50000 + (memberIndex % 4) * 10000;
  const installment = productName === 'Livelihood Loan' ? 1500 : 2200 + (memberIndex % 4) * 400;
  const loan = await db.runAsync(
    `INSERT INTO loan_accounts
      (member_id, product_name, principal_amount, outstanding_amount, installment_amount, disbursed_at, status, next_due_date)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      memberId,
      productName,
      principal,
      principal,
      installment,
      isoDate(addDays(today, -84 - memberIndex)),
      'Current',
      isoDate(addDays(today, 7)),
    ],
  );

  const missedPattern = (memberIndex + voIndex) % 9;
  const missedCount = missedPattern === 0 ? 6 : missedPattern === 1 ? 4 : missedPattern === 2 ? 2 : missedPattern === 3 ? 1 : 0;
  let paidInstallments = 0;

  for (let n = 1; n <= 24; n += 1) {
    const dueDate = isoDate(addDays(today, (n - 10) * 7 + voIndex));
    const isPast = dueDate < isoDate(today);
    const shouldMiss = isPast && n > 9 - missedCount;
    const paid = isPast && !shouldMiss ? installment : 0;
    const status = paid >= installment ? 'PAID' : paid > 0 ? 'PARTIAL' : 'PENDING';

    if (paid > 0) paidInstallments += 1;

    await db.runAsync(
      `INSERT INTO loan_schedules
        (loan_id, installment_no, due_date, due_amount, paid_amount, status)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [loan.lastInsertRowId, n, dueDate, installment, paid, status],
    );
  }

  const outstanding = Math.max(principal - paidInstallments * installment, 0);
  await db.runAsync('UPDATE loan_accounts SET outstanding_amount = ? WHERE id = ?', [
    outstanding,
    loan.lastInsertRowId,
  ]);
}

async function seedHistoricalTransactions(db: SQLite.SQLiteDatabase, today: Date) {
  const rows = await db.getAllAsync<{
    member_id: number;
    vo_id: number;
    cdo_id: number;
    loan_id: number;
    schedule_id: number;
    due_date: string;
    paid_amount: number;
  }>(`
    SELECT
      m.id AS member_id,
      m.vo_id,
      vo.cdo_id,
      la.id AS loan_id,
      ls.id AS schedule_id,
      ls.due_date,
      ls.paid_amount
    FROM loan_schedules ls
    JOIN loan_accounts la ON la.id = ls.loan_id
    JOIN members m ON m.id = la.member_id
    JOIN village_organizations vo ON vo.id = m.vo_id
    WHERE ls.paid_amount > 0
    LIMIT 550
  `);

  for (const row of rows) {
    await db.runAsync(
      `INSERT INTO transactions
        (transaction_date, member_id, vo_id, staff_id, product_type, product_id, transaction_type, amount, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.due_date,
        row.member_id,
        row.vo_id,
        row.cdo_id,
        'LOAN',
        row.loan_id,
        'INSTALLMENT',
        row.paid_amount,
        'Seeded historical installment',
      ],
    );
  }

  const savingsRows = await db.getAllAsync<{
    id: number;
    member_id: number;
    vo_id: number;
    cdo_id: number;
    weekly_target: number;
  }>(`
    SELECT sa.id, sa.member_id, m.vo_id, vo.cdo_id, sa.weekly_target
    FROM savings_accounts sa
    JOIN members m ON m.id = sa.member_id
    JOIN village_organizations vo ON vo.id = m.vo_id
    LIMIT 160
  `);

  for (const row of savingsRows) {
    await db.runAsync(
      `INSERT INTO transactions
        (transaction_date, member_id, vo_id, staff_id, product_type, product_id, transaction_type, amount, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        isoDate(addDays(today, -7 - (row.member_id % 8))),
        row.member_id,
        row.vo_id,
        row.cdo_id,
        'SAVINGS',
        row.id,
        'DEPOSIT',
        row.weekly_target,
        'Seeded savings deposit',
      ],
    );
  }
}

export async function refreshLoanStatuses() {
  const db = await getDb();
  const today = isoDate();
  const loans = await db.getAllAsync<{ id: number }>('SELECT id FROM loan_accounts');

  for (const loan of loans) {
    const overdue = await db.getFirstAsync<CountRow>(
      `SELECT COUNT(*) AS count
       FROM loan_schedules
       WHERE loan_id = ?
         AND due_date < ?
         AND status != 'PAID'`,
      [loan.id, today],
    );
    const next = await db.getFirstAsync<{ due_date: string }>(
      `SELECT due_date
       FROM loan_schedules
       WHERE loan_id = ?
         AND status != 'PAID'
       ORDER BY due_date ASC
       LIMIT 1`,
      [loan.id],
    );

    await db.runAsync('UPDATE loan_accounts SET status = ?, next_due_date = ? WHERE id = ?', [
      calculateStatus(overdue?.count ?? 0),
      next?.due_date ?? today,
      loan.id,
    ]);
  }
}

export async function login(staffCode: string, pin: string) {
  const db = await getDb();
  return db.getFirstAsync<Staff>(
    `SELECT id, staff_code, name, role, pin, branch_id, supervisor_id
     FROM staff
     WHERE UPPER(staff_code) = UPPER(?)
       AND pin = ?`,
    [staffCode.trim(), pin.trim()],
  );
}

export async function getBranch(branchId: number) {
  const db = await getDb();
  return db.getFirstAsync<Branch>('SELECT * FROM branches WHERE id = ?', [branchId]);
}

export async function getCdosForBm(bmId: number) {
  const db = await getDb();
  return db.getAllAsync<Staff>(
    `SELECT id, staff_code, name, role, pin, branch_id, supervisor_id
     FROM staff
     WHERE supervisor_id = ?
     ORDER BY name`,
    [bmId],
  );
}

export async function getCdoVos(cdoId: number) {
  const db = await getDb();
  return db.getAllAsync<VillageOrganization>(
    `SELECT
       vo.*,
       COALESCE(member_stats.member_count, 0) AS member_count,
       COALESCE(due_stats.due_amount, 0) AS due_amount,
       COALESCE(collection_stats.collected_amount, 0) AS collected_amount
     FROM village_organizations vo
     LEFT JOIN (
       SELECT vo_id, COUNT(*) AS member_count
       FROM members
       GROUP BY vo_id
     ) member_stats ON member_stats.vo_id = vo.id
     LEFT JOIN (
       SELECT m.vo_id, SUM(ls.due_amount - ls.paid_amount) AS due_amount
       FROM loan_schedules ls
       JOIN loan_accounts la ON la.id = ls.loan_id
       JOIN members m ON m.id = la.member_id
       WHERE ls.status != 'PAID'
         AND ls.due_date <= date('now')
       GROUP BY m.vo_id
     ) due_stats ON due_stats.vo_id = vo.id
     LEFT JOIN (
       SELECT vo_id, SUM(amount) AS collected_amount
       FROM transactions
       WHERE product_type = 'LOAN'
         AND transaction_date = date('now')
       GROUP BY vo_id
     ) collection_stats ON collection_stats.vo_id = vo.id
     WHERE vo.cdo_id = ?
     ORDER BY vo.meeting_day, vo.name`,
    [cdoId],
  );
}

export async function getVo(voId: number) {
  const db = await getDb();
  return db.getFirstAsync<VillageOrganization>('SELECT * FROM village_organizations WHERE id = ?', [voId]);
}

export async function getVoMembers(voId: number) {
  const db = await getDb();
  return db.getAllAsync<Member>(
    `SELECT
       m.*,
       COUNT(DISTINCT la.id) AS active_loans,
       COALESCE(SUM(CASE WHEN ls.status != 'PAID' AND ls.due_date <= date('now')
         THEN ls.due_amount - ls.paid_amount ELSE 0 END), 0) AS due_amount,
       COALESCE(MAX(sa.balance), 0) AS savings_balance
     FROM members m
     LEFT JOIN loan_accounts la ON la.member_id = m.id AND la.outstanding_amount > 0
     LEFT JOIN loan_schedules ls ON ls.loan_id = la.id
     LEFT JOIN savings_accounts sa ON sa.member_id = m.id
     WHERE m.vo_id = ?
     GROUP BY m.id
     ORDER BY m.name`,
    [voId],
  );
}

export async function getMemberPortfolio(memberId: number): Promise<MemberPortfolio | null> {
  const db = await getDb();
  const member = await db.getFirstAsync<Member>('SELECT * FROM members WHERE id = ?', [memberId]);
  if (!member) return null;

  const loans = await db.getAllAsync<LoanAccount>('SELECT * FROM loan_accounts WHERE member_id = ? ORDER BY id', [
    memberId,
  ]);
  const savings = await db.getAllAsync<SavingsAccount>('SELECT * FROM savings_accounts WHERE member_id = ?', [
    memberId,
  ]);
  const dps = await db.getAllAsync<DpsAccount>('SELECT * FROM dps_accounts WHERE member_id = ?', [memberId]);
  const schedules = await db.getAllAsync<LoanSchedule>(
    `SELECT ls.*
     FROM loan_schedules ls
     JOIN loan_accounts la ON la.id = ls.loan_id
     WHERE la.member_id = ?
     ORDER BY ls.due_date ASC`,
    [memberId],
  );
  const transactions = await db.getAllAsync<Transaction>(
    `SELECT *
     FROM transactions
     WHERE member_id = ?
     ORDER BY transaction_date DESC, id DESC
     LIMIT 40`,
    [memberId],
  );

  return { member, loans, savings, dps, schedules, transactions };
}

export async function getCdoSummary(cdoId: number): Promise<DashboardSummary> {
  const db = await getDb();
  const staffFilter = [cdoId];

  const voCount = await db.getFirstAsync<CountRow>(
    'SELECT COUNT(*) AS count FROM village_organizations WHERE cdo_id = ?',
    staffFilter,
  );
  const memberCount = await db.getFirstAsync<CountRow>(
    `SELECT COUNT(*) AS count
     FROM members m
     JOIN village_organizations vo ON vo.id = m.vo_id
     WHERE vo.cdo_id = ?`,
    staffFilter,
  );
  const target = await sumForStaff(
    `SELECT SUM(ls.due_amount - ls.paid_amount) AS total
     FROM loan_schedules ls
     JOIN loan_accounts la ON la.id = ls.loan_id
     JOIN members m ON m.id = la.member_id
     JOIN village_organizations vo ON vo.id = m.vo_id
     WHERE vo.cdo_id = ?
       AND ls.status != 'PAID'
       AND ls.due_date <= date('now')`,
    staffFilter,
  );
  const overdue = await sumForStaff(
    `SELECT SUM(ls.due_amount - ls.paid_amount) AS total
     FROM loan_schedules ls
     JOIN loan_accounts la ON la.id = ls.loan_id
     JOIN members m ON m.id = la.member_id
     JOIN village_organizations vo ON vo.id = m.vo_id
     WHERE vo.cdo_id = ?
       AND ls.status != 'PAID'
       AND ls.due_date < date('now')`,
    staffFilter,
  );
  const collected = await sumForStaff(
    `SELECT SUM(t.amount) AS total
     FROM transactions t
     WHERE t.staff_id = ?
       AND t.transaction_date = date('now')`,
    staffFilter,
  );
  const savings = await sumForStaff(
    `SELECT SUM(sa.balance) AS total
     FROM savings_accounts sa
     JOIN members m ON m.id = sa.member_id
     JOIN village_organizations vo ON vo.id = m.vo_id
     WHERE vo.cdo_id = ?`,
    staffFilter,
  );
  const dps = await sumForStaff(
    `SELECT SUM(da.balance) AS total
     FROM dps_accounts da
     JOIN members m ON m.id = da.member_id
     JOIN village_organizations vo ON vo.id = m.vo_id
     WHERE vo.cdo_id = ?`,
    staffFilter,
  );
  const statusCounts = await statusMix('vo.cdo_id = ?', staffFilter);

  return {
    members: memberCount?.count ?? 0,
    vos: voCount?.count ?? 0,
    target,
    collected,
    overdue,
    savings,
    dps,
    ...statusCounts,
  };
}

export async function getBranchSummary(branchId: number): Promise<DashboardSummary> {
  const db = await getDb();
  const filter = [branchId];
  const voCount = await db.getFirstAsync<CountRow>(
    'SELECT COUNT(*) AS count FROM village_organizations WHERE branch_id = ?',
    filter,
  );
  const memberCount = await db.getFirstAsync<CountRow>(
    `SELECT COUNT(*) AS count
     FROM members m
     JOIN village_organizations vo ON vo.id = m.vo_id
     WHERE vo.branch_id = ?`,
    filter,
  );
  const target = await sumForStaff(
    `SELECT SUM(ls.due_amount - ls.paid_amount) AS total
     FROM loan_schedules ls
     JOIN loan_accounts la ON la.id = ls.loan_id
     JOIN members m ON m.id = la.member_id
     JOIN village_organizations vo ON vo.id = m.vo_id
     WHERE vo.branch_id = ?
       AND ls.status != 'PAID'
       AND ls.due_date <= date('now')`,
    filter,
  );
  const overdue = await sumForStaff(
    `SELECT SUM(ls.due_amount - ls.paid_amount) AS total
     FROM loan_schedules ls
     JOIN loan_accounts la ON la.id = ls.loan_id
     JOIN members m ON m.id = la.member_id
     JOIN village_organizations vo ON vo.id = m.vo_id
     WHERE vo.branch_id = ?
       AND ls.status != 'PAID'
       AND ls.due_date < date('now')`,
    filter,
  );
  const collected = await sumForStaff(
    `SELECT SUM(t.amount) AS total
     FROM transactions t
     JOIN village_organizations vo ON vo.id = t.vo_id
     WHERE vo.branch_id = ?
       AND t.transaction_date = date('now')`,
    filter,
  );
  const savings = await sumForStaff(
    `SELECT SUM(sa.balance) AS total
     FROM savings_accounts sa
     JOIN members m ON m.id = sa.member_id
     JOIN village_organizations vo ON vo.id = m.vo_id
     WHERE vo.branch_id = ?`,
    filter,
  );
  const dps = await sumForStaff(
    `SELECT SUM(da.balance) AS total
     FROM dps_accounts da
     JOIN members m ON m.id = da.member_id
     JOIN village_organizations vo ON vo.id = m.vo_id
     WHERE vo.branch_id = ?`,
    filter,
  );
  const statusCounts = await statusMix('vo.branch_id = ?', filter);

  return {
    members: memberCount?.count ?? 0,
    vos: voCount?.count ?? 0,
    target,
    collected,
    overdue,
    savings,
    dps,
    ...statusCounts,
  };
}

async function sumForStaff(query: string, params: (number | string)[]) {
  const db = await getDb();
  const row = await db.getFirstAsync<SumRow>(query, params);
  return row?.total ?? 0;
}

async function statusMix(whereClause: string, params: (number | string)[]) {
  const db = await getDb();
  const rows = await db.getAllAsync<{ status: LoanStatus; count: number }>(
    `SELECT la.status, COUNT(*) AS count
     FROM loan_accounts la
     JOIN members m ON m.id = la.member_id
     JOIN village_organizations vo ON vo.id = m.vo_id
     WHERE ${whereClause}
     GROUP BY la.status`,
    params,
  );

  const base = { current: 0, late1: 0, late2: 0, nibl1: 0, nibl2: 0 };
  for (const row of rows) {
    if (row.status === 'Current') base.current = row.count;
    if (row.status === 'Late 1') base.late1 = row.count;
    if (row.status === 'Late 2') base.late2 = row.count;
    if (row.status === 'NIBL 1') base.nibl1 = row.count;
    if (row.status === 'NIBL 2') base.nibl2 = row.count;
  }

  return base;
}

export async function recordCollection(input: {
  memberId: number;
  voId: number;
  staffId: number;
  loanId?: number;
  loanAmount: number;
  savingsId?: number;
  savingsAmount: number;
  dpsId?: number;
  dpsAmount: number;
}) {
  const db = await getDb();
  const today = isoDate();

  if (input.loanId && input.loanAmount > 0) {
    let remaining = input.loanAmount;
    const schedules = await db.getAllAsync<LoanSchedule>(
      `SELECT *
       FROM loan_schedules
       WHERE loan_id = ?
         AND status != 'PAID'
       ORDER BY due_date ASC, installment_no ASC`,
      [input.loanId],
    );

    for (const schedule of schedules) {
      if (remaining <= 0) break;
      const unpaid = schedule.due_amount - schedule.paid_amount;
      const applied = Math.min(unpaid, remaining);
      const paidAmount = schedule.paid_amount + applied;
      const status = paidAmount >= schedule.due_amount ? 'PAID' : 'PARTIAL';

      await db.runAsync('UPDATE loan_schedules SET paid_amount = ?, status = ? WHERE id = ?', [
        paidAmount,
        status,
        schedule.id,
      ]);
      remaining -= applied;
    }

    await db.runAsync(
      `INSERT INTO transactions
        (transaction_date, member_id, vo_id, staff_id, product_type, product_id, transaction_type, amount, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        today,
        input.memberId,
        input.voId,
        input.staffId,
        'LOAN',
        input.loanId,
        'INSTALLMENT',
        input.loanAmount,
        'Field collection',
      ],
    );

    await db.runAsync(
      'UPDATE loan_accounts SET outstanding_amount = MAX(outstanding_amount - ?, 0) WHERE id = ?',
      [input.loanAmount, input.loanId],
    );
  }

  if (input.savingsId && input.savingsAmount > 0) {
    await db.runAsync('UPDATE savings_accounts SET balance = balance + ? WHERE id = ?', [
      input.savingsAmount,
      input.savingsId,
    ]);
    await db.runAsync(
      `INSERT INTO transactions
        (transaction_date, member_id, vo_id, staff_id, product_type, product_id, transaction_type, amount, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        today,
        input.memberId,
        input.voId,
        input.staffId,
        'SAVINGS',
        input.savingsId,
        'DEPOSIT',
        input.savingsAmount,
        'Field savings deposit',
      ],
    );
  }

  if (input.dpsId && input.dpsAmount > 0) {
    await db.runAsync('UPDATE dps_accounts SET balance = balance + ? WHERE id = ?', [
      input.dpsAmount,
      input.dpsId,
    ]);
    await db.runAsync(
      `INSERT INTO transactions
        (transaction_date, member_id, vo_id, staff_id, product_type, product_id, transaction_type, amount, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        today,
        input.memberId,
        input.voId,
        input.staffId,
        'DPS',
        input.dpsId,
        'DEPOSIT',
        input.dpsAmount,
        'Field DPS deposit',
      ],
    );
  }

  await refreshLoanStatuses();
}

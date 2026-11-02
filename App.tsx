import Ionicons from '@expo/vector-icons/Ionicons';
import { StatusBar } from 'expo-status-bar';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import {
  getBranch,
  getBranchSummary,
  getCdoSummary,
  getCdoVos,
  getCdosForBm,
  getMemberPortfolio,
  getVo,
  getVoMembers,
  initDatabase,
  login,
  recordCollection,
  resetAndSeedDatabase,
} from './src/db';
import { answerSmartChat, completeInsight, getAiInsights, getCdoRankings, getChatHistory } from './src/ai';
import { colors } from './src/theme';
import {
  AiActionTarget,
  AiInsight,
  Branch,
  CdoRanking,
  ChatMessage,
  DashboardSummary,
  LoanAccount,
  LoanStatus,
  Member,
  MemberPortfolio,
  Staff,
  VillageOrganization,
} from './src/types';

type IconName = React.ComponentProps<typeof Ionicons>['name'];

type Route =
  | { screen: 'home' }
  | { screen: 'cdo'; cdoId: number }
  | { screen: 'vo'; voId: number }
  | { screen: 'member'; memberId: number }
  | { screen: 'ranking' }
  | { screen: 'chat' };

const demoUsers = [
  { label: 'BM', code: 'BM001', pin: '1234' },
  { label: 'CDO 1', code: 'CDO101', pin: '1111' },
  { label: 'CDO 2', code: 'CDO102', pin: '2222' },
  { label: 'CDO 3', code: 'CDO103', pin: '3333' },
];

export default function App() {
  const [ready, setReady] = useState(false);
  const [user, setUser] = useState<Staff | null>(null);
  const [useLocalAi, setUseLocalAi] = useState(true);
  const [routes, setRoutes] = useState<Route[]>([{ screen: 'home' }]);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    initDatabase()
      .then(() => setReady(true))
      .catch((error) => {
        console.error(error);
        Alert.alert('Database error', 'Could not initialize the local database.');
      });
  }, []);

  const route = routes[routes.length - 1];

  const push = useCallback((next: Route) => {
    setRoutes((current) => [...current, next]);
  }, []);

  const back = useCallback(() => {
    setRoutes((current) => (current.length > 1 ? current.slice(0, -1) : current));
  }, []);

  const logout = useCallback(() => {
    setUser(null);
    setRoutes([{ screen: 'home' }]);
  }, []);

  const openAiTarget = useCallback(
    (target: AiActionTarget, targetId: number | null) => {
      if (target === 'vo' && targetId) push({ screen: 'vo', voId: targetId });
      if (target === 'member' && targetId) push({ screen: 'member', memberId: targetId });
      if (target === 'cdo' && targetId) push({ screen: 'cdo', cdoId: targetId });
      if (target === 'ranking') push({ screen: 'ranking' });
      if (target === 'chat') push({ screen: 'chat' });
      if (target === 'home') setRoutes([{ screen: 'home' }]);
    },
    [push],
  );

  if (!ready) {
    return (
      <SafeAreaView style={styles.centerScreen}>
        <StatusBar style="dark" />
        <ActivityIndicator color={colors.primary} size="large" />
        <Text style={styles.loadingText}>Preparing offline portfolio...</Text>
      </SafeAreaView>
    );
  }

  if (!user) {
    return (
      <LoginScreen
        onLogin={(nextUser, nextUseLocalAi) => {
          setUser(nextUser);
          setUseLocalAi(nextUseLocalAi);
          setRoutes([{ screen: 'home' }]);
        }}
        onReset={async () => {
          await resetAndSeedDatabase();
          Alert.alert('Demo data reset', 'The local branch portfolio has been recreated.');
        }}
      />
    );
  }

  return (
    <SafeAreaView style={styles.app}>
      <StatusBar style="dark" />
      <AppHeader user={user} canGoBack={routes.length > 1} onBack={back} onLogout={logout} />
      {route.screen === 'home' && user.role === 'CDO' ? (
        <CdoHome
          cdo={user}
          reloadKey={reloadKey}
          onOpenAiTarget={openAiTarget}
          onOpenRanking={() => push({ screen: 'ranking' })}
          onOpenChat={() => push({ screen: 'chat' })}
          onOpenVo={(voId) => push({ screen: 'vo', voId })}
        />
      ) : null}
      {route.screen === 'home' && user.role === 'BM' ? (
        <BmHome
          bm={user}
          reloadKey={reloadKey}
          onOpenAiTarget={openAiTarget}
          onOpenRanking={() => push({ screen: 'ranking' })}
          onOpenChat={() => push({ screen: 'chat' })}
          onOpenCdo={(cdoId) => push({ screen: 'cdo', cdoId })}
        />
      ) : null}
      {route.screen === 'cdo' ? (
        <CdoDetail
          cdoId={route.cdoId}
          reloadKey={reloadKey}
          onOpenVo={(voId) => push({ screen: 'vo', voId })}
        />
      ) : null}
      {route.screen === 'vo' ? (
        <VoDetail
          voId={route.voId}
          reloadKey={reloadKey}
          onOpenMember={(memberId) => push({ screen: 'member', memberId })}
        />
      ) : null}
      {route.screen === 'member' ? (
        <MemberDetail
          memberId={route.memberId}
          user={user}
          reloadKey={reloadKey}
          onPosted={() => setReloadKey((value) => value + 1)}
        />
      ) : null}
      {route.screen === 'ranking' ? <RankingScreen user={user} /> : null}
      {route.screen === 'chat' ? <ChatScreen user={user} useLocalAi={useLocalAi} onOpenAiTarget={openAiTarget} /> : null}
    </SafeAreaView>
  );
}

function LoginScreen({
  onLogin,
  onReset,
}: {
  onLogin: (staff: Staff, useLocalAi: boolean) => void;
  onReset: () => Promise<void>;
}) {
  const [staffCode, setStaffCode] = useState('CDO101');
  const [pin, setPin] = useState('1111');
  const [useLocalAi, setUseLocalAi] = useState(true);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      const staff = await login(staffCode, pin);
      if (!staff) {
        Alert.alert('Login failed', 'Use one of the demo staff IDs and PINs.');
        return;
      }
      onLogin(staff, useLocalAi);
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={styles.loginShell}>
      <StatusBar style="light" />
      <View style={styles.loginHero}>
        <View style={styles.logoMark}>
          <Ionicons name="cash-outline" size={30} color="#FFFFFF" />
        </View>
        <Text style={styles.loginTitle}>Field Collection</Text>
        <Text style={styles.loginSubtitle}>Offline microfinance portfolio for CDO and BM teams</Text>
      </View>

      <View style={styles.loginPanel}>
        <Text style={styles.inputLabel}>Staff ID</Text>
        <TextInput
          value={staffCode}
          onChangeText={setStaffCode}
          autoCapitalize="characters"
          placeholder="CDO101"
          style={styles.input}
        />
        <Text style={styles.inputLabel}>PIN</Text>
        <TextInput
          value={pin}
          onChangeText={setPin}
          secureTextEntry
          keyboardType="number-pad"
          placeholder="1111"
          style={styles.input}
        />
        <View style={styles.aiModeCard}>
          <View style={styles.aiModeCopy}>
            <Text style={styles.aiModeTitle}>Use Local AI</Text>
            <Text style={styles.aiModeText}>
              {useLocalAi
                ? 'LLM will create SQL, local DB will run it, then LLM will write the answer.'
                : 'Use the faster offline/local fallback assistant.'}
            </Text>
          </View>
          <Switch
            value={useLocalAi}
            onValueChange={setUseLocalAi}
            trackColor={{ false: colors.line, true: colors.surfaceAlt }}
            thumbColor={useLocalAi ? colors.primary : colors.muted}
          />
        </View>
        <PrimaryButton icon="log-in-outline" label={busy ? 'Checking...' : 'Login'} onPress={submit} disabled={busy} />

        <Text style={styles.smallSectionTitle}>Demo access</Text>
        <View style={styles.quickGrid}>
          {demoUsers.map((demo) => (
            <Pressable
              key={demo.code}
              style={styles.quickLogin}
              onPress={() => {
                setStaffCode(demo.code);
                setPin(demo.pin);
              }}
            >
              <Text style={styles.quickLoginRole}>{demo.label}</Text>
              <Text style={styles.quickLoginCode}>{demo.code}</Text>
            </Pressable>
          ))}
        </View>

        <Pressable style={styles.resetButton} onPress={onReset}>
          <Ionicons name="refresh-outline" size={18} color={colors.primary} />
          <Text style={styles.resetText}>Reset demo data</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

function AppHeader({
  user,
  canGoBack,
  onBack,
  onLogout,
}: {
  user: Staff;
  canGoBack: boolean;
  onBack: () => void;
  onLogout: () => void;
}) {
  return (
    <View style={styles.header}>
      <Pressable style={[styles.iconButton, !canGoBack && styles.iconButtonGhost]} onPress={onBack} disabled={!canGoBack}>
        <Ionicons name="chevron-back" size={22} color={canGoBack ? colors.ink : colors.surface} />
      </Pressable>
      <View style={styles.headerIdentity}>
        <Text style={styles.headerName}>{user.name}</Text>
        <Text style={styles.headerMeta}>
          {user.role} - {user.staff_code}
        </Text>
      </View>
      <Pressable style={styles.iconButton} onPress={onLogout}>
        <Ionicons name="exit-outline" size={20} color={colors.ink} />
      </Pressable>
    </View>
  );
}

function CdoHome({
  cdo,
  reloadKey,
  onOpenAiTarget,
  onOpenRanking,
  onOpenChat,
  onOpenVo,
}: {
  cdo: Staff;
  reloadKey: number;
  onOpenAiTarget: (target: AiActionTarget, targetId: number | null) => void;
  onOpenRanking: () => void;
  onOpenChat: () => void;
  onOpenVo: (voId: number) => void;
}) {
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [vos, setVos] = useState<VillageOrganization[]>([]);
  const [insights, setInsights] = useState<AiInsight[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    Promise.all([getCdoSummary(cdo.id), getCdoVos(cdo.id), getAiInsights(cdo)])
      .then(([nextSummary, nextVos, nextInsights]) => {
        setSummary(nextSummary);
        setVos(nextVos);
        setInsights(nextInsights);
      })
      .finally(() => setLoading(false));
  }, [cdo, cdo.id, reloadKey]);

  if (loading || !summary) return <LoadingBlock />;

  const today = new Date().toLocaleDateString(undefined, { weekday: 'long' });
  const todayVos = vos.filter((vo) => vo.meeting_day === today);

  return (
    <ScrollView contentContainerStyle={styles.scrollContent}>
      <Text style={styles.screenTitle}>CDO portfolio</Text>
      <Text style={styles.screenCaption}>Today is {today}. Focus on due collections and risk follow-up.</Text>
      <AiInsightPanel
        user={cdo}
        insights={insights}
        onOpenTarget={onOpenAiTarget}
        onCompleted={() => getAiInsights(cdo).then(setInsights)}
      />
      <DashboardActions onOpenRanking={onOpenRanking} onOpenChat={onOpenChat} />
      <SummaryGrid summary={summary} />
      <RiskStrip summary={summary} />

      <SectionTitle title="Today VO" actionText={`${todayVos.length} scheduled`} />
      {(todayVos.length > 0 ? todayVos : vos.slice(0, 2)).map((vo) => (
        <VoCard key={vo.id} vo={vo} onPress={() => onOpenVo(vo.id)} />
      ))}

      <SectionTitle title="All assigned VOs" />
      {vos.map((vo) => (
        <VoRow key={vo.id} vo={vo} onPress={() => onOpenVo(vo.id)} />
      ))}
    </ScrollView>
  );
}

function BmHome({
  bm,
  reloadKey,
  onOpenAiTarget,
  onOpenRanking,
  onOpenChat,
  onOpenCdo,
}: {
  bm: Staff;
  reloadKey: number;
  onOpenAiTarget: (target: AiActionTarget, targetId: number | null) => void;
  onOpenRanking: () => void;
  onOpenChat: () => void;
  onOpenCdo: (cdoId: number) => void;
}) {
  const [branch, setBranch] = useState<Branch | null>(null);
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [cdos, setCdos] = useState<Staff[]>([]);
  const [insights, setInsights] = useState<AiInsight[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    Promise.all([getBranch(bm.branch_id), getBranchSummary(bm.branch_id), getCdosForBm(bm.id), getAiInsights(bm)])
      .then(([nextBranch, nextSummary, nextCdos, nextInsights]) => {
        setBranch(nextBranch);
        setSummary(nextSummary);
        setCdos(nextCdos);
        setInsights(nextInsights);
      })
      .finally(() => setLoading(false));
  }, [bm, bm.branch_id, bm.id, reloadKey]);

  if (loading || !summary) return <LoadingBlock />;

  return (
    <ScrollView contentContainerStyle={styles.scrollContent}>
      <Text style={styles.screenTitle}>{branch?.name ?? 'Branch'} dashboard</Text>
      <Text style={styles.screenCaption}>Branch-wide portfolio, risk mix, and CDO supervision view.</Text>
      <AiInsightPanel
        user={bm}
        insights={insights}
        onOpenTarget={onOpenAiTarget}
        onCompleted={() => getAiInsights(bm).then(setInsights)}
      />
      <DashboardActions onOpenRanking={onOpenRanking} onOpenChat={onOpenChat} />
      <SummaryGrid summary={summary} />
      <RiskStrip summary={summary} />

      <SectionTitle title="CDO supervision" actionText={`${cdos.length} officers`} />
      {cdos.map((cdo) => (
        <CdoCard key={cdo.id} cdo={cdo} onPress={() => onOpenCdo(cdo.id)} />
      ))}
    </ScrollView>
  );
}

function CdoDetail({
  cdoId,
  reloadKey,
  onOpenVo,
}: {
  cdoId: number;
  reloadKey: number;
  onOpenVo: (voId: number) => void;
}) {
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [vos, setVos] = useState<VillageOrganization[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    Promise.all([getCdoSummary(cdoId), getCdoVos(cdoId)])
      .then(([nextSummary, nextVos]) => {
        setSummary(nextSummary);
        setVos(nextVos);
      })
      .finally(() => setLoading(false));
  }, [cdoId, reloadKey]);

  if (loading || !summary) return <LoadingBlock />;

  return (
    <ScrollView contentContainerStyle={styles.scrollContent}>
      <Text style={styles.screenTitle}>CDO detail</Text>
      <Text style={styles.screenCaption}>VO coverage and collection health for this officer.</Text>
      <SummaryGrid summary={summary} />
      <RiskStrip summary={summary} />
      <SectionTitle title="VOs under this CDO" />
      {vos.map((vo) => (
        <VoCard key={vo.id} vo={vo} onPress={() => onOpenVo(vo.id)} />
      ))}
    </ScrollView>
  );
}

function VoDetail({
  voId,
  reloadKey,
  onOpenMember,
}: {
  voId: number;
  reloadKey: number;
  onOpenMember: (memberId: number) => void;
}) {
  const [vo, setVo] = useState<VillageOrganization | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    Promise.all([getVo(voId), getVoMembers(voId)])
      .then(([nextVo, nextMembers]) => {
        setVo(nextVo);
        setMembers(nextMembers);
      })
      .finally(() => setLoading(false));
  }, [voId, reloadKey]);

  if (loading || !vo) return <LoadingBlock />;

  const dueTotal = members.reduce((sum, member) => sum + (member.due_amount ?? 0), 0);

  return (
    <ScrollView contentContainerStyle={styles.scrollContent}>
      <View style={styles.titleRow}>
        <View>
          <Text style={styles.screenTitle}>{vo.name}</Text>
          <Text style={styles.screenCaption}>
            {vo.meeting_day}, {vo.meeting_time} - {vo.area}
          </Text>
        </View>
        <StatusPill label={vo.code} tone="info" />
      </View>

      <View style={styles.metricRow}>
        <MetricCard label="Members" value={String(members.length)} icon="people-outline" />
        <MetricCard label="Due" value={money(dueTotal)} icon="calendar-outline" tone="warning" />
      </View>

      <SectionTitle title="Members" actionText="Tap to collect" />
      {members.map((member) => (
        <MemberRow key={member.id} member={member} onPress={() => onOpenMember(member.id)} />
      ))}
    </ScrollView>
  );
}

function MemberDetail({
  memberId,
  user,
  reloadKey,
  onPosted,
}: {
  memberId: number;
  user: Staff;
  reloadKey: number;
  onPosted: () => void;
}) {
  const [portfolio, setPortfolio] = useState<MemberPortfolio | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    getMemberPortfolio(memberId)
      .then(setPortfolio)
      .finally(() => setLoading(false));
  }, [memberId]);

  useEffect(() => {
    load();
  }, [load, reloadKey]);

  if (loading || !portfolio) return <LoadingBlock />;

  const due = portfolio.schedules
    .filter((schedule) => schedule.status !== 'PAID' && schedule.due_date <= new Date().toISOString().slice(0, 10))
    .reduce((sum, schedule) => sum + schedule.due_amount - schedule.paid_amount, 0);
  const totalSavings = portfolio.savings.reduce((sum, account) => sum + account.balance, 0);
  const totalDps = portfolio.dps.reduce((sum, account) => sum + account.balance, 0);

  return (
    <ScrollView contentContainerStyle={styles.scrollContent}>
      <View style={styles.memberHero}>
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>{portfolio.member.name.slice(0, 1)}</Text>
        </View>
        <View style={styles.memberHeroText}>
          <Text style={styles.screenTitle}>{portfolio.member.name}</Text>
          <Text style={styles.screenCaption}>{portfolio.member.member_code}</Text>
          <Text style={styles.memberMeta}>{portfolio.member.occupation}</Text>
        </View>
      </View>

      <View style={styles.metricRow}>
        <MetricCard label="Due now" value={money(due)} icon="alert-circle-outline" tone={due > 0 ? 'warning' : 'success'} />
        <MetricCard label="Savings" value={money(totalSavings + totalDps)} icon="wallet-outline" tone="success" />
      </View>

      <View style={styles.profileBlock}>
        <InfoLine icon="call-outline" label="Phone" value={portfolio.member.phone} />
        <InfoLine icon="home-outline" label="Address" value={portfolio.member.address} />
        <InfoLine icon="pulse-outline" label="Risk note" value={portfolio.member.risk_note} />
      </View>

      <SectionTitle title="Collection" actionText={user.role === 'BM' ? 'View only for BM' : 'Offline post'} />
      {user.role === 'CDO' ? (
        <CollectionForm portfolio={portfolio} staffId={user.id} onPosted={() => {
          onPosted();
          load();
        }} />
      ) : (
        <View style={styles.notice}>
          <Ionicons name="eye-outline" size={18} color={colors.primary} />
          <Text style={styles.noticeText}>BM can inspect behavior in this MVP. Field posting is reserved for CDO login.</Text>
        </View>
      )}

      <SectionTitle title="Loan products" />
      {portfolio.loans.map((loan) => (
        <LoanCard key={loan.id} loan={loan} schedules={portfolio.schedules.filter((item) => item.loan_id === loan.id)} />
      ))}

      <SectionTitle title="Savings and DPS" />
      {portfolio.savings.map((account) => (
        <ProductRow
          key={`savings-${account.id}`}
          icon="wallet-outline"
          title={account.product_name}
          subtitle={`Weekly target ${money(account.weekly_target)}`}
          value={money(account.balance)}
        />
      ))}
      {portfolio.dps.map((account) => (
        <ProductRow
          key={`dps-${account.id}`}
          icon="trending-up-outline"
          title={account.product_name}
          subtitle={`Monthly target ${money(account.monthly_target)} - Matures ${account.maturity_date}`}
          value={money(account.balance)}
        />
      ))}

      <SectionTitle title="Recent transactions" />
      {portfolio.transactions.length === 0 ? (
        <EmptyState text="No transaction history yet." />
      ) : (
        portfolio.transactions.map((transaction) => <TransactionRow key={transaction.id} transaction={transaction} />)
      )}
    </ScrollView>
  );
}

function CollectionForm({
  portfolio,
  staffId,
  onPosted,
}: {
  portfolio: MemberPortfolio;
  staffId: number;
  onPosted: () => void;
}) {
  const firstLoan = portfolio.loans.find((loan) => loan.outstanding_amount > 0) ?? portfolio.loans[0];
  const [loanId, setLoanId] = useState(firstLoan?.id);
  const selectedLoan = portfolio.loans.find((loan) => loan.id === loanId);
  const firstSavings = portfolio.savings[0];
  const firstDps = portfolio.dps[0];
  const [loanAmount, setLoanAmount] = useState(selectedLoan ? String(selectedLoan.installment_amount) : '0');
  const [savingsAmount, setSavingsAmount] = useState(firstSavings ? String(firstSavings.weekly_target) : '0');
  const [dpsAmount, setDpsAmount] = useState(firstDps ? String(firstDps.monthly_target) : '0');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (selectedLoan) {
      setLoanAmount(String(selectedLoan.installment_amount));
    }
  }, [selectedLoan?.id]);

  async function submit() {
    const loanValue = toNumber(loanAmount);
    const savingsValue = toNumber(savingsAmount);
    const dpsValue = toNumber(dpsAmount);

    if (loanValue + savingsValue + dpsValue <= 0) {
      Alert.alert('Amount needed', 'Enter at least one collection amount.');
      return;
    }

    setBusy(true);
    try {
      await recordCollection({
        memberId: portfolio.member.id,
        voId: portfolio.member.vo_id,
        staffId,
        loanId,
        loanAmount: loanValue,
        savingsId: firstSavings?.id,
        savingsAmount: savingsValue,
        dpsId: firstDps?.id,
        dpsAmount: dpsValue,
      });
      Alert.alert('Collection posted', 'The offline transaction was saved locally.');
      onPosted();
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.collectionBox}>
      {portfolio.loans.length > 1 ? (
        <View style={styles.segmentRow}>
          {portfolio.loans.map((loan) => (
            <Pressable
              key={loan.id}
              style={[styles.segment, loan.id === loanId && styles.segmentActive]}
              onPress={() => setLoanId(loan.id)}
            >
              <Text style={[styles.segmentText, loan.id === loanId && styles.segmentTextActive]}>
                {loan.product_name.replace(' Loan', '')}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}

      <AmountInput label="Loan installment" value={loanAmount} onChangeText={setLoanAmount} />
      <AmountInput label="Savings deposit" value={savingsAmount} onChangeText={setSavingsAmount} />
      <AmountInput label="DPS deposit" value={dpsAmount} onChangeText={setDpsAmount} disabled={!firstDps} />
      <PrimaryButton icon="checkmark-circle-outline" label={busy ? 'Posting...' : 'Post collection'} onPress={submit} disabled={busy} />
    </View>
  );
}

function AiInsightPanel({
  user,
  insights,
  onOpenTarget,
  onCompleted,
}: {
  user: Staff;
  insights: AiInsight[];
  onOpenTarget: (target: AiActionTarget, targetId: number | null) => void;
  onCompleted: () => void;
}) {
  const visibleInsights = insights.slice(0, 4);

  if (visibleInsights.length === 0) {
    return null;
  }

  return (
    <View style={styles.aiPanel}>
      <View style={styles.aiPanelHeader}>
        <View style={styles.aiSpark}>
          <Ionicons name="sparkles-outline" size={19} color="#FFFFFF" />
        </View>
        <View style={styles.flex}>
          <Text style={styles.aiPanelTitle}>AI field assistant</Text>
          <Text style={styles.aiPanelSub}>Offline supervisor guidance from local portfolio data</Text>
        </View>
      </View>
      {visibleInsights.map((insight) => (
        <View key={insight.key} style={[styles.aiCard, insight.completed && styles.aiCardCompleted]}>
          <View style={styles.cardTopRow}>
            <View style={styles.flex}>
              <Text style={styles.aiCardTitle}>{insight.title}</Text>
              <Text style={styles.aiCardMessage}>{insight.message}</Text>
            </View>
            <StatusPill label={insight.source} tone={insight.priority === 'success' ? 'success' : 'info'} />
          </View>
          <View style={styles.aiActionRow}>
            <Pressable
              style={styles.secondaryActionButton}
              onPress={() => onOpenTarget(insight.target, insight.target_id)}
            >
              <Text style={styles.secondaryActionText}>{insight.action_label}</Text>
              <Ionicons name="arrow-forward" size={15} color={colors.primary} />
            </Pressable>
            <Pressable
              style={[styles.completeButton, insight.completed && styles.completeButtonDone]}
              onPress={async () => {
                if (!insight.completed) {
                  await completeInsight(user.id, insight.key);
                  onCompleted();
                }
              }}
            >
              <Ionicons
                name={insight.completed ? 'checkmark-circle' : 'checkmark-circle-outline'}
                size={17}
                color={insight.completed ? colors.success : colors.muted}
              />
              <Text style={[styles.completeText, insight.completed && styles.completeTextDone]}>
                {insight.completed ? 'Done' : 'Complete'}
              </Text>
            </Pressable>
          </View>
        </View>
      ))}
    </View>
  );
}

function DashboardActions({ onOpenRanking, onOpenChat }: { onOpenRanking: () => void; onOpenChat: () => void }) {
  return (
    <View style={styles.dashboardActions}>
      <Pressable style={styles.actionTile} onPress={onOpenRanking}>
        <Ionicons name="podium-outline" size={20} color={colors.primary} />
        <Text style={styles.actionTileText}>CDO ranking</Text>
      </Pressable>
      <Pressable style={styles.actionTile} onPress={onOpenChat}>
        <Ionicons name="chatbubbles-outline" size={20} color={colors.primary} />
        <Text style={styles.actionTileText}>AI সহকারী</Text>
      </Pressable>
    </View>
  );
}

function RankingScreen({ user }: { user: Staff }) {
  const [rankings, setRankings] = useState<CdoRanking[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getCdoRankings(user.branch_id)
      .then(setRankings)
      .finally(() => setLoading(false));
  }, [user.branch_id]);

  if (loading) return <LoadingBlock />;

  const myRank = rankings.find((ranking) => ranking.cdo_id === user.id);

  return (
    <ScrollView contentContainerStyle={styles.scrollContent}>
      <Text style={styles.screenTitle}>CDO ranking</Text>
      <Text style={styles.screenCaption}>Performance comparison using collection, overdue risk, and savings behavior.</Text>
      {user.role === 'CDO' && myRank ? (
        <View style={styles.myRankCard}>
          <Text style={styles.myRankLabel}>Your rank</Text>
          <Text style={styles.myRankValue}>#{myRank.rank}</Text>
          <Text style={styles.myRankAdvice}>{myRank.advice}</Text>
        </View>
      ) : null}
      {rankings.map((ranking) => (
        <RankingCard key={ranking.cdo_id} ranking={ranking} isMe={ranking.cdo_id === user.id} />
      ))}
    </ScrollView>
  );
}

function RankingCard({ ranking, isMe }: { ranking: CdoRanking; isMe: boolean }) {
  return (
    <View style={[styles.rankingCard, isMe && styles.rankingCardMe]}>
      <View style={styles.rankingTopRow}>
        <View style={styles.rankBadge}>
          <Text style={styles.rankBadgeText}>#{ranking.rank}</Text>
        </View>
        <View style={styles.flex}>
          <Text style={styles.cardTitle}>{ranking.name}</Text>
          <Text style={styles.cardSub}>
            {ranking.staff_code} - Score {ranking.score}
          </Text>
        </View>
        <StatusPill label={`${ranking.collection_rate}%`} tone={ranking.collection_rate >= 80 ? 'success' : 'warning'} />
      </View>
      <View style={styles.cardStatsRow}>
        <MiniStat label="Overdue" value={money(ranking.overdue_amount)} />
        <MiniStat label="Risk members" value={String(ranking.overdue_members)} />
        <MiniStat label="Risk accts" value={String(ranking.risk_accounts)} />
      </View>
      <Text style={styles.rankingAdvice}>{ranking.advice}</Text>
    </View>
  );
}

function ChatScreen({
  user,
  useLocalAi,
  onOpenAiTarget,
}: {
  user: Staff;
  useLocalAi: boolean;
  onOpenAiTarget: (target: AiActionTarget, targetId: number | null) => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getChatHistory(user.id).then((history) => {
      if (history.length > 0) {
        setMessages(history);
      } else {
        setMessages([
          {
            id: 'welcome',
            role: 'assistant',
            text: 'আজকের আদায়, ঝুঁকিপূর্ণ সদস্য, VO অগ্রাধিকার, CDO র‍্যাংকিং, সঞ্চয় বা ঋণ বিতরণ সম্পর্কে প্রশ্ন করুন। সংযোগ থাকলে আমি online LLM ব্যবহার করব, না থাকলে স্থানীয় ডাটা থেকে উত্তর দেব।',
            created_at: new Date().toISOString(),
            source: 'offline',
          },
        ]);
      }
    });
  }, [user.id]);

  async function ask() {
    const trimmed = question.trim();
    if (!trimmed) return;
    const userMessage: ChatMessage = {
      id: `${Date.now()}-user`,
      role: 'user',
      text: trimmed,
      created_at: new Date().toISOString(),
      source: 'offline',
    };
    setMessages((current) => [...current, userMessage]);
    setQuestion('');
    setBusy(true);
    try {
      const answer = await answerSmartChat(user, trimmed, useLocalAi);
      setMessages((current) => [...current, answer]);
    } finally {
      setBusy(false);
    }
  }

  const suggestions = user.role === 'BM'
    ? ['কোন CDO সহায়তা দরকার?', 'শাখার ঝুঁকি দেখান', 'পারফরম্যান্স তুলনা করুন']
    : ['আজ কোথায় ফোকাস করব?', 'ঝুঁকিপূর্ণ সদস্য কারা?', 'সঞ্চয় কীভাবে বাড়াব?'];

  return (
    <KeyboardAvoidingView
      style={styles.chatShell}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 86 : 0}
    >
      <ScrollView contentContainerStyle={styles.chatContent} keyboardShouldPersistTaps="handled">
        <Text style={styles.screenTitle}>AI সহকারী</Text>
        <Text style={styles.screenCaption}>গেটওয়ে পাওয়া গেলে online LLM উত্তর দেবে। সংযোগ না থাকলেও স্থানীয় ডাটা থেকে উত্তর পাওয়া যাবে।</Text>
        <View style={styles.chatModeBanner}>
          <Ionicons name={useLocalAi ? 'hardware-chip-outline' : 'phone-portrait-outline'} size={16} color={colors.primary} />
          <Text style={styles.chatModeText}>
            {useLocalAi
              ? 'LLM SQL mode: prompt to LLM, SQL runs locally, final answer from LLM.'
              : 'Offline/local mode: faster fallback answers from local rules.'}
          </Text>
        </View>
        <View style={styles.suggestionRow}>
          {suggestions.map((item) => (
            <Pressable key={item} style={styles.suggestionChip} onPress={() => setQuestion(item)}>
              <Text style={styles.suggestionText}>{item}</Text>
            </Pressable>
          ))}
        </View>
        {messages.map((message) => (
          <View
            key={message.id}
            style={[styles.chatBubble, message.role === 'user' ? styles.chatBubbleUser : styles.chatBubbleAssistant]}
          >
            <Text style={[styles.chatText, message.role === 'user' && styles.chatTextUser]}>{message.text}</Text>
            <Text style={[styles.chatSource, message.role === 'user' && styles.chatSourceUser]}>{message.source}</Text>
          </View>
        ))}
        {busy ? <ActivityIndicator color={colors.primary} style={styles.chatBusy} /> : null}
      </ScrollView>
      <View style={styles.chatInputBar}>
        <TextInput
          value={question}
          onChangeText={setQuestion}
          placeholder="পোর্টফোলিও সম্পর্কে প্রশ্ন করুন..."
          style={styles.chatInput}
          multiline
          textAlignVertical="top"
        />
        <Pressable style={styles.sendButton} onPress={ask} disabled={busy}>
          <Ionicons name="send" size={19} color="#FFFFFF" />
        </Pressable>
      </View>
      <Pressable style={styles.chatShortcut} onPress={() => onOpenAiTarget('ranking', null)}>
        <Ionicons name="podium-outline" size={16} color={colors.primary} />
        <Text style={styles.chatShortcutText}>Open ranking</Text>
      </Pressable>
    </KeyboardAvoidingView>
  );
}

function AmountInput({
  label,
  value,
  onChangeText,
  disabled,
}: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <View style={[styles.amountRow, disabled && styles.disabledRow]}>
      <Text style={styles.amountLabel}>{label}</Text>
      <TextInput
        value={disabled ? '0' : value}
        onChangeText={onChangeText}
        editable={!disabled}
        keyboardType="numeric"
        style={styles.amountInput}
      />
    </View>
  );
}

function SummaryGrid({ summary }: { summary: DashboardSummary }) {
  return (
    <View>
      <View style={styles.metricRow}>
        <MetricCard label="Members" value={String(summary.members)} icon="people-outline" />
        <MetricCard label="VOs" value={String(summary.vos)} icon="map-outline" />
      </View>
      <View style={styles.metricRow}>
        <MetricCard label="Due target" value={money(summary.target)} icon="flag-outline" tone="warning" />
        <MetricCard label="Collected" value={money(summary.collected)} icon="cash-outline" tone="success" />
      </View>
      <View style={styles.metricRow}>
        <MetricCard label="Overdue" value={money(summary.overdue)} icon="warning-outline" tone="danger" />
        <MetricCard label="Savings/DPS" value={money(summary.savings + summary.dps)} icon="wallet-outline" tone="info" />
      </View>
    </View>
  );
}

function RiskStrip({ summary }: { summary: DashboardSummary }) {
  return (
    <View style={styles.riskStrip}>
      <StatusPill label={`Current ${summary.current}`} tone="success" />
      <StatusPill label={`Late 1 ${summary.late1}`} tone="warning" />
      <StatusPill label={`Late 2 ${summary.late2}`} tone="warning" />
      <StatusPill label={`NIBL 1 ${summary.nibl1}`} tone="danger" />
      <StatusPill label={`NIBL 2 ${summary.nibl2}`} tone="danger" />
    </View>
  );
}

function MetricCard({
  label,
  value,
  icon,
  tone = 'default',
}: {
  label: string;
  value: string;
  icon: IconName;
  tone?: 'default' | 'success' | 'warning' | 'danger' | 'info';
}) {
  return (
    <View style={styles.metricCard}>
      <View style={[styles.metricIcon, toneStyle(tone).soft]}>
        <Ionicons name={icon} size={18} color={toneStyle(tone).ink} />
      </View>
      <Text style={styles.metricValue} numberOfLines={1} adjustsFontSizeToFit>
        {value}
      </Text>
      <Text style={styles.metricLabel}>{label}</Text>
    </View>
  );
}

function SectionTitle({ title, actionText }: { title: string; actionText?: string }) {
  return (
    <View style={styles.sectionTitleRow}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {actionText ? <Text style={styles.sectionAction}>{actionText}</Text> : null}
    </View>
  );
}

function VoCard({ vo, onPress }: { vo: VillageOrganization; onPress: () => void }) {
  return (
    <Pressable style={styles.voCard} onPress={onPress}>
      <View style={styles.cardTopRow}>
        <View>
          <Text style={styles.cardTitle}>{vo.name}</Text>
          <Text style={styles.cardSub}>
            {vo.meeting_day}, {vo.meeting_time}
          </Text>
        </View>
        <StatusPill label={vo.code} tone="info" />
      </View>
      <View style={styles.cardStatsRow}>
        <MiniStat label="Members" value={String(vo.member_count ?? 0)} />
        <MiniStat label="Due" value={money(vo.due_amount ?? 0)} />
        <MiniStat label="Today" value={money(vo.collected_amount ?? 0)} />
      </View>
    </Pressable>
  );
}

function VoRow({ vo, onPress }: { vo: VillageOrganization; onPress: () => void }) {
  return (
    <Pressable style={styles.listRow} onPress={onPress}>
      <View style={styles.listIcon}>
        <Ionicons name="calendar-outline" size={18} color={colors.primary} />
      </View>
      <View style={styles.listText}>
        <Text style={styles.listTitle}>{vo.name}</Text>
        <Text style={styles.listSub}>
          {vo.meeting_day} - {vo.member_count ?? 0} members
        </Text>
      </View>
      <Text style={styles.rowAmount}>{money(vo.due_amount ?? 0)}</Text>
      <Ionicons name="chevron-forward" size={18} color={colors.muted} />
    </Pressable>
  );
}

function CdoCard({ cdo, onPress }: { cdo: Staff; onPress: () => void }) {
  return (
    <Pressable style={styles.listRowLarge} onPress={onPress}>
      <View style={styles.personMark}>
        <Text style={styles.personMarkText}>{cdo.name.slice(0, 1)}</Text>
      </View>
      <View style={styles.listText}>
        <Text style={styles.listTitle}>{cdo.name}</Text>
        <Text style={styles.listSub}>{cdo.staff_code}</Text>
      </View>
      <Ionicons name="chevron-forward" size={20} color={colors.muted} />
    </Pressable>
  );
}

function MemberRow({ member, onPress }: { member: Member; onPress: () => void }) {
  const due = member.due_amount ?? 0;
  return (
    <Pressable style={styles.memberRow} onPress={onPress}>
      <View style={styles.personMarkSmall}>
        <Text style={styles.personMarkSmallText}>{member.name.slice(0, 1)}</Text>
      </View>
      <View style={styles.listText}>
        <Text style={styles.listTitle}>{member.name}</Text>
        <Text style={styles.listSub}>
          {member.member_code} - {member.active_loans ?? 0} loans
        </Text>
      </View>
      <View style={styles.memberDueBox}>
        <Text style={[styles.memberDue, due > 0 && styles.memberDueWarn]}>{money(due)}</Text>
        <Text style={styles.memberDueLabel}>due</Text>
      </View>
    </Pressable>
  );
}

function LoanCard({ loan, schedules }: { loan: LoanAccount; schedules: MemberPortfolio['schedules'] }) {
  const nextItems = schedules.filter((item) => item.status !== 'PAID').slice(0, 3);
  return (
    <View style={styles.loanCard}>
      <View style={styles.cardTopRow}>
        <View style={styles.flex}>
          <Text style={styles.cardTitle}>{loan.product_name}</Text>
          <Text style={styles.cardSub}>Outstanding {money(loan.outstanding_amount)}</Text>
        </View>
        <StatusPill label={loan.status} tone={statusTone(loan.status)} />
      </View>
      <View style={styles.cardStatsRow}>
        <MiniStat label="Principal" value={money(loan.principal_amount)} />
        <MiniStat label="Installment" value={money(loan.installment_amount)} />
        <MiniStat label="Next due" value={loan.next_due_date} />
      </View>
      {nextItems.map((item) => (
        <View key={item.id} style={styles.scheduleRow}>
          <Text style={styles.scheduleText}>#{item.installment_no} - {item.due_date}</Text>
          <Text style={styles.scheduleAmount}>{money(item.due_amount - item.paid_amount)}</Text>
        </View>
      ))}
    </View>
  );
}

function ProductRow({
  icon,
  title,
  subtitle,
  value,
}: {
  icon: IconName;
  title: string;
  subtitle: string;
  value: string;
}) {
  return (
    <View style={styles.listRow}>
      <View style={styles.listIcon}>
        <Ionicons name={icon} size={18} color={colors.primary} />
      </View>
      <View style={styles.listText}>
        <Text style={styles.listTitle}>{title}</Text>
        <Text style={styles.listSub}>{subtitle}</Text>
      </View>
      <Text style={styles.rowAmount}>{value}</Text>
    </View>
  );
}

function TransactionRow({ transaction }: { transaction: MemberPortfolio['transactions'][number] }) {
  return (
    <View style={styles.transactionRow}>
      <View style={[styles.metricIcon, toneStyle(transaction.product_type === 'LOAN' ? 'warning' : 'success').soft]}>
        <Ionicons
          name={transaction.product_type === 'LOAN' ? 'cash-outline' : 'wallet-outline'}
          size={17}
          color={toneStyle(transaction.product_type === 'LOAN' ? 'warning' : 'success').ink}
        />
      </View>
      <View style={styles.listText}>
        <Text style={styles.listTitle}>{transaction.transaction_type}</Text>
        <Text style={styles.listSub}>
          {transaction.product_type} - {transaction.transaction_date}
        </Text>
      </View>
      <Text style={styles.rowAmount}>{money(transaction.amount)}</Text>
    </View>
  );
}

function InfoLine({ icon, label, value }: { icon: IconName; label: string; value: string }) {
  return (
    <View style={styles.infoLine}>
      <Ionicons name={icon} size={18} color={colors.primary} />
      <Text style={styles.infoLabel}>{label}</Text>
      <Text style={styles.infoValue}>{value}</Text>
    </View>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.miniStat}>
      <Text style={styles.miniValue} numberOfLines={1} adjustsFontSizeToFit>
        {value}
      </Text>
      <Text style={styles.miniLabel}>{label}</Text>
    </View>
  );
}

function PrimaryButton({
  label,
  icon,
  onPress,
  disabled,
}: {
  label: string;
  icon: IconName;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable style={[styles.primaryButton, disabled && styles.buttonDisabled]} onPress={onPress} disabled={disabled}>
      <Ionicons name={icon} size={20} color="#FFFFFF" />
      <Text style={styles.primaryButtonText}>{label}</Text>
    </Pressable>
  );
}

function StatusPill({ label, tone }: { label: string; tone: 'success' | 'warning' | 'danger' | 'info' }) {
  const toneColors = toneStyle(tone);
  return (
    <View style={[styles.pill, toneColors.soft]}>
      <Text style={[styles.pillText, { color: toneColors.ink }]}>{label}</Text>
    </View>
  );
}

function LoadingBlock() {
  return (
    <View style={styles.loadingBlock}>
      <ActivityIndicator color={colors.primary} />
      <Text style={styles.loadingText}>Loading local data...</Text>
    </View>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <View style={styles.emptyState}>
      <Ionicons name="document-text-outline" size={22} color={colors.muted} />
      <Text style={styles.emptyText}>{text}</Text>
    </View>
  );
}

function money(value: number) {
  return `৳${Math.round(value).toLocaleString('en-US')}`;
}

function toNumber(value: string) {
  const parsed = Number(value.replace(/[^\d.]/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function statusTone(status: LoanStatus): 'success' | 'warning' | 'danger' | 'info' {
  if (status === 'Current') return 'success';
  if (status === 'Late 1' || status === 'Late 2') return 'warning';
  return 'danger';
}

function toneStyle(tone: 'default' | 'success' | 'warning' | 'danger' | 'info') {
  if (tone === 'success') return { ink: colors.success, soft: { backgroundColor: '#E8F5EC' } };
  if (tone === 'warning') return { ink: colors.warning, soft: { backgroundColor: '#FFF4D6' } };
  if (tone === 'danger') return { ink: colors.danger, soft: { backgroundColor: '#FDEAE7' } };
  if (tone === 'info') return { ink: colors.info, soft: { backgroundColor: '#EAF1FF' } };
  return { ink: colors.primary, soft: { backgroundColor: colors.surfaceAlt } };
}

const styles = StyleSheet.create({
  app: {
    flex: 1,
    backgroundColor: colors.background,
  },
  centerScreen: {
    alignItems: 'center',
    backgroundColor: colors.background,
    flex: 1,
    justifyContent: 'center',
  },
  loadingText: {
    color: colors.muted,
    fontSize: 14,
    marginTop: 10,
  },
  aiPanel: {
    backgroundColor: colors.primaryDark,
    borderRadius: 8,
    marginTop: 16,
    padding: 12,
  },
  aiPanelHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 10,
    marginBottom: 10,
  },
  aiSpark: {
    alignItems: 'center',
    backgroundColor: colors.secondary,
    borderRadius: 8,
    height: 38,
    justifyContent: 'center',
    width: 38,
  },
  aiPanelTitle: {
    color: '#FFFFFF',
    fontSize: 17,
    fontWeight: '900',
  },
  aiPanelSub: {
    color: '#CFE5E5',
    fontSize: 12,
    fontWeight: '700',
    marginTop: 2,
  },
  aiCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 8,
    marginTop: 8,
    padding: 12,
  },
  aiCardCompleted: {
    opacity: 0.72,
  },
  aiCardTitle: {
    color: colors.ink,
    fontSize: 14,
    fontWeight: '900',
  },
  aiCardMessage: {
    color: colors.muted,
    fontSize: 13,
    lineHeight: 18,
    marginTop: 4,
  },
  aiActionRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 10,
    justifyContent: 'space-between',
    marginTop: 10,
  },
  secondaryActionButton: {
    alignItems: 'center',
    backgroundColor: colors.surfaceAlt,
    borderRadius: 8,
    flexDirection: 'row',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  secondaryActionText: {
    color: colors.primary,
    fontSize: 12,
    fontWeight: '900',
  },
  completeButton: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 5,
    paddingHorizontal: 8,
    paddingVertical: 8,
  },
  completeButtonDone: {
    backgroundColor: '#E8F5EC',
    borderRadius: 8,
  },
  completeText: {
    color: colors.muted,
    fontSize: 12,
    fontWeight: '800',
  },
  completeTextDone: {
    color: colors.success,
  },
  dashboardActions: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 12,
  },
  actionTile: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderColor: colors.line,
    borderRadius: 8,
    borderWidth: 1,
    flex: 1,
    flexDirection: 'row',
    gap: 8,
    justifyContent: 'center',
    minHeight: 46,
    paddingHorizontal: 10,
  },
  actionTileText: {
    color: colors.ink,
    fontSize: 13,
    fontWeight: '900',
  },
  myRankCard: {
    backgroundColor: colors.primary,
    borderRadius: 8,
    marginTop: 16,
    padding: 16,
  },
  myRankLabel: {
    color: '#CFE5E5',
    fontSize: 13,
    fontWeight: '800',
  },
  myRankValue: {
    color: '#FFFFFF',
    fontSize: 34,
    fontWeight: '900',
    marginTop: 3,
  },
  myRankAdvice: {
    color: '#EAF5F5',
    fontSize: 13,
    lineHeight: 19,
    marginTop: 6,
  },
  rankingCard: {
    backgroundColor: colors.surface,
    borderColor: colors.line,
    borderRadius: 8,
    borderWidth: 1,
    marginTop: 10,
    padding: 13,
  },
  rankingCardMe: {
    borderColor: colors.primary,
    borderWidth: 2,
  },
  rankingTopRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 10,
  },
  rankBadge: {
    alignItems: 'center',
    backgroundColor: colors.primary,
    borderRadius: 8,
    height: 42,
    justifyContent: 'center',
    width: 42,
  },
  rankBadgeText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '900',
  },
  rankingAdvice: {
    color: colors.muted,
    fontSize: 12,
    lineHeight: 17,
    marginTop: 11,
  },
  chatShell: {
    flex: 1,
  },
  chatContent: {
    padding: 16,
    paddingBottom: 96,
  },
  chatModeBanner: {
    alignItems: 'center',
    backgroundColor: colors.surfaceAlt,
    borderColor: colors.line,
    borderRadius: 8,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 8,
    marginTop: 12,
    padding: 10,
  },
  chatModeText: {
    color: colors.muted,
    flex: 1,
    fontSize: 12,
    fontWeight: '700',
    lineHeight: 17,
  },
  suggestionRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 14,
  },
  suggestionChip: {
    backgroundColor: colors.surface,
    borderColor: colors.line,
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  suggestionText: {
    color: colors.primary,
    fontSize: 12,
    fontWeight: '900',
  },
  chatBubble: {
    borderRadius: 8,
    marginTop: 10,
    maxWidth: '88%',
    padding: 12,
  },
  chatBubbleAssistant: {
    alignSelf: 'flex-start',
    backgroundColor: colors.surface,
    borderColor: colors.line,
    borderWidth: 1,
  },
  chatBubbleUser: {
    alignSelf: 'flex-end',
    backgroundColor: colors.primary,
  },
  chatText: {
    color: colors.ink,
    fontSize: 14,
    lineHeight: 20,
  },
  chatTextUser: {
    color: '#FFFFFF',
  },
  chatSource: {
    color: colors.muted,
    fontSize: 10,
    fontWeight: '800',
    marginTop: 6,
    textTransform: 'uppercase',
  },
  chatSourceUser: {
    color: '#CFE5E5',
  },
  chatBusy: {
    marginTop: 12,
  },
  chatInputBar: {
    alignItems: 'flex-end',
    backgroundColor: colors.surface,
    borderTopColor: colors.line,
    borderTopWidth: 1,
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: Platform.OS === 'android' ? 10 : 12,
  },
  chatInput: {
    backgroundColor: colors.background,
    borderColor: colors.line,
    borderRadius: 8,
    borderWidth: 1,
    color: colors.ink,
    flex: 1,
    fontSize: 15,
    maxHeight: 92,
    minHeight: 44,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  sendButton: {
    alignItems: 'center',
    backgroundColor: colors.primary,
    borderRadius: 8,
    height: 44,
    justifyContent: 'center',
    width: 44,
  },
  chatShortcut: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    flexDirection: 'row',
    gap: 6,
    justifyContent: 'center',
    paddingBottom: 8,
    paddingTop: 2,
  },
  chatShortcutText: {
    color: colors.primary,
    fontSize: 12,
    fontWeight: '900',
  },
  loginShell: {
    backgroundColor: colors.primary,
    flex: 1,
  },
  loginHero: {
    paddingHorizontal: 24,
    paddingTop: 36,
    paddingBottom: 22,
  },
  logoMark: {
    alignItems: 'center',
    backgroundColor: colors.secondary,
    borderRadius: 8,
    height: 54,
    justifyContent: 'center',
    marginBottom: 18,
    width: 54,
  },
  loginTitle: {
    color: '#FFFFFF',
    fontSize: 31,
    fontWeight: '800',
    letterSpacing: 0,
  },
  loginSubtitle: {
    color: '#D7E8E8',
    fontSize: 15,
    lineHeight: 22,
    marginTop: 8,
    maxWidth: 320,
  },
  loginPanel: {
    backgroundColor: colors.background,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    flex: 1,
    padding: 20,
  },
  inputLabel: {
    color: colors.ink,
    fontSize: 13,
    fontWeight: '700',
    marginBottom: 7,
    marginTop: 12,
  },
  input: {
    backgroundColor: colors.surface,
    borderColor: colors.line,
    borderRadius: 8,
    borderWidth: 1,
    color: colors.ink,
    fontSize: 18,
    minHeight: 52,
    paddingHorizontal: 14,
  },
  aiModeCard: {
    alignItems: 'center',
    backgroundColor: colors.surfaceAlt,
    borderColor: colors.line,
    borderRadius: 8,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 12,
    marginTop: 14,
    padding: 12,
  },
  aiModeCopy: {
    flex: 1,
  },
  aiModeTitle: {
    color: colors.ink,
    fontSize: 14,
    fontWeight: '900',
  },
  aiModeText: {
    color: colors.muted,
    fontSize: 12,
    lineHeight: 17,
    marginTop: 3,
  },
  primaryButton: {
    alignItems: 'center',
    backgroundColor: colors.primary,
    borderRadius: 8,
    flexDirection: 'row',
    gap: 8,
    justifyContent: 'center',
    marginTop: 16,
    minHeight: 52,
    paddingHorizontal: 16,
  },
  primaryButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '800',
  },
  buttonDisabled: {
    opacity: 0.7,
  },
  smallSectionTitle: {
    color: colors.muted,
    fontSize: 13,
    fontWeight: '800',
    marginBottom: 10,
    marginTop: 22,
    textTransform: 'uppercase',
  },
  quickGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  quickLogin: {
    backgroundColor: colors.surface,
    borderColor: colors.line,
    borderRadius: 8,
    borderWidth: 1,
    minWidth: '47%',
    padding: 12,
  },
  quickLoginRole: {
    color: colors.primary,
    fontSize: 14,
    fontWeight: '800',
  },
  quickLoginCode: {
    color: colors.muted,
    fontSize: 13,
    marginTop: 3,
  },
  resetButton: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 7,
    justifyContent: 'center',
    marginTop: 22,
  },
  resetText: {
    color: colors.primary,
    fontSize: 14,
    fontWeight: '800',
  },
  header: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderBottomColor: colors.line,
    borderBottomWidth: 1,
    flexDirection: 'row',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  headerIdentity: {
    flex: 1,
  },
  headerName: {
    color: colors.ink,
    fontSize: 16,
    fontWeight: '800',
  },
  headerMeta: {
    color: colors.muted,
    fontSize: 12,
    marginTop: 2,
  },
  iconButton: {
    alignItems: 'center',
    backgroundColor: colors.background,
    borderRadius: 8,
    height: 40,
    justifyContent: 'center',
    width: 40,
  },
  iconButtonGhost: {
    backgroundColor: colors.surface,
  },
  scrollContent: {
    padding: 16,
    paddingBottom: 34,
  },
  screenTitle: {
    color: colors.ink,
    fontSize: 25,
    fontWeight: '900',
    letterSpacing: 0,
  },
  screenCaption: {
    color: colors.muted,
    fontSize: 14,
    lineHeight: 20,
    marginTop: 5,
  },
  titleRow: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: 12,
    justifyContent: 'space-between',
  },
  metricRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 12,
  },
  metricCard: {
    backgroundColor: colors.surface,
    borderColor: colors.line,
    borderRadius: 8,
    borderWidth: 1,
    flex: 1,
    minHeight: 116,
    padding: 13,
  },
  metricIcon: {
    alignItems: 'center',
    borderRadius: 8,
    height: 34,
    justifyContent: 'center',
    width: 34,
  },
  metricValue: {
    color: colors.ink,
    fontSize: 21,
    fontWeight: '900',
    marginTop: 12,
  },
  metricLabel: {
    color: colors.muted,
    fontSize: 12,
    fontWeight: '700',
    marginTop: 3,
  },
  riskStrip: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 14,
  },
  pill: {
    borderRadius: 8,
    paddingHorizontal: 9,
    paddingVertical: 6,
  },
  pillText: {
    fontSize: 12,
    fontWeight: '800',
  },
  sectionTitleRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 10,
    marginTop: 22,
  },
  sectionTitle: {
    color: colors.ink,
    fontSize: 18,
    fontWeight: '900',
  },
  sectionAction: {
    color: colors.muted,
    fontSize: 12,
    fontWeight: '800',
  },
  voCard: {
    backgroundColor: colors.surface,
    borderColor: colors.line,
    borderRadius: 8,
    borderWidth: 1,
    marginBottom: 10,
    padding: 14,
  },
  cardTopRow: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: 12,
    justifyContent: 'space-between',
  },
  cardTitle: {
    color: colors.ink,
    fontSize: 16,
    fontWeight: '900',
  },
  cardSub: {
    color: colors.muted,
    fontSize: 13,
    marginTop: 4,
  },
  cardStatsRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 12,
  },
  miniStat: {
    backgroundColor: colors.surfaceAlt,
    borderRadius: 8,
    flex: 1,
    minHeight: 56,
    padding: 8,
  },
  miniValue: {
    color: colors.ink,
    fontSize: 14,
    fontWeight: '900',
  },
  miniLabel: {
    color: colors.muted,
    fontSize: 11,
    fontWeight: '700',
    marginTop: 3,
  },
  listRow: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderColor: colors.line,
    borderRadius: 8,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 10,
    marginBottom: 9,
    minHeight: 68,
    padding: 12,
  },
  listRowLarge: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderColor: colors.line,
    borderRadius: 8,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 12,
    marginBottom: 10,
    minHeight: 76,
    padding: 12,
  },
  listIcon: {
    alignItems: 'center',
    backgroundColor: colors.surfaceAlt,
    borderRadius: 8,
    height: 38,
    justifyContent: 'center',
    width: 38,
  },
  listText: {
    flex: 1,
  },
  listTitle: {
    color: colors.ink,
    fontSize: 15,
    fontWeight: '900',
  },
  listSub: {
    color: colors.muted,
    fontSize: 12,
    lineHeight: 17,
    marginTop: 3,
  },
  rowAmount: {
    color: colors.ink,
    fontSize: 14,
    fontWeight: '900',
  },
  personMark: {
    alignItems: 'center',
    backgroundColor: colors.primary,
    borderRadius: 8,
    height: 48,
    justifyContent: 'center',
    width: 48,
  },
  personMarkText: {
    color: '#FFFFFF',
    fontSize: 20,
    fontWeight: '900',
  },
  memberRow: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderColor: colors.line,
    borderRadius: 8,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 10,
    marginBottom: 9,
    minHeight: 74,
    padding: 12,
  },
  personMarkSmall: {
    alignItems: 'center',
    backgroundColor: colors.primaryDark,
    borderRadius: 8,
    height: 42,
    justifyContent: 'center',
    width: 42,
  },
  personMarkSmallText: {
    color: '#FFFFFF',
    fontSize: 17,
    fontWeight: '900',
  },
  memberDueBox: {
    alignItems: 'flex-end',
    minWidth: 70,
  },
  memberDue: {
    color: colors.success,
    fontSize: 14,
    fontWeight: '900',
  },
  memberDueWarn: {
    color: colors.warning,
  },
  memberDueLabel: {
    color: colors.muted,
    fontSize: 11,
    fontWeight: '700',
    marginTop: 2,
  },
  memberHero: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 14,
  },
  avatar: {
    alignItems: 'center',
    backgroundColor: colors.secondary,
    borderRadius: 8,
    height: 64,
    justifyContent: 'center',
    width: 64,
  },
  avatarText: {
    color: '#FFFFFF',
    fontSize: 28,
    fontWeight: '900',
  },
  memberHeroText: {
    flex: 1,
  },
  memberMeta: {
    color: colors.primary,
    fontSize: 13,
    fontWeight: '800',
    marginTop: 5,
  },
  profileBlock: {
    backgroundColor: colors.surface,
    borderColor: colors.line,
    borderRadius: 8,
    borderWidth: 1,
    marginTop: 12,
    padding: 12,
  },
  infoLine: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: 8,
    paddingVertical: 7,
  },
  infoLabel: {
    color: colors.muted,
    fontSize: 13,
    fontWeight: '800',
    width: 76,
  },
  infoValue: {
    color: colors.ink,
    flex: 1,
    fontSize: 13,
    lineHeight: 18,
  },
  collectionBox: {
    backgroundColor: colors.surface,
    borderColor: colors.line,
    borderRadius: 8,
    borderWidth: 1,
    padding: 12,
  },
  segmentRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 10,
  },
  segment: {
    backgroundColor: colors.surfaceAlt,
    borderRadius: 8,
    flex: 1,
    paddingHorizontal: 10,
    paddingVertical: 9,
  },
  segmentActive: {
    backgroundColor: colors.primary,
  },
  segmentText: {
    color: colors.muted,
    fontSize: 12,
    fontWeight: '900',
    textAlign: 'center',
  },
  segmentTextActive: {
    color: '#FFFFFF',
  },
  amountRow: {
    alignItems: 'center',
    backgroundColor: colors.background,
    borderRadius: 8,
    flexDirection: 'row',
    gap: 10,
    marginBottom: 9,
    minHeight: 50,
    paddingHorizontal: 12,
  },
  disabledRow: {
    opacity: 0.45,
  },
  amountLabel: {
    color: colors.ink,
    flex: 1,
    fontSize: 14,
    fontWeight: '800',
  },
  amountInput: {
    color: colors.ink,
    fontSize: 18,
    fontWeight: '900',
    minWidth: 90,
    textAlign: 'right',
  },
  notice: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderColor: colors.line,
    borderRadius: 8,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 9,
    padding: 12,
  },
  noticeText: {
    color: colors.muted,
    flex: 1,
    fontSize: 13,
    lineHeight: 18,
  },
  loanCard: {
    backgroundColor: colors.surface,
    borderColor: colors.line,
    borderRadius: 8,
    borderWidth: 1,
    marginBottom: 10,
    padding: 14,
  },
  scheduleRow: {
    alignItems: 'center',
    borderTopColor: colors.line,
    borderTopWidth: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 9,
    paddingTop: 9,
  },
  scheduleText: {
    color: colors.muted,
    fontSize: 12,
    fontWeight: '700',
  },
  scheduleAmount: {
    color: colors.ink,
    fontSize: 12,
    fontWeight: '900',
  },
  transactionRow: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderColor: colors.line,
    borderRadius: 8,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 10,
    marginBottom: 9,
    minHeight: 66,
    padding: 12,
  },
  emptyState: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderColor: colors.line,
    borderRadius: 8,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 10,
    padding: 14,
  },
  emptyText: {
    color: colors.muted,
    fontSize: 13,
    fontWeight: '700',
  },
  flex: {
    flex: 1,
  },
  loadingBlock: {
    alignItems: 'center',
    flex: 1,
    justifyContent: 'center',
  },
});

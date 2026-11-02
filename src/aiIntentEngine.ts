import { logAiTrace } from './aiTrace';
import { Staff } from './types';

export type CanonicalIntentName =
  | 'collection_completed_today'
  | 'collection_pending_today'
  | 'collection_completed_members_today'
  | 'collection_pending_members_today'
  | 'unsupported';

export type CanonicalIntent = {
  intent: CanonicalIntentName;
  timeframe: 'today' | 'unknown';
  wants: Array<'count' | 'amount' | 'members'>;
  confidence: number;
  reasoning?: string;
};

const VALID_INTENTS = new Set<CanonicalIntentName>([
  'collection_completed_today',
  'collection_pending_today',
  'collection_completed_members_today',
  'collection_pending_members_today',
  'unsupported',
]);

const VALID_WANTS = new Set(['count', 'amount', 'members']);
const INTENT_TIMEOUT_MS = 180000;

export async function requestCanonicalIntent(
  gatewayUrls: string[],
  user: Staff,
  question: string,
  traceId: string,
): Promise<CanonicalIntent | null> {
  for (const gatewayUrl of gatewayUrls) {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const startedAt = Date.now();
    try {
      const controller = new AbortController();
      timeout = setTimeout(() => controller.abort(), INTENT_TIMEOUT_MS);
      const payload = {
        traceId,
        question,
        staff: { id: user.id, name: user.name, role: user.role, branch_id: user.branch_id },
      };
      logAiTrace(traceId, 'intent_request_prepared', {
        gatewayUrl,
        payload,
      });
      const response = await fetch(`${gatewayUrl}/api/ai/intent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      timeout = null;
      if (!response.ok) throw new Error(`Intent failed ${response.status}`);
      const json = await response.json();
      logAiTrace(traceId, 'intent_response', {
        gatewayUrl,
        durationMs: Date.now() - startedAt,
        response: json,
      });
      if (!json.intent || json.source === 'fallback') throw new Error(json.error ?? 'Intent fallback');
      const intent = normalizeIntent(json.intent, question);
      if (!intent) throw new Error('Intent response was not supported');
      return intent;
    } catch (error) {
      logAiTrace(traceId, 'intent_error', {
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

function normalizeIntent(raw: unknown, question: string): CanonicalIntent | null {
  if (!raw || typeof raw !== 'object') return null;
  const root = raw as Record<string, unknown>;
  const outputShape = root.outputShape;
  const value = outputShape && typeof outputShape === 'object'
    ? outputShape as Record<string, unknown>
    : root;
  const intent = String(value.intent || 'unsupported') as CanonicalIntentName;
  if (!VALID_INTENTS.has(intent)) return null;
  const timeframe = value.timeframe === 'today' ? 'today' : 'unknown';
  const rawWants = Array.isArray(value.wants) ? value.wants : value.wants ? [value.wants] : [];
  const wants = rawWants
    .map((item) => String(item))
    .flatMap((item) => item.split(/[,\s|/]+/))
    .filter((item): item is 'count' | 'amount' | 'members' => VALID_WANTS.has(item));
  const confidence = Number(value.confidence);
  const adjustedIntent = adjustIntentForQuestion(intent, wants, question);
  return {
    intent: adjustedIntent,
    timeframe,
    wants,
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0,
    reasoning: value.reasoning ? String(value.reasoning) : undefined,
  };
}

function adjustIntentForQuestion(
  intent: CanonicalIntentName,
  wants: Array<'count' | 'amount' | 'members'>,
  question: string,
) {
  const normalized = question.toLowerCase();
  const asksMembers =
    wants.includes('members') ||
    /\b(kar kar|kara|ke ke|who|which members?|name|names)\b/i.test(normalized) ||
    /কার কার|কারা|কে কে|নাম|সদস্য|মেম্বার/.test(normalized);

  if (asksMembers && intent === 'collection_completed_today') return 'collection_completed_members_today';
  if (asksMembers && intent === 'collection_pending_today') return 'collection_pending_members_today';
  return intent;
}

import { getAiGatewayUrls } from './network';

const MAX_TRACE_CHARS = 3500;

type TraceData = Record<string, unknown>;

function compact(value: unknown) {
  const text = JSON.stringify(value, null, 2);
  if (text.length <= MAX_TRACE_CHARS) return text;
  return `${text.slice(0, MAX_TRACE_CHARS)}... [truncated ${text.length - MAX_TRACE_CHARS} chars]`;
}

export function createAiTraceId() {
  return `ai-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function logAiTrace(traceId: string, stage: string, data: TraceData = {}) {
  const payload = {
    traceId,
    stage,
    at: new Date().toISOString(),
    ...data,
  };
  console.log(`[AI TRACE][${traceId}][${stage}] ${compact(payload)}`);
  void sendTraceToGateway(payload);
}

async function sendTraceToGateway(payload: TraceData) {
  const urls = getAiGatewayUrls();
  for (const gatewayUrl of urls) {
    try {
      await fetch(`${gatewayUrl}/api/ai/trace`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      return;
    } catch {
      continue;
    }
  }
}

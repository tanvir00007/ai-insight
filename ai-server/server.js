const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const PORT = Number(process.env.AI_GATEWAY_PORT || 8787);
const ROOT = __dirname;
const CONFIG_PATH = path.join(ROOT, 'config.json');
const CONFIG_EXAMPLE_PATH = path.join(ROOT, 'config.example.json');
const PUBLIC_DIR = path.join(ROOT, 'public');
const LOG_DIR = path.join(ROOT, 'logs');
const TRACE_LOG_PATH = path.join(LOG_DIR, 'ai-trace.log');
const MAX_LOG_CHARS = 6000;
const LOCAL_ORIGINS = new Set(['localhost', '127.0.0.1', '[::1]'].map((host) => `http://${host}:${PORT}`));
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
// Routes the phone app calls. Everything else only answers on the computer running the gateway.
const PHONE_ROUTES = new Set([
  '/api/ai/trace',
  '/api/ai/chat',
  '/api/ai/plan',
  '/api/ai/intent',
  '/api/ai/query-plan',
  '/api/ai/compose',
]);
let runtimeProcess = null;
let appProcess = null;

function readConfig() {
  if (!fs.existsSync(CONFIG_PATH)) fs.copyFileSync(CONFIG_EXAMPLE_PATH, CONFIG_PATH);
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

function isAllowedRequest(req, url) {
  const origin = req.headers.origin;
  if (origin && !LOCAL_ORIGINS.has(origin)) return false;
  if (PHONE_ROUTES.has(url.pathname)) return true;
  return LOOPBACK_ADDRESSES.has(req.socket.remoteAddress) && LOCAL_ORIGINS.has(`http://${req.headers.host}`);
}

function writeConfig(config) {
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
}

function publicConfig(config) {
  return {
    runtime: 'llamacpp',
    baseUrl: 'http://localhost:8080',
    model: '',
    apiKey: 'sk-no-key-required',
    temperature: 0.2,
    maxTokens: 220,
    plannerMaxTokens: 320,
    plannerTimeoutMs: 180000,
    composerMaxTokens: 220,
    composerTimeoutMs: 180000,
    repairAttempts: 2,
    reasoningModel: true,
    disableThinking: true,
    useChatTemplateKwargs: false,
    structuredOutputMode: 'json_schema',
    contextLength: 8192,
    cpuThreads: 8,
    gpuEnabled: true,
    gpuLayers: 99,
    cudaVisibleDevices: '0',
    serverBackend: 'cuda',
    serverExecutable: path.join(ROOT, '..', 'tools', 'llama-win-cpu', 'llama-server.exe'),
    serverHost: '127.0.0.1',
    serverPort: 8080,
    serverBatchSize: 512,
    serverUbatchSize: 128,
    serverParallel: 1,
    flashAttention: false,
    mmap: true,
    mlock: false,
    serverExtraArgs: '',
    autoStartRuntime: false,
    appStartCommand: 'npm.cmd start',
    systemPrompt: '',
    ...config,
    apiKey: config.apiKey ?? 'sk-no-key-required',
  };
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(body);
}

function sendText(res, status, body, contentType = 'text/plain') {
  res.writeHead(status, { 'Content-Type': contentType });
  res.end(body);
}

function launcherStatus(child) {
  if (!child) return { running: false, pid: null };
  return { running: !child.killed && child.exitCode === null, pid: child.pid ?? null };
}

function splitArgs(text) {
  const args = [];
  const input = String(text || '').trim();
  if (!input) return args;
  const pattern = /"([^"]*)"|'([^']*)'|[^\s]+/g;
  let match;
  while ((match = pattern.exec(input))) {
    args.push(match[1] ?? match[2] ?? match[0]);
  }
  return args;
}

function inferRuntimePort(config) {
  try {
    const parsed = new URL(config.baseUrl || 'http://localhost:8080');
    return Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));
  } catch {
    return 8080;
  }
}

function isPathLike(value) {
  const text = String(value || '');
  return path.isAbsolute(text) || text.includes('\\') || text.includes('/');
}

function buildRuntimeCommand(config) {
  const backend = String(config.serverBackend || 'llamacpp').toLowerCase();
  if (backend === 'external' || backend === 'openai' || backend === 'vllm') {
    throw new Error('External OpenAI-compatible runtimes are not launchable from this panel. Start that server separately, then use Health Check.');
  }

  const executable = String(config.serverExecutable || '').trim();
  if (!executable) throw new Error('Runtime executable path is required.');
  if (isPathLike(executable) && !fs.existsSync(executable)) {
    throw new Error(`Runtime executable was not found: ${executable}`);
  }

  if (backend === 'ollama') {
    return { executable, args: ['serve', ...splitArgs(config.serverExtraArgs)] };
  }

  const model = String(config.model || '').trim();
  if (!model) throw new Error('Model file path is required.');
  if (isPathLike(model) && !fs.existsSync(model)) {
    throw new Error(`Model file was not found: ${model}`);
  }
  const args = [
    '-m',
    model,
    '--host',
    String(config.serverHost || '127.0.0.1'),
    '--port',
    String(config.serverPort || inferRuntimePort(config)),
    '-c',
    String(config.contextLength || 4096),
    '-t',
    String(config.cpuThreads || 6),
  ];
  if (config.gpuEnabled) args.push('-ngl', String(config.gpuLayers ?? 99));
  if (config.serverBatchSize) args.push('-b', String(config.serverBatchSize));
  if (config.serverUbatchSize) args.push('-ub', String(config.serverUbatchSize));
  if (config.serverParallel) args.push('-np', String(config.serverParallel));
  if (config.flashAttention) args.push('-fa');
  if (config.mlock) args.push('--mlock');
  if (config.mmap === false) args.push('--no-mmap');
  args.push(...splitArgs(config.serverExtraArgs));
  return { executable, args };
}

function startRuntimeProcess(config) {
  if (launcherStatus(runtimeProcess).running) return launcherStatus(runtimeProcess);
  const { executable, args } = buildRuntimeCommand(config);
  runtimeProcess = spawn(executable, args, {
    cwd: path.resolve(ROOT, '..'),
    detached: false,
    shell: false,
    windowsHide: false,
    stdio: 'inherit',
    env: {
      ...process.env,
      ...(config.cudaVisibleDevices ? { CUDA_VISIBLE_DEVICES: String(config.cudaVisibleDevices) } : {}),
    },
  });
  runtimeProcess.on('exit', () => {
    runtimeProcess = null;
  });
  runtimeProcess.on('error', (error) => {
    console.error(`Runtime launcher error: ${error.message}`);
    runtimeProcess = null;
  });
  return launcherStatus(runtimeProcess);
}

function stopProcess(child, label) {
  if (!launcherStatus(child).running) return { running: false, pid: null };
  try {
    if (process.platform === 'win32' && child.pid) {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      child.kill();
    }
  } catch (error) {
    throw new Error(`Could not stop ${label}: ${error.message}`);
  }
  return { running: false, pid: child.pid ?? null };
}

function startAppProcess(config) {
  if (launcherStatus(appProcess).running) return launcherStatus(appProcess);
  const parts = splitArgs(config.appStartCommand || 'npm.cmd start');
  const command = parts.shift();
  if (!command) throw new Error('App start command is required.');
  appProcess = spawn(command, parts, {
    cwd: path.resolve(ROOT, '..'),
    detached: false,
    shell: true,
    windowsHide: false,
    stdio: 'inherit',
  });
  appProcess.on('exit', () => {
    appProcess = null;
  });
  appProcess.on('error', (error) => {
    console.error(`App launcher error: ${error.message}`);
    appProcess = null;
  });
  return launcherStatus(appProcess);
}

function compactLog(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  if (text.length <= MAX_LOG_CHARS) return text;
  return `${text.slice(0, MAX_LOG_CHARS)}... [truncated ${text.length - MAX_LOG_CHARS} chars]`;
}

function traceLog(traceId, stage, data = {}) {
  const payload = {
    traceId: traceId || 'no-trace-id',
    stage,
    at: new Date().toISOString(),
    ...data,
  };
  const header = `[AI TRACE][${payload.traceId}][${stage}]`;
  const body = compactLog(payload);
  console.log(`\n${header}`);
  console.log(body);
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(TRACE_LOG_PATH, `${new Date().toISOString()} ${header}\n${body}\n\n`, 'utf8');
  } catch (error) {
    console.error(`Could not write trace log: ${error.message}`);
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error('Payload too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function callModel(config, messages, options = {}) {
  if (config.runtime === 'ollama') {
    const wantsJson = options.responseFormat?.type === 'json_object' || options.responseFormat?.type === 'json_schema';
    const response = await fetch(`${config.baseUrl.replace(/\/$/, '')}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.model,
        stream: false,
        messages,
        ...(wantsJson ? { format: 'json' } : {}),
        options: {
          temperature: options.temperature ?? config.temperature,
          num_predict: options.maxTokens ?? config.maxTokens,
          num_ctx: config.contextLength,
        },
      }),
    });
    if (!response.ok) throw new Error(`Ollama returned ${response.status}`);
    const json = await response.json();
    return json.message?.content ?? '';
  }

  const shouldBeDeterministic = messages.some((message) => {
    const content = String(message.content || '');
    return content.includes('Create one SQL query') || content.includes('Classify the user question') || content.includes('Create a query plan');
  });
  const requestBody = {
    model: config.model,
    temperature: options.temperature ?? (shouldBeDeterministic ? 0 : config.temperature),
    max_tokens: options.maxTokens ?? config.maxTokens,
    ...(options.responseFormat ? { response_format: options.responseFormat } : {}),
    ...(config.disableThinking !== false && config.useChatTemplateKwargs === true
      ? {
          chat_template_kwargs: { enable_thinking: false },
        }
      : {}),
    messages: config.disableThinking !== false ? withNoThinkMessages(messages, options) : messages,
  };
  const json = await postLlamaChatCompletion(config, requestBody);
  const text = extractAssistantText(json);
  if (String(text || '').trim() || config.reasoningModel === false) return text;
  return retryFinalAnswer(config, requestBody, options);
}

async function postLlamaChatCompletion(config, requestBody) {
  const response = await fetch(`${config.baseUrl.replace(/\/$/, '')}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey || 'sk-no-key-required'}`,
    },
    body: JSON.stringify(requestBody),
  });
  if (response.ok) return response.json();
  const errorText = await response.text().catch(() => '');
  if (requestBody.chat_template_kwargs) {
    const retryBody = { ...requestBody };
    delete retryBody.chat_template_kwargs;
    const retry = await fetch(`${config.baseUrl.replace(/\/$/, '')}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey || 'sk-no-key-required'}`,
      },
      body: JSON.stringify(retryBody),
    });
    if (retry.ok) return retry.json();
    const retryText = await retry.text().catch(() => '');
    throw new Error(`llama.cpp returned ${retry.status}: ${retryText || errorText}`.trim());
  }
  throw new Error(`llama.cpp returned ${response.status}: ${errorText}`.trim());
}

function withNoThinkMessages(messages, options = {}) {
  const wantsJson = options.responseFormat?.type === 'json_object' || options.responseFormat?.type === 'json_schema';
  const control = wantsJson
    ? '/no_think Return the final answer as one JSON object only. Do not include analysis, markdown, or <think> blocks.'
    : '/no_think Return only the final answer. Do not include analysis, markdown, or <think> blocks.';
  const systemParts = [control];
  const nonSystemMessages = [];
  for (const message of messages) {
    if (message.role === 'system') {
      systemParts.push(String(message.content || ''));
    } else {
      nonSystemMessages.push(message);
    }
  }
  return [{ role: 'system', content: systemParts.filter(Boolean).join('\n\n') }, ...nonSystemMessages];
}

function extractAssistantText(json) {
  const choice = json?.choices?.[0] || {};
  const message = choice.message || {};
  const content = message.content ?? choice.text ?? '';
  if (String(content || '').trim()) return stripThinkBlocks(content);
  const reasoning =
    message.reasoning_content ??
    message.reasoning ??
    message.thinking ??
    message.reasoningContent ??
    json?.reasoning_content ??
    '';
  return stripThinkBlocks(reasoning);
}

function stripThinkBlocks(text) {
  return String(text || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim();
}

async function retryFinalAnswer(config, requestBody, options = {}) {
  const wantsJson = options.responseFormat?.type === 'json_object' || options.responseFormat?.type === 'json_schema';
  const retryMessages = [
    ...requestBody.messages,
    {
      role: 'user',
      content: wantsJson
        ? '/no_think Your previous response had no visible content. Return exactly one valid JSON object now. No explanation.'
        : '/no_think Your previous response had no visible content. Return only the final answer now. No explanation.',
    },
  ];
  const retryResponse = await fetch(`${config.baseUrl.replace(/\/$/, '')}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey || 'sk-no-key-required'}`,
    },
    body: JSON.stringify({
      ...requestBody,
      max_tokens: Math.max(Number(requestBody.max_tokens || 0), wantsJson ? 512 : 256),
      messages: retryMessages,
    }),
  });
  if (!retryResponse.ok) throw new Error(`llama.cpp retry returned ${retryResponse.status}`);
  return extractAssistantText(await retryResponse.json());
}

function buildMessages(config, task, payload) {
  return [
    { role: 'system', content: config.systemPrompt },
    ...(payload.instruction ? [{ role: 'system', content: payload.instruction }] : []),
    {
      role: 'user',
      content: JSON.stringify(
        {
          task,
          intent: payload.intent ?? null,
          portfolioFacts: payload.context ?? payload,
          recentMessages: payload.context?.recentMessages ?? [],
          suggestedBanglaAnswer: payload.context?.suggestedBanglaAnswer ?? null,
          userQuestion: payload.question ?? null,
          outputRules: [
            'Always answer in proper Bangla.',
            'Do not answer in Banglish.',
            'If suggestedBanglaAnswer exists, improve it conversationally instead of ignoring it.',
            'Use only the supplied facts.',
            'Keep the answer under 120 words unless asked for details.',
            'Give 2-3 practical next actions when useful.',
            'Do not say data is missing unless the requested fact is truly absent.',
          ],
        },
        null,
        2,
      ),
    },
  ];
}

function buildPlanMessages(config, payload) {
  return [
    {
      role: 'system',
      content:
        'You are a query planner for a mobile SQLite microfinance app. Return only valid JSON. Do not answer the user. Do not write SQL.',
    },
    {
      role: 'user',
      content: JSON.stringify(
        {
          userQuestion: payload.question,
          staff: payload.staff,
          schema: payload.schema,
          requiredOutput:
            'JSON object with keys: metric, answer_type, scope, timeframe_days, group_by, mentioned_member, limit, needs_advice, reasoning',
        },
        null,
        2,
      ),
    },
  ];
}

function buildIntentMessages(config, payload) {
  return [
    {
      role: 'system',
      content:
        'Return only valid JSON. You classify messy Bangla, Banglish, or English microfinance questions into canonical intents. Do not write SQL. Do not answer the user.',
    },
    {
      role: 'user',
      content: JSON.stringify(
        {
          task: 'Classify the user question.',
          userQuestion: payload.question,
          staff: payload.staff,
          validIntents: [
            'collection_completed_today',
            'collection_pending_today',
            'collection_completed_members_today',
            'collection_pending_members_today',
            'unsupported',
          ],
          definitions: {
            collection_completed_today:
              'The user asks how many collections/payments/deposits happened today, or how much was collected today.',
            collection_pending_today:
              'The user asks how many collections are left, pending, due, baki, remaining, or payable today.',
            collection_completed_members_today:
              'The user asks which members had collections/payments/deposits today, optionally with amount.',
            collection_pending_members_today:
              'The user asks which members still have pending/due/baki collections today.',
          },
          outputShape: {
            intent: 'one validIntent',
            timeframe: 'today | unknown',
            wants: ['count | amount | members'],
            confidence: 'number from 0 to 1',
            reasoning: 'short English reason',
          },
          rules: [
            'Treat spelling variants such as hoyeche, hoyeache, hoise, hoyse, holo, hoilo as completed collection.',
            'Treat baki, pending, remaining, due, pabo, paowa as pending collection.',
            'If completed and pending cues both exist, prefer the more explicit cue closest to collection.',
            'Use unsupported only when the question is not about collection status/history.',
          ],
        },
        null,
        2,
      ),
    },
  ];
}

function buildSqlPlanMessages(config, payload) {
  const staff = payload.staff || {};
  const memberCodeHint = extractMemberCode(payload.question);
  return [
    {
      role: 'system',
      content:
        'Return only JSON. You create exactly one safe SQLite SELECT for a microfinance analytics view. No markdown, no explanation outside JSON.',
    },
    {
      role: 'user',
      content: JSON.stringify(
        {
          task: 'Create one SQL query. JSON keys: sql, reasoning, answerFocus.',
          userQuestion: payload.question,
          staff,
          schema: payload.schema,
          hardRules: `Only SELECT. Only listed views/columns. No semicolon. Always LIMIT <= 20. ${staff.role === 'BM' ? `Must include branch_id = ${staff.branch_id}.` : `Must include cdo_id = ${staff.id}, except CDO comparison/ranking can use branch_id = ${staff.branch_id}.`}`,
          semanticRules: [
            'If the user asks baki, pending, remaining, due, outstanding, pabo, paowa, collection baki, or how many collections are left: use ai_due_schedules, schedule_status != "PAID", due_date <= date("now"), and aggregate pending_amount/member_id.',
            'If the user asks hoyeche, holo, korechi, collected, paid, or today collection happened: use ai_transactions with transaction_date = date("now").',
            'Never answer pending collection questions from ai_transactions only.',
            'Never answer completed collection questions from ai_due_schedules only.',
          ],
          validationFeedback: payload.validationFeedback
            ? `Previous SQL was rejected by the mobile validator: ${payload.validationFeedback}. Generate corrected SQL that fixes this issue.`
            : null,
          memberCodeRule: memberCodeHint
            ? `The user mentioned member code ${memberCodeHint}. This is ai_members.member_code, not member_id. Join ai_members to transaction/due views using member_id when needed.`
            : null,
          examples: [
            {
              question: 'Koto jon member er collection baki ache?',
              sql: `SELECT COUNT(DISTINCT member_id) AS pending_members, COUNT(*) AS pending_installments, SUM(pending_amount) AS pending_amount FROM ai_due_schedules WHERE cdo_id = ${staff.id ?? 0} AND schedule_status != "PAID" AND due_date <= date("now") LIMIT 1`,
            },
            {
              question: 'আজকে যাদের কালেকশন হয়েছে সেসব মেম্বারদের নাম দাও',
              sql: `SELECT DISTINCT member_name, vo_name, product_type, amount FROM ai_transactions WHERE cdo_id = ${staff.id ?? 0} AND transaction_date = date("now") ORDER BY member_name LIMIT 20`,
            },
            {
              question: 'আজকে আমার আর কয়টা কালেকশন বাকি আছে?',
              sql: `SELECT COUNT(*) AS pending_installments, COUNT(DISTINCT member_id) AS pending_members, SUM(pending_amount) AS pending_amount FROM ai_due_schedules WHERE cdo_id = ${staff.id ?? 0} AND schedule_status != "PAID" AND due_date <= date("now") LIMIT 1`,
            },
            {
              question: 'CDO দের মধ্যে কার overdue বেশি?',
              sql: `SELECT cdo_name, overdue_amount, overdue_members FROM ai_cdo_portfolio WHERE branch_id = ${staff.branch_id ?? 0} ORDER BY overdue_amount DESC LIMIT 5`,
            },
          ],
        },
      ),
    },
  ];
}

function queryPlanResponseFormat() {
  return {
    type: 'json_schema',
    json_schema: {
      name: 'microfinance_query_plan',
      strict: true,
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['status', 'sql', 'answerMode', 'factsNeeded', 'confidence', 'clarification', 'reasoning'],
        properties: {
          status: { type: 'string', enum: ['ready', 'clarify', 'unsupported'] },
          sql: { type: ['string', 'null'] },
          answerMode: {
            type: 'string',
            enum: ['summary', 'count', 'member_list', 'ranked_list', 'member_detail', 'clarification'],
          },
          factsNeeded: {
            type: 'array',
            items: { type: 'string' },
          },
          confidence: { type: 'number' },
          clarification: { type: ['string', 'null'] },
          reasoning: { type: 'string' },
        },
      },
    },
  };
}

function plannerResponseFormat(config) {
  const mode = String(config.structuredOutputMode || 'json_schema').toLowerCase();
  if (mode === 'none' || mode === 'off') return null;
  if (mode === 'json_object') return { type: 'json_object' };
  return queryPlanResponseFormat();
}

function buildQueryPlanMessages(config, payload) {
  const staff = payload.staff || {};
  return [
    {
      role: 'system',
      content:
        '/no_think You are a Text-to-SQL planner for a local SQLite microfinance analytics app. Create a query plan as JSON only. Do not answer the user. Do not think step by step. Do not include analysis, markdown, or <think> blocks. Use exactly the available views and columns. Prefer a clarifying question only when the request is truly ambiguous.',
    },
    {
      role: 'user',
      content: JSON.stringify(
        {
          task: '/no_think Create a query plan for the user question. Return final JSON only.',
          userQuestion: payload.question,
          staff,
          schema: payload.schema,
          requiredContract: {
            status: 'ready | clarify | unsupported',
            sql: 'one safe SQLite SELECT when status=ready, else null',
            answerMode: 'summary | count | member_list | ranked_list | member_detail | clarification',
            factsNeeded: ['columns or fact names the answer should use'],
            confidence: '0 to 1',
            clarification: 'Bangla clarification when status=clarify, else null',
            reasoning: 'short English reason',
          },
          hardRules: [
            'Return one JSON object only.',
            'Do not include markdown, commentary, analysis text, or <think> blocks.',
            'When status is ready, sql must be exactly one SELECT statement.',
            'Use only listed analytics views and columns.',
            'No INSERT, UPDATE, DELETE, DROP, ALTER, CREATE, PRAGMA, ATTACH, DETACH, WITH, UNION, semicolon, comments, or multiple statements.',
            staff.role === 'BM'
              ? `For BM staff, include branch_id = ${staff.branch_id}.`
              : `For CDO staff, include cdo_id = ${staff.id}, except CDO comparison/ranking can use branch_id = ${staff.branch_id}.`,
            'Always include LIMIT 20 or lower.',
            'Use date("now") for today.',
          ],
          semanticRules: [
            'Completed collection means collection happened, paid, collected, holo, hoilo, hoyeche, hoyeache, hoise, hoyse. Use ai_transactions and transaction_date = date("now").',
            'Generic phrases like "Collection today?", "Today collection?", "Today\'s collection?", "Ajke collection?", or "Ajker collection?" are NOT ambiguous. Treat them as completed collection summary for today.',
            'Only ask a clarification for collection questions when the question is missing both a collection concept and a usable time/scope, or when it is a greeting/non-domain message.',
            'Pending collection means baki, pending, remaining, due, pabo, paowa. Use ai_due_schedules with schedule_status != "PAID" and due_date <= date("now").',
            'For who/which members/name/kar kar/kara/ke ke questions, return member_name and useful context. Use answerMode member_list.',
            'For amount collected today from transactions, use SUM(amount) AS collected_amount. ai_transactions does not have pending_amount.',
            'For pending amount from due schedules, use SUM(pending_amount) AS pending_amount.',
          ],
          validationFeedback: payload.validationFeedback
            ? `Previous query was rejected: ${payload.validationFeedback}. Generate a corrected query that fixes this exact issue.`
            : null,
          examples: [
            {
              question: 'Kar Kar collection ajke holo?',
              plan: {
                status: 'ready',
                sql: `SELECT DISTINCT member_name, vo_name, product_type, amount FROM ai_transactions WHERE cdo_id = ${staff.id ?? 0} AND transaction_date = date("now") ORDER BY member_name LIMIT 20`,
                answerMode: 'member_list',
                factsNeeded: ['member_name', 'vo_name', 'product_type', 'amount'],
                confidence: 0.95,
                clarification: null,
                reasoning: 'The user asks which members had completed collections today.',
              },
            },
            {
              question: 'Ajke koyta collection holo?',
              plan: {
                status: 'ready',
                sql: `SELECT COUNT(*) AS collected_transactions, COUNT(DISTINCT member_id) AS collected_members, SUM(amount) AS collected_amount FROM ai_transactions WHERE cdo_id = ${staff.id ?? 0} AND transaction_date = date("now") LIMIT 1`,
                answerMode: 'summary',
                factsNeeded: ['collected_transactions', 'collected_members', 'collected_amount'],
                confidence: 0.95,
                clarification: null,
                reasoning: 'The user asks count and amount of completed collections today.',
              },
            },
            {
              question: 'Collection today?',
              plan: {
                status: 'ready',
                sql: `SELECT COUNT(*) AS collected_transactions, COUNT(DISTINCT member_id) AS collected_members, SUM(amount) AS collected_amount FROM ai_transactions WHERE cdo_id = ${staff.id ?? 0} AND transaction_date = date("now") LIMIT 1`,
                answerMode: 'summary',
                factsNeeded: ['collected_transactions', 'collected_members', 'collected_amount'],
                confidence: 0.95,
                clarification: null,
                reasoning: 'Generic collection today means completed collection summary today.',
              },
            },
            {
              question: 'Ajke collection baki koyta?',
              plan: {
                status: 'ready',
                sql: `SELECT COUNT(*) AS pending_installments, COUNT(DISTINCT member_id) AS pending_members, SUM(pending_amount) AS pending_amount FROM ai_due_schedules WHERE cdo_id = ${staff.id ?? 0} AND schedule_status != "PAID" AND due_date <= date("now") LIMIT 1`,
                answerMode: 'summary',
                factsNeeded: ['pending_installments', 'pending_members', 'pending_amount'],
                confidence: 0.95,
                clarification: null,
                reasoning: 'The user asks pending collections today.',
              },
            },
          ],
        },
        null,
        2,
      ),
    },
  ];
}

function extractMemberCode(question) {
  const match = String(question || '').match(/\bm-\d+\b/i);
  return match ? match[0].toUpperCase() : null;
}

function buildFastSqlPlan(payload) {
  const question = String(payload.question || '').toLowerCase();
  if (extractMemberCode(question)) return null;
  const staff = payload.staff || {};
  const cdoScope = `cdo_id = ${Number(staff.id || 0)}`;
  const branchScope = `branch_id = ${Number(staff.branch_id || 0)}`;
  const ownScope = staff.role === 'BM' ? branchScope : cdoScope;
  const branchCompareScope = branchScope;
  const hasToday = /today|aj|aaj|আজ|আজকে|আজকের/.test(question);
  const hasCollection = /collection|collect|কালেকশন|আদায়|আদায়|কিস্তি|সংগ্রহ/.test(question);
  const asksName = /name|names|নাম|যাদের|যারা|কারা|কে কে|সেসব|মেম্বার|সদস্য/.test(question);
  const asksPending = /pending|remaining|due|বাকি|আর কয়টা|আর কয়টা|কয়টা|কয়টা/.test(question);
  const asksCdo = /cdo|সিডিও|কর্মী|officer/.test(question);
  const asksOverdue = /overdue|বকেয়া|বকেয়া|ওভারডিউ|ঝুঁকি|বেশি/.test(question);

  if (hasToday && hasCollection && asksName) {
    return {
      sqlPlan: {
        sql: `SELECT DISTINCT member_name, vo_name, product_type, amount FROM ai_transactions WHERE ${ownScope} AND transaction_date = date("now") ORDER BY member_name LIMIT 20`,
        reasoning: 'Fast planner: user asked for names of members with collection today.',
        answerFocus: 'member_name, vo_name, product_type, amount',
      },
      reason: 'today_collection_member_names',
    };
  }

  if (hasToday && hasCollection && asksPending) {
    return {
      sqlPlan: {
        sql: `SELECT COUNT(*) AS pending_installments, COUNT(DISTINCT member_id) AS pending_members, SUM(pending_amount) AS pending_amount FROM ai_due_schedules WHERE ${ownScope} AND schedule_status != "PAID" AND due_date <= date("now") LIMIT 1`,
        reasoning: 'Fast planner: user asked pending collection count for today.',
        answerFocus: 'pending_installments, pending_members, pending_amount',
      },
      reason: 'today_pending_collection',
    };
  }

  if (asksCdo && asksOverdue) {
    return {
      sqlPlan: {
        sql: `SELECT cdo_name, overdue_amount, overdue_members FROM ai_cdo_portfolio WHERE ${branchCompareScope} ORDER BY overdue_amount DESC LIMIT 5`,
        reasoning: 'Fast planner: user asked CDO overdue comparison.',
        answerFocus: 'cdo_name, overdue_amount, overdue_members',
      },
      reason: 'cdo_overdue_comparison',
    };
  }

  return null;
}

function buildTodayCollectionQueryPlan(payload, reason = 'today_collection_default') {
  const question = String(payload.question || '').toLowerCase();
  if (extractMemberCode(question)) return null;
  const hasToday = /\b(today|todays|today's|aj|aaj|ajke|ajker)\b/.test(question);
  const hasCollection = /\b(collection|collections|collect|collected|paid|payment|holo|hoilo|hoyeche|hoise|hoyse)\b/.test(question);
  if (!hasToday || !hasCollection) return null;

  const staff = payload.staff || {};
  const scopeId = staff.role === 'BM' ? Number(staff.branch_id || 0) : Number(staff.id || 0);
  const scope = staff.role === 'BM' ? `branch_id = ${scopeId}` : `cdo_id = ${scopeId}`;
  const asksPending = /\b(pending|remaining|due|baki|paowa|pabo)\b/.test(question);
  const asksName = /\b(name|names|member|members|who|whose|which|kar|kara|ke|kader)\b/.test(question);

  if (asksPending) {
    return {
      status: 'ready',
      sql: `SELECT COUNT(*) AS pending_installments, COUNT(DISTINCT member_id) AS pending_members, SUM(pending_amount) AS pending_amount FROM ai_due_schedules WHERE ${scope} AND schedule_status != "PAID" AND due_date <= date("now") LIMIT 1`,
      answerMode: 'summary',
      factsNeeded: ['pending_installments', 'pending_members', 'pending_amount'],
      confidence: 0.95,
      clarification: null,
      reasoning: `${reason}: pending collection today is explicitly requested.`,
    };
  }

  if (asksName) {
    return {
      status: 'ready',
      sql: `SELECT member_name, vo_name, product_type, SUM(amount) AS collected_amount FROM ai_transactions WHERE ${scope} AND transaction_date = date("now") GROUP BY member_id, member_name, vo_name, product_type ORDER BY member_name LIMIT 20`,
      answerMode: 'member_list',
      factsNeeded: ['member_name', 'vo_name', 'product_type', 'collected_amount'],
      confidence: 0.95,
      clarification: null,
      reasoning: `${reason}: user asked which members had completed collection today.`,
    };
  }

  return {
    status: 'ready',
    sql: `SELECT COUNT(*) AS collected_transactions, COUNT(DISTINCT member_id) AS collected_members, SUM(amount) AS collected_amount FROM ai_transactions WHERE ${scope} AND transaction_date = date("now") LIMIT 1`,
    answerMode: 'summary',
    factsNeeded: ['collected_transactions', 'collected_members', 'collected_amount'],
    confidence: 0.95,
    clarification: null,
    reasoning: `${reason}: generic collection today defaults to completed collection summary today.`,
  };
}

function buildComposeMessages(config, payload) {
  const strictLlmSqlMode = Boolean(payload.strictLlmSqlMode);
  if (strictLlmSqlMode) {
    return [
      {
        role: 'system',
        content:
          '/no_think You are a microfinance field assistant. Answer only in clear, natural Bangla. Do not think step by step. Do not include analysis, markdown, or <think> blocks. Use the exact numbers in FACTS. Do not mention SQL, JSON, row, query, memory, memorial, database, or validation. Do not invent anything. Keep the answer to 1 or 2 short sentences.',
      },
      {
        role: 'user',
        content: JSON.stringify(
          {
            userQuestion: payload.question,
            staff: payload.staff,
            facts: buildStrictAnswerFacts(payload),
            glossary: {
              pending_members: 'যেসব সদস্যের আজ collection বাকি আছে',
              pending_amount: 'মোট বাকি টাকা',
              collected_members: 'যেসব সদস্যের collection হয়েছে',
              collected_amount: 'মোট আদায়',
            },
            requiredStyle:
              'Proper Bangla only. Example style: "আজ ৪৬ জন সদস্যের collection বাকি আছে। মোট বাকি টাকা ৩৬৬,৩০০ টাকা।"',
          },
          null,
          2,
        ),
      },
    ];
  }

  return [
    {
      role: 'system',
      content: '/no_think Return only the final Bangla answer. Do not think step by step. Do not include analysis, markdown, or <think> blocks.',
    },
    { role: 'system', content: config.systemPrompt },
    {
      role: 'system',
      content: strictLlmSqlMode
        ? 'You are composing the final answer after the mobile app executed the LLM-planned safe local SQLite query. Always answer in proper Bangla. Use only queryFacts and queryRows. Do not mention SQL. Do not invent names, amounts, dates, or counts.'
        : 'You are composing the final answer after the mobile app already executed a safe local SQLite query. Always answer in proper Bangla. Use suggestedBanglaAnswer as the base when present. Do not invent facts.',
    },
    {
      role: 'user',
      content: JSON.stringify(
        {
          userQuestion: payload.question,
          staff: payload.staff,
          queryPlan: payload.plan,
          queryFacts: payload.facts,
          queryRows: payload.rows,
          suggestedBanglaAnswer: payload.suggestedBanglaAnswer,
          usedOnlinePlan: payload.usedOnlinePlan,
          rules: [
            'Always answer in proper Bangla.',
            'Do not use Banglish sentence style.',
            'Keep CDO, BM, VO, DPS, NIBL, overdue, Current if needed.',
            'Mention the direct answer first, then 1-2 next actions.',
            strictLlmSqlMode ? 'Use only queryFacts and queryRows.' : 'Use only queryFacts/queryRows/suggestedBanglaAnswer.',
            'Keep it concise and conversational.',
          ],
        },
        null,
        2,
      ),
    },
  ];
}

function buildStrictAnswerFacts(payload) {
  const rows = Array.isArray(payload.rows) ? payload.rows : [];
  const first = rows[0] || {};
  const facts = {
    rowCount: rows.length,
    answerFocus: payload.facts?.sqlPlan?.answerFocus || null,
  };

  if (!('member_name' in first) && ('pending_members' in first || 'pending_amount' in first || 'pending_installments' in first)) {
    return {
      ...facts,
      intent: 'pending_collection',
      pending_members: numberOrZero(first.pending_members),
      pending_installments: numberOrZero(first.pending_installments),
      pending_amount: numberOrZero(first.pending_amount),
    };
  }

  if ('collected_transactions' in first || 'collected_members' in first || 'collected_amount' in first) {
    return {
      ...facts,
      intent: 'completed_collection',
      collected_transactions: numberOrZero(first.collected_transactions),
      collected_members: numberOrZero(first.collected_members),
      collected_amount: numberOrZero(first.collected_amount),
    };
  }

  if ('member_name' in first && rows.some((row) => 'amount' in row)) {
    const names = Array.from(new Set(rows.map((row) => row.member_name).filter(Boolean)));
    const totalAmount = rows.reduce((sum, row) => sum + numberOrZero(row.amount), 0);
    return {
      ...facts,
      intent: 'completed_collection_members',
      collected_members: names.length,
      member_names: names,
      collected_amount: totalAmount,
    };
  }

  if ('member_name' in first && rows.some((row) => 'pending_amount' in row)) {
    const names = Array.from(new Set(rows.map((row) => row.member_name).filter(Boolean)));
    const totalAmount = rows.reduce((sum, row) => sum + numberOrZero(row.pending_amount), 0);
    return {
      ...facts,
      intent: 'pending_collection_members',
      pending_members: names.length,
      member_names: names,
      pending_amount: totalAmount,
    };
  }

  if ('member_name' in first) {
    return {
      ...facts,
      intent: 'member_list',
      members: Array.from(new Set(rows.map((row) => row.member_name).filter(Boolean))),
    };
  }

  return {
    ...facts,
    intent: 'general_result',
    rows,
  };
}

function numberOrZero(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function normalizeQueryPlan(value) {
  const plan = value && typeof value === 'object' ? value : {};
  const status = ['ready', 'clarify', 'unsupported'].includes(plan.status) ? plan.status : 'unsupported';
  const sql = status === 'ready' && typeof plan.sql === 'string' ? plan.sql.trim() : null;
  const answerMode = ['summary', 'count', 'member_list', 'ranked_list', 'member_detail', 'clarification'].includes(plan.answerMode)
    ? plan.answerMode
    : status === 'clarify'
      ? 'clarification'
      : 'summary';
  const confidence = Number(plan.confidence);
  return {
    status: sql ? 'ready' : status === 'ready' ? 'unsupported' : status,
    sql,
    answerMode,
    factsNeeded: Array.isArray(plan.factsNeeded) ? plan.factsNeeded.map((item) => String(item)) : [],
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0,
    clarification: plan.clarification ? String(plan.clarification) : null,
    reasoning: plan.reasoning ? String(plan.reasoning) : '',
  };
}

function parseJsonObject(text) {
  const cleaned = String(text || '')
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(cleaned.slice(start, end + 1));
    }
    throw new Error('Model did not return JSON');
  }
}

function fallbackAnswer(task, payload) {
  if (task === 'chat') {
    return 'The model runtime is not reachable, so I am using fallback guidance. Review the local summary, prioritize overdue members, and sync again when the AI server is available.';
  }
  if (task === 'insights') {
    return [
      {
        title: 'Offline guidance active',
        message: 'The AI model server is not reachable. Continue with local nudges and sync later for richer coaching.',
        priority: 'low',
      },
    ];
  }
  return { status: 'fallback', payload };
}

async function handleApi(req, res, url) {
  if (url.pathname === '/api/ai/trace' && req.method === 'POST') {
    const body = await readBody(req);
    traceLog(body.traceId, `mobile_${body.stage || 'trace'}`, body);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (url.pathname === '/api/ai/trace-log' && req.method === 'GET') {
    if (!fs.existsSync(TRACE_LOG_PATH)) {
      sendText(res, 200, '', 'text/plain; charset=utf-8');
      return;
    }
    sendText(res, 200, fs.readFileSync(TRACE_LOG_PATH, 'utf8'), 'text/plain; charset=utf-8');
    return;
  }

  if (url.pathname === '/api/ai/health' && req.method === 'GET') {
    const config = readConfig();
    let runtimeReachable = false;
    let runtimeError = null;
    try {
      const endpoint = config.runtime === 'ollama' ? '/api/tags' : '/v1/models';
      const response = await fetch(`${config.baseUrl.replace(/\/$/, '')}${endpoint}`);
      runtimeReachable = response.ok;
      if (!response.ok) runtimeError = `HTTP ${response.status}`;
    } catch (error) {
      runtimeError = error.message;
    }
    sendJson(res, 200, {
      gateway: 'ok',
      runtimeReachable,
      runtimeError,
      launcher: {
        runtime: launcherStatus(runtimeProcess),
        app: launcherStatus(appProcess),
      },
      config: { ...publicConfig(config), apiKey: config.apiKey ? 'configured' : '' },
    });
    return;
  }

  if (url.pathname === '/api/config/model' && req.method === 'GET') {
    const config = readConfig();
    sendJson(res, 200, publicConfig(config));
    return;
  }

  if (url.pathname === '/api/config/model' && req.method === 'POST') {
    const current = publicConfig(readConfig());
    const body = await readBody(req);
    const next = { ...current, ...body };
    writeConfig(next);
    sendJson(res, 200, publicConfig(next));
    return;
  }

  if (url.pathname === '/api/runtime/status' && req.method === 'GET') {
    sendJson(res, 200, {
      runtime: launcherStatus(runtimeProcess),
      app: launcherStatus(appProcess),
      config: { ...publicConfig(readConfig()), apiKey: 'configured' },
    });
    return;
  }

  if (url.pathname === '/api/runtime/start' && req.method === 'POST') {
    const config = publicConfig(readConfig());
    try {
      const status = startRuntimeProcess(config);
      sendJson(res, 200, { ok: true, runtime: status, command: buildRuntimeCommand(config) });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error.message });
    }
    return;
  }

  if (url.pathname === '/api/runtime/stop' && req.method === 'POST') {
    try {
      const status = stopProcess(runtimeProcess, 'runtime');
      runtimeProcess = null;
      sendJson(res, 200, { ok: true, runtime: status });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error.message });
    }
    return;
  }

  if (url.pathname === '/api/runtime/restart' && req.method === 'POST') {
    try {
      if (launcherStatus(runtimeProcess).running) {
        stopProcess(runtimeProcess, 'runtime');
        runtimeProcess = null;
      }
      const status = startRuntimeProcess(publicConfig(readConfig()));
      sendJson(res, 200, { ok: true, runtime: status });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error.message });
    }
    return;
  }

  if (url.pathname === '/api/app/start' && req.method === 'POST') {
    try {
      sendJson(res, 200, { ok: true, app: startAppProcess(publicConfig(readConfig())) });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error.message });
    }
    return;
  }

  if (url.pathname === '/api/app/stop' && req.method === 'POST') {
    try {
      const status = stopProcess(appProcess, 'app');
      appProcess = null;
      sendJson(res, 200, { ok: true, app: status });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error.message });
    }
    return;
  }

  if (url.pathname === '/api/ai/chat' && req.method === 'POST') {
    const config = readConfig();
    const body = await readBody(req);
    const traceId = body.traceId || `chat-${Date.now()}`;
    const startedAt = Date.now();
    try {
      traceLog(traceId, 'gateway_received_chat', {
        question: body.question,
        staff: body.staff,
        intent: body.intent,
      });
      const messagesStartedAt = Date.now();
      const messages = buildMessages(config, 'chat', body);
      traceLog(traceId, 'llm_messages_prepared_chat', {
        durationMs: Date.now() - messagesStartedAt,
        runtime: config.runtime,
        baseUrl: config.baseUrl,
        model: config.model,
        messages,
      });
      const modelStartedAt = Date.now();
      const text = await callModel(config, messages);
      traceLog(traceId, 'llm_result_returned_chat', {
        durationMs: Date.now() - modelStartedAt,
        totalDurationMs: Date.now() - startedAt,
        text,
      });
      sendJson(res, 200, { source: 'online', text });
    } catch (error) {
      traceLog(traceId, 'llm_error_chat', {
        durationMs: Date.now() - startedAt,
        error: error.message,
      });
      sendJson(res, 200, { source: 'fallback', text: fallbackAnswer('chat', body), error: error.message });
    }
    return;
  }

  if (url.pathname === '/api/ai/plan' && req.method === 'POST') {
    const config = readConfig();
    const body = await readBody(req);
    const traceId = body.traceId || `plan-${Date.now()}`;
    const startedAt = Date.now();
    try {
      traceLog(traceId, 'gateway_received_plan', {
        question: body.question,
        staff: body.staff,
      });
      const messagesStartedAt = Date.now();
      const messages = buildPlanMessages(config, body);
      traceLog(traceId, 'llm_messages_prepared_plan', {
        durationMs: Date.now() - messagesStartedAt,
        runtime: config.runtime,
        baseUrl: config.baseUrl,
        model: config.model,
        messages,
      });
      const modelStartedAt = Date.now();
      const text = await callModel(config, messages);
      const plan = parseJsonObject(text);
      traceLog(traceId, 'llm_result_returned_plan', {
        durationMs: Date.now() - modelStartedAt,
        totalDurationMs: Date.now() - startedAt,
        raw: text,
        parsedPlan: plan,
      });
      sendJson(res, 200, { source: 'online', plan, raw: text });
    } catch (error) {
      traceLog(traceId, 'llm_error_plan', {
        durationMs: Date.now() - startedAt,
        error: error.message,
      });
      sendJson(res, 200, { source: 'fallback', plan: null, error: error.message });
    }
    return;
  }

  if (url.pathname === '/api/ai/intent' && req.method === 'POST') {
    const config = readConfig();
    const body = await readBody(req);
    const traceId = body.traceId || `intent-${Date.now()}`;
    const startedAt = Date.now();
    try {
      traceLog(traceId, 'gateway_received_intent', {
        question: body.question,
        staff: body.staff,
      });
      const messages = buildIntentMessages(config, body);
      traceLog(traceId, 'llm_messages_prepared_intent', {
        durationMs: Date.now() - startedAt,
        runtime: config.runtime,
        baseUrl: config.baseUrl,
        model: config.model,
        temperature: 0,
        maxTokens: config.maxTokens,
        messages,
      });
      const raw = await callModel(config, messages);
      const intent = parseJsonObject(raw);
      traceLog(traceId, 'llm_result_returned_intent', {
        durationMs: Date.now() - startedAt,
        raw,
        intent,
      });
      sendJson(res, 200, { source: 'online', intent, raw });
    } catch (error) {
      traceLog(traceId, 'llm_error_intent', {
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      });
      sendJson(res, 200, {
        source: 'fallback',
        error: error instanceof Error ? error.message : String(error),
        intent: { intent: 'unsupported', timeframe: 'unknown', wants: [], confidence: 0 },
      });
    }
    return;
  }

  if (url.pathname === '/api/ai/query-plan' && req.method === 'POST') {
    const config = readConfig();
    const body = await readBody(req);
    const traceId = body.traceId || `query-plan-${Date.now()}`;
    const startedAt = Date.now();
    let raw = '';
    try {
      traceLog(traceId, 'gateway_received_query_plan', {
        question: body.question,
        staff: body.staff,
        validationFeedback: body.validationFeedback || null,
      });
      const messages = buildQueryPlanMessages(config, body);
      const responseFormat = plannerResponseFormat(config);
      traceLog(traceId, 'llm_messages_prepared_query_plan', {
        durationMs: Date.now() - startedAt,
        runtime: config.runtime,
        baseUrl: config.baseUrl,
        model: config.model,
        temperature: 0,
        maxTokens: config.plannerMaxTokens ?? 320,
        responseFormat,
        messages,
      });
      raw = await callModel(config, messages, {
        temperature: 0,
        maxTokens: config.plannerMaxTokens ?? 320,
        responseFormat,
      });
      if (!String(raw || '').trim() && responseFormat) {
        traceLog(traceId, 'llm_empty_query_plan_retry_plain_json', {
          durationMs: Date.now() - startedAt,
          structuredOutputMode: config.structuredOutputMode,
        });
        raw = await callModel(config, messages, {
          temperature: 0,
          maxTokens: Math.max(Number(config.plannerMaxTokens ?? 320), 1024),
          responseFormat: null,
        });
      }
      let queryPlan = normalizeQueryPlan(parseJsonObject(raw));
      const deterministicPlan =
        queryPlan.status !== 'ready' ? buildTodayCollectionQueryPlan(body, 'deterministic_query_plan_override') : null;
      if (deterministicPlan) {
        traceLog(traceId, 'query_plan_clarification_overridden', {
          durationMs: Date.now() - startedAt,
          originalQueryPlan: queryPlan,
          queryPlan: deterministicPlan,
        });
        queryPlan = deterministicPlan;
      }
      traceLog(traceId, 'llm_result_returned_query_plan', {
        durationMs: Date.now() - startedAt,
        raw,
        queryPlan,
      });
      sendJson(res, 200, {
        source: 'online',
        queryPlan,
        sqlPlan: queryPlan.sql
          ? {
              sql: queryPlan.sql,
              reasoning: queryPlan.reasoning,
              answerFocus: queryPlan.factsNeeded.join(', '),
            }
          : null,
        raw,
      });
    } catch (error) {
      const deterministicPlan = buildTodayCollectionQueryPlan(body, 'deterministic_query_plan_fallback');
      if (deterministicPlan) {
        traceLog(traceId, 'query_plan_fallback_returned', {
          durationMs: Date.now() - startedAt,
          raw: raw ? compactLog(raw) : '',
          error: error instanceof Error ? error.message : String(error),
          queryPlan: deterministicPlan,
        });
        sendJson(res, 200, {
          source: 'guardrail',
          queryPlan: deterministicPlan,
          sqlPlan: {
            sql: deterministicPlan.sql,
            reasoning: deterministicPlan.reasoning,
            answerFocus: deterministicPlan.factsNeeded.join(', '),
          },
          raw: raw || JSON.stringify(deterministicPlan),
        });
        return;
      }
      traceLog(traceId, 'llm_error_query_plan', {
        durationMs: Date.now() - startedAt,
        raw: raw ? compactLog(raw) : '',
        error: error instanceof Error ? error.message : String(error),
      });
      sendJson(res, 200, {
        source: 'fallback',
        error: error instanceof Error ? error.message : String(error),
        queryPlan: {
          status: 'unsupported',
          sql: null,
          answerMode: 'clarification',
          factsNeeded: [],
          confidence: 0,
          clarification: null,
          reasoning: '',
        },
        sqlPlan: null,
        raw,
      });
    }
    return;
  }

  if (url.pathname === '/api/ai/sql-plan' && req.method === 'POST') {
    const config = readConfig();
    const body = await readBody(req);
    const traceId = body.traceId || `sql-plan-${Date.now()}`;
    const startedAt = Date.now();
    try {
      traceLog(traceId, 'gateway_received_sql_plan', {
        question: body.question,
        staff: body.staff,
      });
      const memberCode = extractMemberCode(body.question);
      if (body.forceLlmSqlPlanner) {
        traceLog(traceId, 'fast_sql_plan_skipped', {
          durationMs: Date.now() - startedAt,
          reason: 'strict_llm_sql_mode',
        });
      }
      if (memberCode) {
        traceLog(traceId, 'fast_sql_plan_skipped', {
          durationMs: Date.now() - startedAt,
          reason: 'member_code_question_forced_llm_sql_planner',
          memberCode,
        });
      }
      const fastPlan = body.forceLlmSqlPlanner || memberCode ? null : buildFastSqlPlan(body);
      if (fastPlan) {
        traceLog(traceId, 'fast_sql_plan_returned', {
          durationMs: Date.now() - startedAt,
          reason: fastPlan.reason,
          sqlPlan: fastPlan.sqlPlan,
        });
        sendJson(res, 200, { source: 'fast', sqlPlan: fastPlan.sqlPlan, raw: JSON.stringify(fastPlan.sqlPlan) });
        return;
      }
      const messagesStartedAt = Date.now();
      const messages = buildSqlPlanMessages(config, body);
      traceLog(traceId, 'llm_messages_prepared_sql_plan', {
        durationMs: Date.now() - messagesStartedAt,
        runtime: config.runtime,
        baseUrl: config.baseUrl,
        model: config.model,
        messages,
      });
      const modelStartedAt = Date.now();
      const text = await callModel(config, messages);
      const sqlPlan = parseJsonObject(text);
      traceLog(traceId, 'llm_result_returned_sql_plan', {
        durationMs: Date.now() - modelStartedAt,
        totalDurationMs: Date.now() - startedAt,
        raw: text,
        sqlPlan,
      });
      sendJson(res, 200, { source: 'online', sqlPlan, raw: text });
    } catch (error) {
      traceLog(traceId, 'llm_error_sql_plan', {
        durationMs: Date.now() - startedAt,
        error: error.message,
      });
      sendJson(res, 200, { source: 'fallback', sqlPlan: null, error: error.message });
    }
    return;
  }

  if (url.pathname === '/api/ai/compose' && req.method === 'POST') {
    const config = readConfig();
    const body = await readBody(req);
    const traceId = body.traceId || `compose-${Date.now()}`;
    const startedAt = Date.now();
    try {
      traceLog(traceId, 'gateway_received_compose', {
        question: body.question,
        staff: body.staff,
        plan: body.plan,
        facts: body.facts,
        rowCount: Array.isArray(body.rows) ? body.rows.length : 0,
        sampleRows: Array.isArray(body.rows) ? body.rows.slice(0, 5) : [],
        suggestedBanglaAnswer: body.suggestedBanglaAnswer,
      });
      const messagesStartedAt = Date.now();
      const messages = buildComposeMessages(config, body);
      traceLog(traceId, 'llm_messages_prepared_compose', {
        durationMs: Date.now() - messagesStartedAt,
        runtime: config.runtime,
        baseUrl: config.baseUrl,
        model: config.model,
        temperature: config.temperature,
        maxTokens: config.maxTokens,
        messages,
      });
      const modelStartedAt = Date.now();
      const text = await callModel(config, messages);
      traceLog(traceId, 'llm_result_returned_compose', {
        durationMs: Date.now() - modelStartedAt,
        totalDurationMs: Date.now() - startedAt,
        text,
      });
      sendJson(res, 200, { source: 'online', text });
    } catch (error) {
      traceLog(traceId, 'llm_error_compose', {
        durationMs: Date.now() - startedAt,
        error: error.message,
        fallbackText: body.suggestedBanglaAnswer || fallbackAnswer('chat', body),
      });
      sendJson(res, 200, {
        source: 'fallback',
        text: body.suggestedBanglaAnswer || fallbackAnswer('chat', body),
        error: error.message,
      });
    }
    return;
  }

  if (url.pathname === '/api/ai/insights' && req.method === 'POST') {
    const config = readConfig();
    const body = await readBody(req);
    const traceId = body.traceId || `insights-${Date.now()}`;
    const startedAt = Date.now();
    try {
      traceLog(traceId, 'gateway_received_insights', {
        staff: body.staff,
        intent: body.intent,
      });
      const messagesStartedAt = Date.now();
      const messages = buildMessages(config, 'insights', body);
      traceLog(traceId, 'llm_messages_prepared_insights', {
        durationMs: Date.now() - messagesStartedAt,
        runtime: config.runtime,
        baseUrl: config.baseUrl,
        model: config.model,
        messages,
      });
      const modelStartedAt = Date.now();
      const text = await callModel(config, messages);
      traceLog(traceId, 'llm_result_returned_insights', {
        durationMs: Date.now() - modelStartedAt,
        totalDurationMs: Date.now() - startedAt,
        text,
      });
      sendJson(res, 200, { source: 'online', text });
    } catch (error) {
      traceLog(traceId, 'llm_error_insights', {
        durationMs: Date.now() - startedAt,
        error: error.message,
      });
      sendJson(res, 200, { source: 'fallback', insights: fallbackAnswer('insights', body), error: error.message });
    }
    return;
  }

  sendJson(res, 404, { error: 'Not found' });
}

function serveStatic(req, res, url) {
  const filePath = url.pathname === '/' ? path.join(PUBLIC_DIR, 'index.html') : path.join(PUBLIC_DIR, url.pathname);
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(PUBLIC_DIR)) {
    sendText(res, 403, 'Forbidden');
    return;
  }
  if (!fs.existsSync(resolved)) {
    sendText(res, 404, 'Not found');
    return;
  }
  const ext = path.extname(resolved);
  const type = ext === '.html' ? 'text/html' : ext === '.css' ? 'text/css' : 'application/javascript';
  sendText(res, 200, fs.readFileSync(resolved), type);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (!isAllowedRequest(req, url)) {
      sendJson(res, 403, { error: 'This request is only allowed from the computer running the gateway.' });
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
      return;
    }
    serveStatic(req, res, url);
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
});

server.listen(PORT, () => {
  console.log(`AI Gateway running at http://localhost:${PORT}`);
  console.log(`Config panel: http://localhost:${PORT}`);
  const config = publicConfig(readConfig());
  if (config.autoStartRuntime) {
    try {
      const status = startRuntimeProcess(config);
      console.log(`Runtime auto-started with PID ${status.pid}`);
    } catch (error) {
      console.error(`Runtime auto-start failed: ${error.message}`);
    }
  }
});

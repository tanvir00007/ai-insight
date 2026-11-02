const form = document.querySelector('#configForm');
const statusBox = document.querySelector('#statusBox');
const testBox = document.querySelector('#testBox');
const commandBox = document.querySelector('#commandBox');
const testQuestion = document.querySelector('#testQuestion');
const plannerQuestion = document.querySelector('#plannerQuestion');
const presetSelect = document.querySelector('#presetSelect');

const PRESETS = {
  cpuSafe: {
    runtime: 'llamacpp',
    baseUrl: 'http://localhost:8080',
    serverBackend: 'cpu',
    serverHost: '0.0.0.0',
    serverPort: 8080,
    contextLength: 4096,
    cpuThreads: 6,
    gpuEnabled: false,
    gpuLayers: 0,
    cudaVisibleDevices: '',
    serverBatchSize: 256,
    serverUbatchSize: 64,
    serverParallel: 1,
    flashAttention: false,
    mmap: true,
    mlock: false,
    structuredOutputMode: 'json_schema',
    plannerMaxTokens: 320,
    plannerTimeoutMs: 180000,
    composerMaxTokens: 220,
    composerTimeoutMs: 180000,
    repairAttempts: 2,
  },
  remoteMsi: {
    runtime: 'llamacpp',
    baseUrl: 'http://172.26.21.25:8080',
    model: 'qwen2.5-7b-instruct-q8_0-00001-of-00003.gguf',
    apiKey: 'sk-no-key-required',
    serverBackend: 'external',
    serverExecutable: '',
    serverHost: '172.26.21.25',
    serverPort: 8080,
    contextLength: 8192,
    cpuThreads: 8,
    gpuEnabled: true,
    gpuLayers: 99,
    cudaVisibleDevices: '0',
    serverBatchSize: 512,
    serverUbatchSize: 128,
    serverParallel: 1,
    flashAttention: true,
    mmap: true,
    mlock: false,
    structuredOutputMode: 'json_schema',
    plannerMaxTokens: 1024,
    plannerTimeoutMs: 180000,
    composerMaxTokens: 512,
    composerTimeoutMs: 180000,
    repairAttempts: 2,
    reasoningModel: false,
    disableThinking: false,
    useChatTemplateKwargs: false,
    serverExtraArgs: '',
    autoStartRuntime: false,
  },
  edgeGpu9b: {
    runtime: 'llamacpp',
    baseUrl: 'http://localhost:8080',
    serverBackend: 'cuda',
    serverHost: '0.0.0.0',
    serverPort: 8080,
    contextLength: 8192,
    cpuThreads: 8,
    gpuEnabled: true,
    gpuLayers: 99,
    cudaVisibleDevices: '0',
    serverBatchSize: 512,
    serverUbatchSize: 128,
    serverParallel: 1,
    flashAttention: true,
    mmap: true,
    mlock: false,
    structuredOutputMode: 'json_schema',
    plannerMaxTokens: 360,
    plannerTimeoutMs: 180000,
    composerMaxTokens: 260,
    composerTimeoutMs: 180000,
    repairAttempts: 2,
  },
  edgeCpu9b: {
    runtime: 'llamacpp',
    baseUrl: 'http://localhost:8080',
    serverBackend: 'cpu',
    serverHost: '0.0.0.0',
    serverPort: 8080,
    contextLength: 6144,
    cpuThreads: 10,
    gpuEnabled: false,
    gpuLayers: 0,
    cudaVisibleDevices: '',
    serverBatchSize: 256,
    serverUbatchSize: 64,
    serverParallel: 1,
    flashAttention: false,
    mmap: true,
    mlock: false,
    structuredOutputMode: 'json_schema',
    plannerMaxTokens: 320,
    plannerTimeoutMs: 240000,
    composerMaxTokens: 220,
    composerTimeoutMs: 240000,
    repairAttempts: 2,
  },
  ollama: {
    runtime: 'ollama',
    baseUrl: 'http://localhost:11434',
    model: 'qwen2.5:7b',
    serverBackend: 'ollama',
    serverExecutable: 'ollama',
    serverHost: '127.0.0.1',
    serverPort: 11434,
    contextLength: 8192,
    cpuThreads: 8,
    gpuEnabled: true,
    gpuLayers: 99,
    cudaVisibleDevices: '0',
    structuredOutputMode: 'json_object',
    serverExtraArgs: '',
    plannerMaxTokens: 360,
    plannerTimeoutMs: 180000,
    composerMaxTokens: 260,
    composerTimeoutMs: 180000,
    repairAttempts: 2,
  },
  external: {
    runtime: 'llamacpp',
    baseUrl: 'http://localhost:8000/v1',
    apiKey: 'sk-no-key-required',
    serverBackend: 'external',
    serverExecutable: '',
    serverHost: '0.0.0.0',
    serverPort: 8000,
    contextLength: 8192,
    cpuThreads: 8,
    gpuEnabled: true,
    gpuLayers: 99,
    structuredOutputMode: 'json_schema',
    plannerMaxTokens: 360,
    plannerTimeoutMs: 180000,
    composerMaxTokens: 260,
    composerTimeoutMs: 180000,
    repairAttempts: 2,
  },
};

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const json = await response.json();
  if (!response.ok) throw new Error(json.error || `HTTP ${response.status}`);
  return json;
}

function setOutput(element, value) {
  element.textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

function setMetric(id, value) {
  document.querySelector(id).textContent = value == null || value === '' ? '-' : String(value);
}

function asBoolean(value) {
  return value === true || value === 'true';
}

function numeric(data, key, fallback = 0) {
  const value = Number(data.get(key));
  return Number.isFinite(value) ? value : fallback;
}

function fillForm(config) {
  for (const [key, value] of Object.entries(config)) {
    const field = form.elements.namedItem(key);
    if (!field) continue;
    field.value = typeof value === 'boolean' ? String(value) : value ?? '';
  }
  renderCommandPreview();
}

function formPayload() {
  const data = new FormData(form);
  return {
    runtime: data.get('runtime'),
    baseUrl: data.get('baseUrl'),
    model: data.get('model'),
    apiKey: data.get('apiKey'),
    temperature: numeric(data, 'temperature', 0.2),
    maxTokens: numeric(data, 'maxTokens', 220),
    plannerMaxTokens: numeric(data, 'plannerMaxTokens', 320),
    plannerTimeoutMs: numeric(data, 'plannerTimeoutMs', 180000),
    composerMaxTokens: numeric(data, 'composerMaxTokens', 220),
    composerTimeoutMs: numeric(data, 'composerTimeoutMs', 180000),
    repairAttempts: numeric(data, 'repairAttempts', 2),
    structuredOutputMode: data.get('structuredOutputMode'),
    contextLength: numeric(data, 'contextLength', 8192),
    cpuThreads: numeric(data, 'cpuThreads', 8),
    gpuEnabled: asBoolean(data.get('gpuEnabled')),
    gpuLayers: numeric(data, 'gpuLayers', 99),
    cudaVisibleDevices: data.get('cudaVisibleDevices'),
    serverBackend: data.get('serverBackend'),
    serverExecutable: data.get('serverExecutable'),
    serverHost: data.get('serverHost'),
    serverPort: numeric(data, 'serverPort', 8080),
    serverBatchSize: numeric(data, 'serverBatchSize', 512),
    serverUbatchSize: numeric(data, 'serverUbatchSize', 128),
    serverParallel: numeric(data, 'serverParallel', 1),
    flashAttention: asBoolean(data.get('flashAttention')),
    mmap: asBoolean(data.get('mmap')),
    mlock: asBoolean(data.get('mlock')),
    serverExtraArgs: data.get('serverExtraArgs'),
    autoStartRuntime: asBoolean(data.get('autoStartRuntime')),
    appStartCommand: data.get('appStartCommand'),
    systemPrompt: data.get('systemPrompt'),
  };
}

function quoteArg(value) {
  const text = String(value ?? '');
  if (!text) return '""';
  return /\s/.test(text) ? `"${text.replace(/"/g, '\\"')}"` : text;
}

function renderCommandPreview() {
  const config = formPayload();
  const backend = String(config.serverBackend || '').toLowerCase();
  if (backend === 'external') {
    commandBox.textContent = 'External runtime selected. Start vLLM/LM Studio/another OpenAI-compatible server separately, then use Health.';
    return;
  }
  if (backend === 'ollama') {
    commandBox.textContent = `${quoteArg(config.serverExecutable || 'ollama')} serve ${config.serverExtraArgs || ''}`.trim();
    return;
  }

  const args = [
    '-m',
    quoteArg(config.model),
    '--host',
    config.serverHost || '0.0.0.0',
    '--port',
    config.serverPort || 8080,
    '-c',
    config.contextLength || 4096,
    '-t',
    config.cpuThreads || 6,
  ];
  if (config.gpuEnabled) args.push('-ngl', config.gpuLayers ?? 99);
  if (config.serverBatchSize) args.push('-b', config.serverBatchSize);
  if (config.serverUbatchSize) args.push('-ub', config.serverUbatchSize);
  if (config.serverParallel) args.push('-np', config.serverParallel);
  if (config.flashAttention) args.push('-fa');
  if (config.mlock) args.push('--mlock');
  if (!config.mmap) args.push('--no-mmap');
  if (config.serverExtraArgs) args.push(config.serverExtraArgs);
  commandBox.textContent = `${quoteArg(config.serverExecutable)} ${args.join(' ')}`.trim();
}

function updateMetrics(payload) {
  setMetric('#gatewayMetric', payload.gateway || 'ok');
  setMetric('#runtimeMetric', payload.runtimeReachable === true ? 'Reachable' : payload.runtimeReachable === false ? 'Offline' : payload.runtime?.running ? 'Started' : 'Unknown');
  setMetric('#pidMetric', payload.launcher?.runtime?.pid ?? payload.runtime?.pid);
  setMetric('#appPidMetric', payload.launcher?.app?.pid ?? payload.app?.pid);
}

async function load() {
  try {
    const config = await api('/api/config/model');
    fillForm(config);
    const health = await api('/api/ai/health');
    updateMetrics(health);
    setOutput(statusBox, health);
  } catch (error) {
    setOutput(statusBox, `Load failed: ${error.message}`);
  }
}

async function saveConfig() {
  const saved = await api('/api/config/model', {
    method: 'POST',
    body: JSON.stringify(formPayload()),
  });
  fillForm(saved);
  return saved;
}

async function action(label, path, options = {}) {
  setOutput(statusBox, `${label}...`);
  const result = await api(path, { method: options.method || 'POST', body: options.body });
  updateMetrics(result);
  setOutput(statusBox, result);
  return result;
}

form.addEventListener('input', renderCommandPreview);

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const saved = await saveConfig();
    setOutput(statusBox, { ok: true, message: 'Configuration saved.', config: saved });
  } catch (error) {
    setOutput(statusBox, `Save failed: ${error.message}`);
  }
});

presetSelect.addEventListener('change', () => {
  const preset = PRESETS[presetSelect.value];
  if (!preset) return;
  fillForm({ ...formPayload(), ...preset });
  setOutput(statusBox, { ok: true, message: 'Preset applied. Review model/executable paths, then save.' });
});

document.querySelector('#healthBtn').addEventListener('click', async () => {
  try {
    const result = await api('/api/ai/health');
    updateMetrics(result);
    setOutput(statusBox, result);
  } catch (error) {
    setOutput(statusBox, `Health check failed: ${error.message}`);
  }
});

document.querySelector('#runtimeStatusBtn').addEventListener('click', async () => {
  try {
    const result = await api('/api/runtime/status');
    updateMetrics(result);
    setOutput(statusBox, result);
  } catch (error) {
    setOutput(statusBox, `Status failed: ${error.message}`);
  }
});

document.querySelector('#startRuntimeBtn').addEventListener('click', async () => {
  try {
    await saveConfig();
    await action('Starting runtime', '/api/runtime/start');
  } catch (error) {
    setOutput(statusBox, `Runtime start failed: ${error.message}`);
  }
});

document.querySelector('#restartRuntimeBtn').addEventListener('click', async () => {
  try {
    await saveConfig();
    await action('Restarting runtime', '/api/runtime/restart');
  } catch (error) {
    setOutput(statusBox, `Runtime restart failed: ${error.message}`);
  }
});

document.querySelector('#stopRuntimeBtn').addEventListener('click', async () => {
  try {
    await action('Stopping runtime', '/api/runtime/stop');
  } catch (error) {
    setOutput(statusBox, `Runtime stop failed: ${error.message}`);
  }
});

document.querySelector('#startAppBtn').addEventListener('click', async () => {
  try {
    await saveConfig();
    await action('Starting app', '/api/app/start');
  } catch (error) {
    setOutput(statusBox, `App start failed: ${error.message}`);
  }
});

document.querySelector('#stopAppBtn').addEventListener('click', async () => {
  try {
    await action('Stopping app', '/api/app/stop');
  } catch (error) {
    setOutput(statusBox, `App stop failed: ${error.message}`);
  }
});

document.querySelector('#testBtn').addEventListener('click', async () => {
  testBox.textContent = 'Running chat test...';
  try {
    const result = await api('/api/ai/chat', {
      method: 'POST',
      body: JSON.stringify({
        question: testQuestion.value,
        context: {
          role: 'BM',
          branchSummary: 'Demo context from config panel',
          instruction: 'Answer as a branch supervision assistant.',
        },
      }),
    });
    setOutput(testBox, result);
  } catch (error) {
    setOutput(testBox, `Chat test failed: ${error.message}`);
  }
});

document.querySelector('#plannerTestBtn').addEventListener('click', async () => {
  testBox.textContent = 'Running query-plan test...';
  try {
    const result = await api('/api/ai/query-plan', {
      method: 'POST',
      body: JSON.stringify({
        question: plannerQuestion.value,
        traceId: `panel-query-plan-${Date.now()}`,
        staff: { id: 101, branch_id: 1, role: 'CDO', name: 'Demo CDO' },
        schema: {
          ai_transactions: ['member_id', 'member_name', 'vo_name', 'product_type', 'amount', 'transaction_date', 'cdo_id', 'branch_id'],
          ai_due_schedules: ['member_id', 'member_name', 'vo_name', 'pending_amount', 'schedule_status', 'due_date', 'cdo_id', 'branch_id'],
          ai_cdo_portfolio: ['cdo_id', 'cdo_name', 'branch_id', 'overdue_amount', 'overdue_members', 'current_members'],
        },
      }),
    });
    setOutput(testBox, result);
  } catch (error) {
    setOutput(testBox, `Query-plan test failed: ${error.message}`);
  }
});

load();

# Microfinance Field MVP

Offline-first React Native MVP for a microfinance field operation.

## Demo users

| Role | Staff ID | PIN |
| --- | --- | --- |
| Branch Manager | BM001 | 1234 |
| CDO | CDO101 | 1111 |
| CDO | CDO102 | 2222 |
| CDO | CDO103 | 3333 |

## Run

```bash
npm install
npm run start
```

The app seeds a local SQLite database on first launch. Use **Reset demo data** from the login screen when you want to recreate the dummy portfolio.

## AI MVP

The mobile app now has:

- Offline AI insight cards for CDO and BM dashboards
- CDO ranking/performance comparison
- AI chat with local SQLite-backed answers
- Online chat enrichment through a self-hosted AI Gateway when reachable

Start the gateway:

```bash
npm run ai:start
```

Open the model configuration panel:

```text
http://localhost:8787
```

The gateway can call either:

- `llama.cpp` OpenAI-compatible server at `http://localhost:8080`
- Ollama API at `http://localhost:11434`

For CPU MVP, use a small quantized GGUF model such as Qwen2.5 3B Instruct Q4 or Llama 3.2 3B Instruct Q4. If the model runtime is unavailable, the mobile app continues with offline guidance.

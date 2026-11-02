# Microfinance Field MVP

Offline-first React Native MVP for a microfinance field operation.

This repo contains the Expo mobile app and the AI Gateway. The model runtime and model files are not included, so follow [Connect a model](#connect-a-model) if you want online chat enrichment.

## Demo users

| Role | Staff ID | PIN |
| --- | --- | --- |
| Branch Manager | BM001 | 1234 |
| CDO | CDO101 | 1111 |
| CDO | CDO102 | 2222 |
| CDO | CDO103 | 3333 |

## Requirements

- Node.js 22 and npm (tested with Node 22.17.0 and npm 11.4.2)
- A phone on the same Wi-Fi network as your computer
- Expo Go for SDK 54

This project uses Expo SDK 54. Expo Go from the app stores follows the latest SDK and may not open it. On Android, install the [SDK 54 build of Expo Go](https://expo.dev/go?sdkVersion=54&platform=android&device=true). On iPhone, check [expo.dev/go](https://expo.dev/go) for SDK 54 support.

## Run

Clone the repo, open a terminal in its folder, then run:

```bash
npm install
npm run start
```

Scan the QR code in the terminal with Expo Go.

The app seeds a local SQLite database on first launch. Use **Reset demo data** from the login screen when you want to recreate the dummy portfolio.

`npm run web` does not work yet because `react-dom` and `react-native-web` are not installed. Use a phone instead.

## AI MVP

The mobile app now has:

- Offline AI insight cards for CDO and BM dashboards
- CDO ranking/performance comparison
- AI chat with local SQLite-backed answers
- Online chat enrichment through a self-hosted AI Gateway when reachable

Start the gateway in a second terminal, on the same computer as Expo:

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

## Connect a model

`ai-server/config.json` is set to a remote `llama.cpp` server on a private network. Click **Health** in the panel to check whether it is reachable. If it is not, use one of the options below.

Saving in the panel changes `ai-server/config.json`, so commit that file only if you want the same settings on other devices.

### Use an existing llama.cpp server

1. Set **Base URL** to the server's address.
2. Set **Model** to the model file name.
3. Click **Save Configuration**, then **Health**.

The remote server uses `qwen2.5-7b-instruct-q8_0` from [Qwen/Qwen2.5-7B-Instruct-GGUF](https://huggingface.co/Qwen/Qwen2.5-7B-Instruct-GGUF/tree/main). To set it up again, download all three parts and load `qwen2.5-7b-instruct-q8_0-00001-of-00003.gguf`.

### Run a model on this computer (Windows CPU)

1. Download `llama-b9072-bin-win-cpu-x64.zip` from the [llama.cpp b9072 release](https://github.com/ggml-org/llama.cpp/releases/tag/b9072) and extract it to `tools/llama-win-cpu/`.
2. Download `qwen2.5-3b-instruct-q4_k_m.gguf` (2.1 GB) from [Qwen/Qwen2.5-3B-Instruct-GGUF](https://huggingface.co/Qwen/Qwen2.5-3B-Instruct-GGUF/tree/main).
3. In the panel, choose the **llama.cpp CPU Safe** preset.
4. Set **Runtime executable** to the full path of `llama-server.exe`, and **Model** to the full path of the `.gguf` file.
5. Click **Save Configuration**, then **Start Runtime**, then **Health**.

## Not in this repo

| Item | How to get it back |
| --- | --- |
| `node_modules/` | Run `npm install` |
| `llama.cpp` (`tools/`) | Download it as described in [Connect a model](#connect-a-model) |
| AI model files | Download them as described in [Connect a model](#connect-a-model) |
| `ai-server/logs/` | The gateway creates this folder when needed, but old logs are not restored |
| App data | Stored in SQLite on each phone. Demo data is recreated on first launch |

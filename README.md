# Local LLM Engine

This plugin is the core local AI provider for the Sequential Comic Server. It runs `llama.cpp` (`llama-server.exe`) in the background, managing GPU VRAM and providing a centralized `/api/plugins/localLlmEngine/generate` endpoint for other plugins (like the Proofreader) to query.

## Installation & Requirements

1. Ensure this folder is placed at `services/plugins/localLlmEngine`.
2. This plugin **ships with `llama-server.exe`** and its required `.dll` files in the `resources/` folder. (Redistributed under the MIT License).
3. **Bring Your Own Model:** You must download a `.gguf` model (e.g., `google_gemma-3-4b-it-Q4_K_M.gguf`) and place it directly into the `resources/` folder. The `.gitignore` is configured to ensure you do not accidentally push this massive file to GitHub.
4. Ensure the plugin is `"enabled": true` in the `plugin.json`.

## Endpoints

When enabled, this plugin provides:
* `POST /api/plugins/localLlmEngine/start` - Spawns the server and loads the model.
* `POST /api/plugins/localLlmEngine/stop` - Kills the server and frees VRAM.
* `POST /api/plugins/localLlmEngine/generate` - OpenAI-compatible completion endpoint.
* `GET /api/plugins/localLlmEngine/status` - Returns `{ isRunning: boolean }`.

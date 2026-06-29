const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

class LocalLLMEngine {
    constructor() {
        this.process = null;
        this.isRunning = false;
        this.port = 8080;
        
        // Convention over configuration: all assets go in the resources folder
        this.resourcesDir = path.join(__dirname, 'resources');
        
        // Target paths
        this.llamaServerPath = path.join(this.resourcesDir, 'llama-server.exe');
        this.modelPath = path.join(this.resourcesDir, 'google_gemma-3-4b-it-Q4_K_M.gguf');
    }

    init(subRouter) {
        console.log('[LocalLlmEngine] Initializing API routes...');
        
        // Expose a generate endpoint at POST /api/plugins/localLlmEngine/generate
        subRouter.post('/generate', async (req, res) => {
            if (!this.isRunning) {
                return res.status(503).json({ ok: false, message: 'LLM Engine is not running. Please start it via the dashboard.' });
            }

            try {
                // Forward the request body directly to llama-server
                const response = await fetch(`http://localhost:${this.port}/completion`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(req.body)
                });
                
                const data = await response.json();
                res.json({ ok: true, content: data.content });
            } catch (err) {
                console.error("[LocalLlmEngine] Generation error:", err);
                res.status(500).json({ ok: false, message: 'Generation failed', error: err.message });
            }
        });

        // Add management endpoints (so we can build a dashboard toggle UI later)
        subRouter.post('/start', async (req, res) => {
            const success = await this.start();
            res.json({ ok: success, message: success ? 'Engine Started' : 'Failed to start engine (Check logs)' });
        });

        subRouter.post('/stop', (req, res) => {
            this.stop();
            res.json({ ok: true, message: 'Engine Stopped. VRAM freed.' });
        });
        
        subRouter.get('/status', (req, res) => {
            res.json({ ok: true, isRunning: this.isRunning });
        });
    }

    async start() {
        if (this.isRunning) return true;
        
        if (!fs.existsSync(this.llamaServerPath)) {
            console.error(`[LocalLlmEngine] MISSING EXECUTABLE: You must place llama-server.exe in ${this.resourcesDir}`);
            return false;
        }

        console.log(`[LocalLlmEngine] Starting llama-server on port ${this.port}...`);
        
        try {
            this.process = spawn(this.llamaServerPath, [
                '-m', this.modelPath,
                '--port', this.port.toString(),
                '-c', '8192' // Ensure we have enough context window for our sliding pages + char bibles
            ]);

            this.process.stderr.on('data', (data) => {
                // llama.cpp prints almost everything to stderr
                if (data.toString().includes("HTTP server listening")) {
                    this.isRunning = true;
                    console.log(`[LocalLlmEngine] Server Ready on port ${this.port}.`);
                }
            });

            this.process.on('close', () => {
                this.isRunning = false;
                this.process = null;
                console.log(`[LocalLlmEngine] Server stopped.`);
            });

            // Brief wait to allow the model to load into VRAM
            return new Promise(resolve => setTimeout(() => resolve(true), 3500));
        } catch (err) {
            console.error("[LocalLlmEngine] Failed to spawn process:", err);
            return false;
        }
    }

    stop() {
        if (!this.isRunning || !this.process) return;
        console.log("[LocalLlmEngine] Stopping server and freeing VRAM...");
        this.process.kill('SIGINT');
        this.process = null;
        this.isRunning = false;
    }
}

module.exports = new LocalLLMEngine();

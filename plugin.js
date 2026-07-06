const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

class LocalLLMEngine {
    constructor() {
        this.process = null;
        this.isRunning = false;
        this.isStarting = false;
        this.port = 8080;

        // Editor presence lifecycle: the dashboard heartbeats via the
        // editor-presence hook; the watchdog frees memory once it goes quiet.
        // The grace window must survive a browser refresh without paying the
        // model load time again.
        this.lastPresence = 0;
        this.presenceTimeoutMs = 120000;

        // A manual dashboard Stop must hold until a manual Start; presence
        // beats may not resurrect a deliberately stopped engine.
        this.manualStop = false;

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
            this.manualStop = false;
            const success = await this.start();
            res.json({ ok: success, message: success ? 'Engine Started' : 'Failed to start engine (Check logs)' });
        });

        subRouter.post('/stop', (req, res) => {
            this.manualStop = true;
            this.stop();
            res.json({ ok: true, message: 'Engine Stopped. VRAM freed.' });
        });
        
        subRouter.get('/status', (req, res) => {
            res.json({ ok: true, isRunning: this.isRunning });
        });

        // Editor presence heartbeat (declared in plugin.json "hooks").
        // First beat starts the engine; the watchdog below stops it once the
        // dashboard has been closed long enough.
        subRouter.post('/hooks/editor-presence', (req, res) => {
            this.lastPresence = Date.now();
            if (!this.isRunning && !this.isStarting && !this.manualStop) {
                this.start(); // not awaited: model load takes ~60s, beats keep coming
            }
            res.json({ ok: true, running: this.isRunning, starting: this.isStarting });
        });

        setInterval(() => {
            if (!this.isRunning || !this.lastPresence) return;
            if (Date.now() - this.lastPresence > this.presenceTimeoutMs) {
                console.log('[LocalLlmEngine] No editor presence for 2 minutes; stopping to free memory.');
                this.stop();
            }
        }, 30000).unref();

        // Best-effort child cleanup when the main server exits; hard kills
        // are covered by killStalePort() on the next start.
        process.on('exit', () => this.stop());
    }

    /**
     * Kill anything already listening on our port (e.g. a llama-server
     * orphaned by a crash) so start() never binds against a stale instance.
     */
    killStalePort() {
        try {
            const out = execSync(`netstat -ano -p TCP | findstr :${this.port}`).toString();
            const pids = new Set();
            out.split('\n').forEach(line => {
                const match = line.trim().match(/LISTENING\s+(\d+)$/);
                if (match) pids.add(match[1]);
            });
            for (const pid of pids) {
                console.log(`[LocalLlmEngine] Killing stale process ${pid} holding port ${this.port}...`);
                execSync(`taskkill /F /PID ${pid}`);
            }
        } catch (err) {
            // findstr exits non-zero when nothing matches: the port is free.
        }
    }

    async start() {
        if (this.isRunning) return true;
        if (this.isStarting) return false;

        if (!fs.existsSync(this.llamaServerPath)) {
            console.error(`[LocalLlmEngine] MISSING EXECUTABLE: You must place llama-server.exe in ${this.resourcesDir}`);
            return false;
        }

        this.isStarting = true;
        this.killStalePort();
        console.log(`[LocalLlmEngine] Starting llama-server on port ${this.port}...`);

        let child;
        try {
            child = spawn(this.llamaServerPath, [
                '-m', this.modelPath,
                '--port', this.port.toString(),
                '-c', '8192' // Ensure we have enough context window for our sliding pages + char bibles
            ], { stdio: 'ignore' });
        } catch (err) {
            console.error("[LocalLlmEngine] Failed to spawn process:", err);
            this.isStarting = false;
            return false;
        }
        this.process = child;

        child.on('close', () => {
            // A superseded child must not clobber its replacement's state
            if (this.process !== child) return;
            this.isRunning = false;
            this.isStarting = false;
            this.process = null;
            console.log('[LocalLlmEngine] Server stopped.');
        });

        // Poll /health until ready: 503 while the model loads, 200 when
        // serving. Version-proof, unlike grepping llama.cpp's log strings,
        // which change between builds.
        const deadline = Date.now() + 120000; // Gemma 3 4B takes ~60s on modest hardware
        while (Date.now() < deadline && this.process === child) {
            try {
                const res = await fetch(`http://localhost:${this.port}/health`);
                if (res.ok) {
                    this.isRunning = true;
                    this.isStarting = false;
                    console.log(`[LocalLlmEngine] Server Ready on port ${this.port}.`);
                    return true;
                }
            } catch (err) {
                // Not accepting connections yet
            }
            await new Promise(resolve => setTimeout(resolve, 2000));
        }

        if (this.process === child) {
            console.error('[LocalLlmEngine] Startup timed out (120s); killing process.');
            this.stop();
        }
        return false;
    }

    stop() {
        if (!this.process) return;
        console.log("[LocalLlmEngine] Stopping server and freeing VRAM...");
        this.process.kill('SIGINT');
        this.process = null;
        this.isRunning = false;
        this.isStarting = false;
        this.lastPresence = 0;
    }
}

module.exports = new LocalLLMEngine();

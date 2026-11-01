import type { ActivityEvent, InteractionMode, ModeInfo, NotifyPayload } from './lib/protocol';
import type { ConfirmRequest } from './lib/confirm';
import type { Visual } from './components/VisualCard';

type EventCallback = (...args: unknown[]) => void;

class EventEmitter {
  private listeners: Map<string, Set<EventCallback>> = new Map();

  on(event: string, cb: EventCallback): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(cb);
    return () => {
      this.listeners.get(event)?.delete(cb);
    };
  }

  emit(event: string, ...args: unknown[]) {
    this.listeners.get(event)?.forEach((cb) => {
      try {
        cb(...args);
      } catch (err) {
        console.error(`[Emitter error on ${event}]`, err);
      }
    });
  }
}

const emitter = new EventEmitter();

// State
let miniMode = false;
let currentInteractionMode: InteractionMode = 'interactive';
let activeTurnCancelled = false;
const activityLog: ActivityEvent[] = [];
let eventCounter = 1;

function emitActivity(event: Omit<ActivityEvent, 'id' | 't'>) {
  const fullEvent: ActivityEvent = {
    id: eventCounter++,
    t: Date.now(),
    ...event,
  };
  activityLog.unshift(fullEvent);
  if (activityLog.length > 100) activityLog.pop();
  emitter.emit('jarvis-activity', fullEvent);
  return fullEvent;
}

// Telemetry simulation
const CPU_HISTORY = [14, 18, 12, 16, 22, 19, 15, 24, 18, 14, 16, 20];
const RAM_HISTORY = [54, 55, 55, 56, 55, 56, 56, 57, 56, 56, 56, 57];
const NET_DOWN = [1024, 2048, 4096, 8192, 4096, 12000, 8500, 6200, 4800, 5200, 6100, 7400];
const NET_UP = [512, 800, 1200, 950, 1400, 1800, 1100, 900, 850, 1200, 1050, 1300];

function generateTelemetry() {
  const cpu = Math.floor(12 + Math.random() * 15);
  CPU_HISTORY.shift();
  CPU_HISTORY.push(cpu);

  const ramUsed = 8.6 * 1024 * 1024 * 1024 + Math.floor(Math.random() * 200 * 1024 * 1024);
  const ramTotal = 16 * 1024 * 1024 * 1024;
  RAM_HISTORY.shift();
  RAM_HISTORY.push(Math.round((ramUsed / ramTotal) * 100));

  const down = Math.floor(3000 + Math.random() * 15000);
  const up = Math.floor(800 + Math.random() * 4000);
  NET_DOWN.shift();
  NET_DOWN.push(down);
  NET_UP.shift();
  NET_UP.push(up);

  return {
    t: Date.now(),
    cpu,
    cpuHist: [...CPU_HISTORY],
    ram: {
      used: ramUsed,
      total: ramTotal,
      pct: Math.round((ramUsed / ramTotal) * 100),
    },
    ramHist: [...RAM_HISTORY],
    net: {
      down,
      up,
      downHist: [...NET_DOWN],
      upHist: [...NET_UP],
      iface: 'eth0 (quantum-bridge)',
      ip: '192.168.1.101',
    },
    procs: [
      { name: 'jarvis-core', mb: 342, n: 1 },
      { name: 'neural-matrix', mb: 218, n: 2 },
      { name: 'telemetry-daemon', mb: 45, n: 1 },
      { name: 'whisper-engine', mb: 180, n: 1 },
      { name: 'hologram-renderer', mb: 110, n: 1 },
    ],
    jobs: ['Subsystem health monitor', 'Neural link synchronised'],
    alerts: [],
    uptime: Math.floor((Date.now() - performance.timeOrigin) / 1000),
  };
}

// Initial telemetry ticker
setInterval(() => {
  emitter.emit('telemetry', generateTelemetry());
}, 2000);

export function setupWebBridge() {
  if (typeof window === 'undefined') return;

  const electronAPI = {
    getAppVersion: async () => '1.0.0 (Web Edition)',
    openExternal: async (url: string) => {
      window.open(url, '_blank', 'noopener,noreferrer');
    },
    store: {
      get: async (key: string) => {
        try {
          const v = localStorage.getItem(`jarvis_store_${key}`);
          return v ? JSON.parse(v) : undefined;
        } catch {
          return undefined;
        }
      },
      set: async (key: string, value: unknown) => {
        try {
          localStorage.setItem(`jarvis_store_${key}`, JSON.stringify(value));
        } catch (e) {
          console.warn('LocalStorage error:', e);
        }
      },
    },
    settings: {
      get: async () => {
        return {
          baseUrl: 'https://generativelanguage.googleapis.com',
          apiKeySet: Boolean(localStorage.getItem('jarvis_api_key')),
          groqKeySet: Boolean(localStorage.getItem('jarvis_groq_key')),
          tinyfishKeySet: Boolean(localStorage.getItem('jarvis_tinyfish_key')),
          model: localStorage.getItem('jarvis_model') || 'gemini-2.5-flash',
          fallbackModels: ['gemini-2.0-flash', 'gemini-1.5-flash'],
          voice: localStorage.getItem('jarvis_voice') || 'en-GB-RyanNeural',
          awareness: localStorage.getItem('jarvis_awareness') !== 'false',
        };
      },
      set: async (patch: {
        apiKey?: string;
        groqKey?: string;
        tinyfishKey?: string;
        model?: string;
        fallbackModels?: string[];
        voice?: string;
        awareness?: boolean;
      }) => {
        if (patch.apiKey !== undefined) {
          if (patch.apiKey) localStorage.setItem('jarvis_api_key', patch.apiKey);
          else localStorage.removeItem('jarvis_api_key');
        }
        if (patch.groqKey !== undefined) {
          if (patch.groqKey) localStorage.setItem('jarvis_groq_key', patch.groqKey);
          else localStorage.removeItem('jarvis_groq_key');
        }
        if (patch.tinyfishKey !== undefined) {
          if (patch.tinyfishKey) localStorage.setItem('jarvis_tinyfish_key', patch.tinyfishKey);
          else localStorage.removeItem('jarvis_tinyfish_key');
        }
        if (patch.model) localStorage.setItem('jarvis_model', patch.model);
        if (patch.voice) localStorage.setItem('jarvis_voice', patch.voice);
        if (patch.awareness !== undefined) localStorage.setItem('jarvis_awareness', String(patch.awareness));
      },
    },
    tts: {
      synthesize: async (_text: string): Promise<Uint8Array> => {
        // Fall back to client browser speech synthesis
        throw new Error('Neural voice synthesis unavailable in browser. Falling back to system voice.');
      },
    },
    hud: {
      setMini: async (on: boolean) => {
        miniMode = on;
        emitter.emit('hud-mini', on);
      },
      onMini: (cb: (on: boolean) => void) => {
        return emitter.on('hud-mini', (val) => cb(Boolean(val)));
      },
      getMini: async () => miniMode,
    },
    telemetry: {
      get: async () => generateTelemetry(),
      onUpdate: (cb: (t: unknown) => void) => {
        return emitter.on('telemetry', cb);
      },
    },
    stt: {
      load: async (onProgress: (pct: number) => void) => {
        onProgress(100);
      },
      transcribe: async (_audio: Float32Array): Promise<string> => {
        return '';
      },
    },
    confirm: {
      reply: async (id: number, ok: boolean) => {
        emitActivity({
          kind: 'confirm',
          label: ok ? 'Confirmed' : 'Dismissed',
          detail: `User ${ok ? 'approved' : 'rejected'} security prompt #${id}`,
          status: ok ? 'ok' : 'fail',
        });
      },
    },
    modes: {
      get: async (): Promise<ModeInfo> => ({
        mode: currentInteractionMode,
        events: [...activityLog],
      }),
      set: async (mode: InteractionMode) => {
        currentInteractionMode = mode;
        emitActivity({
          kind: 'mode',
          label: 'Mode Switch',
          detail: `Operating mode set to ${mode}`,
          status: 'ok',
        });
        emitter.emit('mode-changed', { mode });
      },
    },
    ai: {
      models: async () => [
        'gemini-2.5-flash',
        'gemini-2.0-flash',
        'gemini-1.5-flash',
        'claude-3-5-sonnet',
        'gpt-4o',
      ],
      cancel: async () => {
        activeTurnCancelled = true;
      },
      chat: async (
        text: string,
        onDelta: (delta: string) => void,
        onProgress?: (note: string) => void
      ): Promise<string> => {
        activeTurnCancelled = false;
        const cid = `call_${Date.now()}`;
        const query = text.trim();

        // Check for special commands
        const lower = query.toLowerCase();

        // 1. Visual request (hologram display)
        if (
          lower.includes('visual') ||
          lower.includes('hologram') ||
          lower.includes('chart') ||
          lower.includes('project') ||
          lower.includes('graph') ||
          lower.includes('diagram')
        ) {
          onProgress?.('Generating holographic projection');
          emitActivity({
            cid,
            kind: 'visual',
            label: 'Holographic Render',
            detail: 'Generating quantum vector projection',
            status: 'busy',
          });

          await new Promise((r) => setTimeout(r, 600));
          if (activeTurnCancelled) throw new Error('Interrupted');

          const sampleVisual: Visual = {
            title: 'Subsystem Diagnostics & Quantum Core',
            html: `
              <h1>Quantum Core Telemetry</h1>
              <p class="muted">Active subsystems, energy distribution, and core harmonic resonance.</p>
              <div class="grid">
                <div class="card">
                  <div class="k">Flux Density</div>
                  <div class="v">98.4<small>%</small></div>
                  <div class="bar"><i style="width: 98%"></i></div>
                </div>
                <div class="card">
                  <div class="k">Harmonic Drift</div>
                  <div class="v">0.02<small>ms</small></div>
                  <div class="bar"><i style="width: 14%"></i></div>
                </div>
                <div class="card">
                  <div class="k">Thermal Headroom</div>
                  <div class="v">+42<small>°C</small></div>
                  <div class="bar"><i style="width: 72%"></i></div>
                </div>
              </div>
              <h2>Active Nodes</h2>
              <div class="flow">
                <div class="node">Arc Reactor Interface</div>
                <div class="arrow"></div>
                <div class="node">Quantum Decryption Matrix</div>
                <div class="arrow"></div>
                <div class="node">Neural Synthesis Array</div>
              </div>
            `,
          };

          emitter.emit('jarvis-visual', sampleVisual);

          emitActivity({
            cid,
            kind: 'visual',
            label: 'Hologram Projected',
            detail: 'Quantum telemetry card rendered to HUD',
            status: 'ok',
            ms: 580,
          });

          const reply = 'Displaying the holographic projection on your HUD now, sir.';
          for (const char of reply) {
            if (activeTurnCancelled) throw new Error('Interrupted');
            onDelta(char);
            await new Promise((r) => setTimeout(r, 15));
          }
          return reply;
        }

        // 2. Status / diagnostics / system command
        if (
          lower.includes('status') ||
          lower.includes('diagnostic') ||
          lower.includes('system') ||
          lower.includes('check') ||
          lower.includes('report')
        ) {
          onProgress?.('Auditing system metrics');
          emitActivity({
            cid,
            kind: 'tool',
            label: 'System Audit',
            detail: 'Interrogating core sensors and telemetry relays',
            status: 'busy',
          });

          await new Promise((r) => setTimeout(r, 700));
          if (activeTurnCancelled) throw new Error('Interrupted');

          emitActivity({
            cid,
            kind: 'tool',
            label: 'System Audit',
            detail: 'All 14 subsystems nominal; zero critical faults',
            status: 'ok',
            ms: 680,
          });

          const reply =
            'All systems are nominal, sir. The core matrix is operating at optimal efficiency with zero pending alerts.';
          for (const char of reply) {
            if (activeTurnCancelled) throw new Error('Interrupted');
            onDelta(char);
            await new Promise((r) => setTimeout(r, 14));
          }
          return reply;
        }

        // 3. Security confirmation test
        if (lower.includes('purge') || lower.includes('delete') || lower.includes('override')) {
          onProgress?.('Verifying command clearance');
          emitActivity({
            cid,
            kind: 'confirm',
            label: 'Security Check',
            detail: 'Action requires user authorisation',
            status: 'held',
          });

          const req: ConfirmRequest = {
            id: Date.now(),
            title: 'Security Clearance Required',
            detail: `Confirm execution of high-privilege action: "${text}"`,
          };
          emitter.emit('confirm-request', req);

          const reply = 'Security clearance required for that procedure, sir. Please confirm.';
          for (const char of reply) {
            if (activeTurnCancelled) throw new Error('Interrupted');
            onDelta(char);
            await new Promise((r) => setTimeout(r, 15));
          }
          return reply;
        }

        // 4. Default intelligent JARVIS conversational handling
        onProgress?.('Processing query');
        emitActivity({
          cid,
          kind: 'tool',
          label: 'Inference Engine',
          detail: `Synthesising response for: "${text.slice(0, 40)}"`,
          status: 'busy',
        });

        await new Promise((r) => setTimeout(r, 500));
        if (activeTurnCancelled) throw new Error('Interrupted');

        let reply = '';
        if (lower.includes('who are you') || lower.includes('your name') || lower.includes('what are you')) {
          reply =
            'I am J.A.R.V.I.S., Just A Rather Very Intelligent System. Ready to assist with research, systems monitoring, and engineering tasks, sir.';
        } else if (lower.includes('hello') || lower.includes('hi') || lower.includes('hey') || lower.includes('jarvis')) {
          reply = 'At your service, sir. What shall we tackle today?';
        } else if (lower.includes('time') || lower.includes('clock')) {
          const nowStr = new Date().toLocaleTimeString();
          reply = `The current local time is ${nowStr}, sir.`;
        } else if (lower.includes('help') || lower.includes('command') || lower.includes('what can you do')) {
          reply =
            'I can monitor telemetry, project holographic visuals, run system diagnostics, execute command sequences, and assist with computational research, sir.';
        } else {
          reply = `Certainly, sir. I have processed "${query}" through the reasoning matrix. All relevant parameters have been logged and verified.`;
        }

        emitActivity({
          cid,
          kind: 'tool',
          label: 'Inference Engine',
          detail: 'Response verified and dispatched',
          status: 'ok',
          ms: 480,
        });

        for (const char of reply) {
          if (activeTurnCancelled) throw new Error('Interrupted');
          onDelta(char);
          await new Promise((r) => setTimeout(r, 15));
        }

        // In background mode, trigger notify event
        if (currentInteractionMode === 'background') {
          const notify: NotifyPayload = {
            title: 'Task Complete',
            body: reply,
            speakLine: reply,
            ok: true,
            interrupted: false,
            task: text,
            reply,
            steps: 1,
            failures: 0,
            held: 0,
          };
          emitter.emit('jarvis-notify', notify);
        }

        return reply;
      },
    },
    on: (channel: string, func: (...args: unknown[]) => void) => {
      return emitter.on(channel, func);
    },
  };

  // Assign to window.electronAPI
  (window as unknown as { electronAPI: typeof electronAPI }).electronAPI = electronAPI;
}

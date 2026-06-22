// client.ts — Typed client for the Agent Controller.
// Demonstrates how the types in types.ts are used in practice.
// Compile with: npx tsc client.ts
import WebSocket from 'ws';
import {
  ActionName, ActionRequest, ActionResponse, TabsActionResult,
  ScreenshotResult, AgentStatus, AgentInfo, KNOWN_ACTIONS,
} from './types';

export interface ClientOptions {
  url?: string; // ws://host:port/ws
  token?: string; // bearer token matching CONTROLLER_AUTH_TOKEN
  auth?: { role: 'client' | 'agent' | 'extension' };
  requestTimeoutMs?: number;
}

export class AgentControllerClient {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<string, { resolve: (r: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout; }>();
  private connected = false;
  private extensionConnected = false;
  private readonly url: string;
  private readonly token: string | undefined;

  constructor(opts: ClientOptions = {}) {
    this.url = opts.url || 'ws://127.0.0.1:9223/ws';
    this.token = opts.token;
  }

  async connect(role: 'client' | 'agent' = 'client'): Promise<{ ok: boolean; extensionConnected: boolean }> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      const timer = setTimeout(() => reject(new Error('connect timeout')), 8000);
      ws.on('open', () => {
        ws.send(JSON.stringify({ role, ...(this.token ? { auth: this.token } : {}) }));
      });
      ws.on('message', (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.type === 'hello-ack') {
          clearTimeout(timer);
          this.connected = true;
          this.extensionConnected = m.extensionConnected;
          resolve({ ok: true, extensionConnected: m.extensionConnected });
          return;
        }
        if (m.id && this.pending.has(m.id)) {
          const p = this.pending.get(m.id)!;
          this.pending.delete(m.id);
          clearTimeout(p.timer);
          // The WS protocol returns ActionResponse (without a
          // typed result); callers cast via the typed helper methods.
          (p.resolve as (r: unknown) => void)(m);
        }
      });
      ws.on('error', (e) => { clearTimeout(timer); reject(e); });
    });
  }

  async call<T = unknown>(action: ActionName, params: Record<string, unknown> = {}, opts: { timeoutMs?: number; idempotencyKey?: string; sessionId?: string } = {}): Promise<ActionResponse & { result?: T }> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error('not connected');
    if (!KNOWN_ACTIONS.includes(action)) throw new Error('unknown action: ' + action);
    const id = String(this.nextId++);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('timeout: ' + action)); }, opts.timeoutMs || 30000);
      this.pending.set(id, { resolve, reject, timer });
      const req: ActionRequest = { id, action, params, ...(opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}), ...(opts.sessionId ? { sessionId: opts.sessionId } : {}) };
      this.ws!.send(JSON.stringify(req));
    });
  }

  async tabs(): Promise<TabsActionResult> {
    const r = await this.call<{ tabs: TabsActionResult['tabs'] }>('tabs');
    return (r.result || { tabs: [] }) as TabsActionResult;
  }

  async screenshot(format: 'png' | 'jpeg' | 'webp' = 'png', tabId?: number): Promise<ScreenshotResult> {
    const r = await this.call<{ dataUrl: string; bytes: number; format?: string }>('screenshot', { format, ...(tabId ? { tabId } : {}) });
    return r.result as ScreenshotResult;
  }

  async agentStart(goal: string, opts: { newTab?: boolean; pinned?: boolean; startUrl?: string } = {}): Promise<{ ok: boolean; runId?: string; tabId?: number; pinned?: boolean }> {
    return (await this.call('agent_start', { goal, ...opts })) as any;
  }

  async agentStatus(): Promise<AgentStatus> {
    const r = await this.call<AgentStatus>('agent_status');
    return (r.result || { active: false }) as AgentStatus;
  }

  async listAgents(): Promise<AgentInfo[]> {
    const r = await fetch('http://127.0.0.1:9223/agent/status').then((x) => x.json());
    return r.agents || [];
  }

  close(): void {
    try { this.ws?.close(); } catch { /* noop */ }
  }
}

// Example usage — uncomment to run as a CLI.
// (async () => {
//   const c = new AgentControllerClient({ url: 'ws://127.0.0.1:9223/ws' });
//   const hello = await c.connect();
//   console.log('connected, ext:', hello.extensionConnected);
//   const tabs = await c.tabs();
//   console.log('tabs:', tabs);
//   c.close();
// })();

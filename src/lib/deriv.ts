export const DERIV_LEGACY_APP_ID = "1089";

// PAT tokens use Deriv's new PAT-format App ID.
export const DERIV_NEW_APP_ID = "348IjGrNee0FZhWeA3qzx";

const DERIV_LEGACY_WS = `wss://ws.derivws.com/websockets/v3?app_id=${DERIV_LEGACY_APP_ID}`;

const DERIV_REST_BASE = "https://api.derivws.com/trading/v1/options";

export type DerivMode = "legacy" | "pat";

export interface DerivAuthResult {
  ws: DerivWS;
  loginid: string;
  currency: string;
  balance: number;
  mode: DerivMode;
}

export function detectTokenMode(token: string): DerivMode {
  // Legacy Deriv API tokens are short (~15 chars) alphanumeric strings.
  const t = token.trim();
  if (/^[a-zA-Z0-9]{10,20}$/.test(t) && !t.includes(".")) return "legacy";
  return "pat";
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function extractDerivRestError(body: any, fallback: string): string {
  return (
    body?.error?.message ||
    body?.errors?.[0]?.detail ||
    body?.errors?.[0]?.message ||
    body?.message ||
    fallback
  );
}

async function derivRest<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${DERIV_REST_BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "Deriv-App-ID": DERIV_NEW_APP_ID,
        "Content-Type": "application/json",
        ...(init?.headers || {}),
      },
    });
  } catch (error: any) {
    throw new Error(error?.message || "Could not reach Deriv PAT API");
  }

  let body: any = null;
  try {
    body = await response.json();
  } catch {}

  if (!response.ok) {
    throw new Error(extractDerivRestError(body, `Deriv PAT API failed (${response.status})`));
  }

  return body as T;
}

type Listener = (msg: any) => void;

export class DerivWS {
  mode: DerivMode = "legacy";
  private socket: WebSocket | null = null;
  private reqId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
  private listeners = new Set<Listener>();
  onClose: (() => void) | null = null;

  connect(url?: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const target = url || DERIV_LEGACY_WS;
      let ws: WebSocket;
      try {
        ws = new WebSocket(target);
      } catch (e: any) {
        reject(new Error(e?.message || "Could not open Deriv socket"));
        return;
      }
      this.socket = ws;

      const timer = setTimeout(() => reject(new Error("Deriv connection timed out")), 15000);

      ws.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error("Deriv socket error"));
      };
      ws.onclose = () => {
        this.pending.forEach((p) => p.reject(new Error("Deriv connection closed")));
        this.pending.clear();
        this.onClose?.();
      };
      ws.onmessage = (event) => {
        let msg: any;
        try {
          msg = JSON.parse(event.data as string);
        } catch {
          return;
        }
        const id = msg?.req_id;
        if (typeof id === "number" && this.pending.has(id)) {
          const p = this.pending.get(id)!;
          if (msg.error) p.reject(new Error(msg.error.message || "Deriv request failed"));
          else p.resolve(msg);
          // keep subscriptions alive: only delete for non-subscription messages
          if (!msg.subscription) this.pending.delete(id);
        }
        this.listeners.forEach((l) => {
          try {
            l(msg);
          } catch {}
        });
      };
    });
  }

  get isOpen() {
    return this.socket?.readyState === 1;
  }

  onMessage(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  send<T = any>(payload: Record<string, any>): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!this.socket || this.socket.readyState !== 1) {
        reject(new Error("Deriv socket is not connected"));
        return;
      }
      const req_id = this.reqId++;
      this.pending.set(req_id, { resolve, reject });
      this.socket.send(JSON.stringify({ ...payload, req_id }));
      setTimeout(() => {
        if (this.pending.has(req_id)) {
          this.pending.delete(req_id);
          reject(new Error("Deriv request timed out"));
        }
      }, 20000);
    });
  }

  close() {
    this.listeners.clear();
    try {
      this.socket?.close();
    } catch {}
    this.socket = null;
  }
}

export async function authorizeDeriv(rawToken: string): Promise<DerivAuthResult> {
  const token = rawToken.trim();
  if (!token) throw new Error("Empty token");

  const mode = detectTokenMode(token);

  // ==================== LEGACY ====================
  if (mode === "legacy") {
    const ws = new DerivWS();
    ws.mode = "legacy";
    await ws.connect();
    const auth = await ws.send<any>({ authorize: token });
    if (!auth?.authorize) throw new Error("Invalid token (legacy)");
    return {
      ws,
      loginid: auth.authorize.loginid,
      currency: auth.authorize.currency || "USD",
      balance: Number(auth.authorize.balance ?? 0),
      mode,
    };
  }

  // ==================== PAT ====================
  const accountsResponse = await derivRest<{ data?: any[] | any }>("/accounts", token, {
    method: "GET",
  });

  const accounts = Array.isArray(accountsResponse.data)
    ? accountsResponse.data
    : accountsResponse.data
      ? [accountsResponse.data]
      : [];

  const account = accounts.find((a) => a?.status === "active") || accounts[0];

  const accountId = String(account?.account_id || account?.id || account?.loginid || "");

  if (!accountId) throw new Error("No Deriv options account found for this PAT token");

  const otpResponse = await derivRest<{ data?: { url?: string; websocket_url?: string } }>(
    `/accounts/${encodeURIComponent(accountId)}/otp`,
    token,
    { method: "POST" }
  );

  const websocketUrl = String(otpResponse.data?.url || otpResponse.data?.websocket_url || "");

  if (!websocketUrl) throw new Error("Deriv PAT API did not return a WebSocket URL");

  const ws = new DerivWS();
  ws.mode = "pat";
  await ws.connect(websocketUrl);

  return {
    ws,
    loginid: accountId,
    currency: String(account?.currency ?? "USD"),
    balance: Number(account?.balance ?? 0),
    mode,
  };
}

export interface BuyResult {
  contract_id: number;
  buy_price: number;
  payout: number;
}

/** Buy an Only Ups (RUNHIGH) or Only Downs (RUNLOW) runs contract. Duration 2-5 ticks. */
export async function buyRiseFall(
  ws: DerivWS,
  opts: {
    symbol: string;
    contract_type: "RUNHIGH" | "RUNLOW";
    stake: number;
    ticks: number;
    currency: string;
  }
): Promise<BuyResult> {
  const stake = round2(opts.stake);
  const contractParams: Record<string, any> = {
    amount: stake,
    basis: "stake",
    contract_type: opts.contract_type,
    currency: opts.currency || "USD",
    duration: Math.min(5, Math.max(2, Math.round(opts.ticks))),
    duration_unit: "t",
  };

  if (ws.mode === "pat") {
    const proposalRes: any = await ws.send({
      proposal: 1,
      ...contractParams,
      underlying_symbol: opts.symbol,
    });
    const proposalId = proposalRes?.proposal?.id;
    if (!proposalId) throw new Error("Deriv did not return a proposal ID");
    const res: any = await ws.send({ buy: proposalId, price: stake });
    return {
      contract_id: Number(res?.buy?.contract_id),
      buy_price: Number(res?.buy?.buy_price ?? stake),
      payout: Number(res?.buy?.payout ?? 0),
    };
  }

  const res: any = await ws.send({
    buy: 1,
    price: stake,
    parameters: { ...contractParams, symbol: opts.symbol },
  });
  return {
    contract_id: Number(res?.buy?.contract_id),
    buy_price: Number(res?.buy?.buy_price ?? stake),
    payout: Number(res?.buy?.payout ?? 0),
  };
}

export const VOLATILITY_MARKETS = [
  { value: "R_10", label: "Volatility 10 Index" },
  { value: "R_25", label: "Volatility 25 Index" },
  { value: "R_50", label: "Volatility 50 Index" },
  { value: "R_75", label: "Volatility 75 Index" },
  { value: "R_100", label: "Volatility 100 Index" },
  { value: "1HZ10V", label: "Volatility 10 (1s) Index" },
  { value: "1HZ25V", label: "Volatility 25 (1s) Index" },
  { value: "1HZ50V", label: "Volatility 50 (1s) Index" },
  { value: "1HZ75V", label: "Volatility 75 (1s) Index" },
  { value: "1HZ100V", label: "Volatility 100 (1s) Index" },
];

import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Toaster } from "@/components/ui/sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  ArrowDownRight,
  ArrowUpRight,
  Plug,
  Power,
  Zap,
  Activity,
  RefreshCw,
  Trash2,
  RotateCcw,
} from "lucide-react";
import {
  authorizeDeriv,
  authorizeDerivAccount,
  buyRiseFall,
  round2,
  VOLATILITY_MARKETS,
  type DerivAccount,
  type DerivWS,
} from "@/lib/deriv";

const STORE_KEY = "deriv-runs-bot-v1";

interface Persisted {
  token: string;
  accountId: string;
  symbol: string;
  direction: string;
  entryMode: string;
  ticks: string;
  stake: string;
  martingale: string;
  takeProfit: string;
  stopLoss: string;
  history: any[];
  pnl: number;
  wins: number;
  losses: number;
}

function loadStore(): Partial<Persisted> {
  if (typeof window === "undefined") return {};
  try {
    return JSON.parse(window.localStorage.getItem(STORE_KEY) || "{}") || {};
  } catch {
    return {};
  }
}

function saveStore(patch: Partial<Persisted>) {
  if (typeof window === "undefined") return;
  try {
    const next = { ...loadStore(), ...patch };
    window.localStorage.setItem(STORE_KEY, JSON.stringify(next));
  } catch {}
}


export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Rise/Fall Deriv Bot | Ticks Martingale Trader" },
      {
        name: "description",
        content:
          "Connect a Deriv PAT token, view your balance and auto-trade Rise-only or Fall-only tick contracts with martingale, take profit and stop loss.",
      },
      { property: "og:title", content: "Rise/Fall Deriv Bot | Ticks Martingale Trader" },
      {
        property: "og:description",
        content:
          "Ups-only / downs-only Deriv tick trading with martingale, auto 2-decimal stake rounding, every-tick or normal mode.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: TraderPage,
});

type Direction = "RUNHIGH" | "RUNLOW";
type EntryMode = "normal" | "everyTick";

interface TradeRow {
  id: number;
  dir: Direction;
  stake: number;
  profit: number;
  win: boolean;
  time: string;
}

function TraderPage() {
  const s = loadStore();
  const [token, setToken] = useState(s.token || "");
  const [connecting, setConnecting] = useState(false);
  const [account, setAccount] = useState<{
    loginid: string;
    currency: string;
    mode: string;
  } | null>(null);
  const [accounts, setAccounts] = useState<DerivAccount[]>([]);
  const [balance, setBalance] = useState(0);
  const [autoRefresh, setAutoRefresh] = useState(true);

  const [symbol, setSymbol] = useState(s.symbol || "R_100");
  const [direction, setDirection] = useState<Direction>((s.direction as Direction) || "RUNHIGH");
  const [entryMode, setEntryMode] = useState<EntryMode>((s.entryMode as EntryMode) || "normal");
  const [ticks, setTicks] = useState(s.ticks || "2");
  const [stake, setStake] = useState(s.stake || "0.35");
  const [martingale, setMartingale] = useState(s.martingale || "2");
  const [takeProfit, setTakeProfit] = useState(s.takeProfit || "10");
  const [stopLoss, setStopLoss] = useState(s.stopLoss || "10");

  const [running, setRunning] = useState(false);
  const [currentStake, setCurrentStake] = useState(parseFloat(s.stake || "0.35") || 0.35);
  const [pnl, setPnl] = useState(s.pnl ?? 0);
  const [wins, setWins] = useState(s.wins ?? 0);
  const [losses, setLosses] = useState(s.losses ?? 0);
  const [price, setPrice] = useState<string>("—");
  const [openTrades, setOpenTrades] = useState(0);
  const [history, setHistory] = useState<TradeRow[]>((s.history as TradeRow[]) || []);


  const tokenInputRef = useRef<HTMLInputElement | null>(null);
  const wsRef = useRef<DerivWS | null>(null);

  const runningRef = useRef(false);
  const currentStakeRef = useRef(parseFloat(s.stake || "0.35") || 0.35);
  const pnlRef = useRef(s.pnl ?? 0);
  const openRef = useRef(0);
  const busyRef = useRef(false);
  const tokenRef = useRef(s.token || "");
  const settledRef = useRef<Set<number>>(new Set());

  const cfgRef = useRef({
    symbol,
    direction,
    entryMode,
    ticks,
    stake,
    martingale,
    takeProfit,
    stopLoss,
  });
  cfgRef.current = {
    symbol,
    direction,
    entryMode,
    ticks,
    stake,
    martingale,
    takeProfit,
    stopLoss,
  };

  const stopBot = useCallback((reason?: string) => {
    runningRef.current = false;
    setRunning(false);
    if (reason) toast.info(reason);
  }, []);

  /** Settlement + synchronous martingale */
  const processResult = useCallback(
    (dir: Direction, stakeUsed: number, profit: number) => {
      const isWin = profit >= 0;
      pnlRef.current = round2(pnlRef.current + profit);
      setPnl(pnlRef.current);
      isWin ? setWins((w) => w + 1) : setLosses((l) => l + 1);
      setHistory((h) =>
        [
          {
            id: Date.now() + Math.random(),
            dir,
            stake: stakeUsed,
            profit: round2(profit),
            win: isWin,
            time: new Date().toLocaleTimeString(),
          },
          ...h,
        ].slice(0, 40)
      );

      const base = parseFloat(cfgRef.current.stake) || 0.35;
      const mult = parseFloat(cfgRef.current.martingale);
      if (isWin) {
        currentStakeRef.current = round2(base);
      } else if (!isNaN(mult) && mult > 1) {
        // Deriv rejects stakes with more than 2 decimals -> always round to 2dp
        currentStakeRef.current = round2(currentStakeRef.current * mult);
      }
      setCurrentStake(currentStakeRef.current);

      const tp = parseFloat(cfgRef.current.takeProfit);
      const sl = parseFloat(cfgRef.current.stopLoss);
      if (!isNaN(tp) && tp > 0 && pnlRef.current >= tp) {
        stopBot(`Take profit reached: +${pnlRef.current.toFixed(2)}`);
      } else if (!isNaN(sl) && sl > 0 && pnlRef.current <= -sl) {
        stopBot(`Stop loss hit: ${pnlRef.current.toFixed(2)}`);
      }
    },
    [stopBot]
  );

  const watchContract = useCallback(
    (contractId: number, dir: Direction, stakeUsed: number) => {
      const ws = wsRef.current;
      if (!ws) return;
      const off = ws.onMessage((msg) => {
        const c = msg?.proposal_open_contract;
        if (!c || Number(c.contract_id) !== contractId) return;
        if (!c.is_sold) return;
        if (settledRef.current.has(contractId)) return;
        settledRef.current.add(contractId);
        openRef.current = Math.max(0, openRef.current - 1);
        setOpenTrades(openRef.current);
        processResult(dir, stakeUsed, Number(c.profit ?? 0));
        setBalance((b) => round2(b + Number(c.profit ?? 0)));
        try {
          if (c.subscription?.id) ws.send({ forget: c.subscription.id }).catch(() => {});
        } catch {}
        off();
      });
      ws.send({ proposal_open_contract: 1, contract_id: contractId, subscribe: 1 }).catch((e) => {
        off();
        toast.error(e?.message || "Could not track contract");
      });
    },
    [processResult]
  );

  const placeTrade = useCallback(async () => {
    const ws = wsRef.current;
    if (!ws || !ws.isOpen) return;
    if (busyRef.current) return;
    busyRef.current = true;

    const dir = cfgRef.current.direction;
    const stakeUsed = round2(currentStakeRef.current);
    const t = Math.max(2, parseInt(cfgRef.current.ticks) || 2);
    openRef.current += 1;
    setOpenTrades(openRef.current);
    try {
      const res = await buyRiseFall(ws, {
        symbol: cfgRef.current.symbol,
        contract_type: dir,
        stake: stakeUsed,
        ticks: t,
        currency: account?.currency || "USD",
      });
      if (!res.contract_id) throw new Error("Deriv did not return a contract id");
      watchContract(res.contract_id, dir, stakeUsed);
    } catch (e: any) {
      openRef.current = Math.max(0, openRef.current - 1);
      setOpenTrades(openRef.current);
      toast.error(e?.message || "Trade failed");
      stopBot("Bot stopped after a failed trade");
    } finally {
      busyRef.current = false;
    }
  }, [account?.currency, stopBot, watchContract]);

  /** Tick stream */
  const startTicks = useCallback(async (ws: DerivWS, sym: string) => {
    try {
      await ws.send({ ticks: sym, subscribe: 1 });
    } catch {
      try {
        await ws.send({ ticks: sym, underlying_symbol: sym, subscribe: 1 });
      } catch (e: any) {
        toast.error(e?.message || "Could not subscribe to ticks");
      }
    }
  }, []);

  const tickHandler = useRef<(t: any) => void>(() => {});
  tickHandler.current = (tick: any) => {
    const pip = tick.pip_size ?? 2;
    setPrice(Number(tick.quote).toFixed(pip));
    if (!runningRef.current) return;
    if (cfgRef.current.entryMode === "everyTick") {
      placeTrade();
    } else if (openRef.current === 0) {
      placeTrade();
    }
  };

  const connectRef = useRef<
    ((t: string, a?: string, silent?: boolean) => Promise<void>) | null
  >(null);

  const attachSocket = useCallback(

    (res: { ws: DerivWS; loginid: string; currency: string; mode: string }, rawToken: string) => {
      wsRef.current = res.ws;
      setAccount({ loginid: res.loginid, currency: res.currency, mode: res.mode });
      res.ws.onClose = () => {
        stopBot("Deriv connection closed — reconnecting…");
        setAccount(null);
        // Automatic reconnect with the persisted token.
        setTimeout(() => {
          if (!wsRef.current || !wsRef.current.isOpen) {
            connectRef.current?.(rawToken, loadStore().accountId, true).catch(() => {});
          }
        }, 3000);
      };
      res.ws.onMessage((msg) => {
        if (msg?.msg_type === "tick" && msg.tick) tickHandler.current(msg.tick);
        if (msg?.msg_type === "balance" && msg.balance)
          setBalance(Number(msg.balance.balance ?? 0));
      });
      res.ws.send({ balance: 1, subscribe: 1 }).catch(() => {});
    },
    [stopBot]
  );

  const connectWith = useCallback(
    async (rawToken: string, accountId?: string, silent = false) => {
      const raw = (rawToken || "").trim();
      if (!raw) {
        if (!silent) toast.error("Enter your Deriv PAT (or API) token");
        return;
      }
      setConnecting(true);
      try {
        const res = accountId
          ? await authorizeDerivAccount(raw, accountId)
          : await authorizeDeriv(raw);
        tokenRef.current = raw;
        setToken(raw);
        setAccounts(res.accounts);
        setBalance(res.balance);
        saveStore({ token: raw, accountId: res.loginid });
        attachSocket(res, raw);
        await startTicks(res.ws, cfgRef.current.symbol);
        if (!silent) toast.success(`Connected as ${res.loginid} (${res.mode.toUpperCase()})`);
      } catch (e: any) {
        if (!silent) toast.error(e?.message || "Connection failed");
      } finally {
        setConnecting(false);
      }
    },
    [attachSocket, startTicks]
  );
  connectRef.current = connectWith;



  const connect = () => {
    // Fall back to the live input value: some browsers/paste flows don't fire change.
    const raw = (tokenInputRef.current?.value || token).trim();
    connectWith(raw);
  };

  const switchAccount = async (accountId: string) => {
    stopBot();
    wsRef.current?.close();
    wsRef.current = null;
    await connectWith(tokenRef.current || token, accountId);
  };

  const disconnect = () => {
    stopBot();
    wsRef.current?.close();
    wsRef.current = null;
    setAccount(null);
    setPrice("—");
  };

  /** Manual + continuous balance refresh */
  const refreshBalance = useCallback(() => {
    const ws = wsRef.current;
    if (!ws || !ws.isOpen) return;
    ws.send({ balance: 1 })
      .then((r: any) => {
        if (r?.balance) setBalance(Number(r.balance.balance ?? 0));
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!autoRefresh || !account) return;
    const id = window.setInterval(refreshBalance, 250);
    return () => window.clearInterval(id);
  }, [autoRefresh, account, refreshBalance]);

  const clearHistory = () => {
    setHistory([]);
    saveStore({ history: [] });
    toast.success("Trade history cleared");
  };

  const resetStats = () => {
    pnlRef.current = 0;
    setPnl(0);
    setWins(0);
    setLosses(0);
    const base = round2(parseFloat(cfgRef.current.stake) || 0.35);
    currentStakeRef.current = base;
    setCurrentStake(base);
    saveStore({ pnl: 0, wins: 0, losses: 0 });
    toast.success("Stats reset");
  };

  /** Persist settings + stats */
  useEffect(() => {
    saveStore({ symbol, direction, entryMode, ticks, stake, martingale, takeProfit, stopLoss });
  }, [symbol, direction, entryMode, ticks, stake, martingale, takeProfit, stopLoss]);

  useEffect(() => {
    saveStore({ history, pnl, wins, losses });
  }, [history, pnl, wins, losses]);

  /** Auto reconnect on load with the stored token */
  const bootRef = useRef(false);
  useEffect(() => {
    if (bootRef.current) return;
    bootRef.current = true;
    const stored = loadStore();
    if (stored.token) connectWith(stored.token, stored.accountId, true);
  }, [connectWith]);

  useEffect(() => {
    const ws = wsRef.current;
    if (!ws || !ws.isOpen) return;
    startTicks(ws, symbol);
  }, [symbol, startTicks]);

  useEffect(() => () => wsRef.current?.close(), []);


  const start = () => {
    if (!wsRef.current?.isOpen) {
      toast.error("Connect to Deriv first");
      return;
    }
    const base = round2(parseFloat(stake) || 0);
    if (base < 0.35) {
      toast.error("Minimum stake is 0.35");
      return;
    }
    currentStakeRef.current = base;
    setCurrentStake(base);
    runningRef.current = true;

    setRunning(true);
    toast.success(
      `Bot started — ${direction === "RUNHIGH" ? "UPS only" : "DOWNS only"}, ${Math.max(2, parseInt(ticks) || 2)} ticks`
    );
  };

  const numField = (
    id: string,
    label: string,
    value: string,
    setter: (v: string) => void,
    step = "0.01",
    min = "0"
  ) => (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </Label>
      <Input
        id={id}
        type="number"
        step={step}
        min={min}
        value={value}
        disabled={running}
        onChange={(e) => setter(e.target.value)}
        className="num bg-secondary"
      />
    </div>
  );

  return (
    <main className="min-h-screen px-4 py-8 md:px-8">
      <Toaster />
      <div className="mx-auto max-w-5xl space-y-6">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">
              Rise / Fall Tick Bot
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Ups-only or downs-only Deriv trading · minimum 2-tick duration · auto 2dp stake
              rounding
            </p>
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Activity className="h-4 w-4 text-primary" />
            <span className="num">{price}</span>
          </div>
        </header>

        {/* Connection */}
        <section className="panel p-5">
          <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Deriv connection
          </h2>
          {!account ? (
            <div className="flex flex-col gap-3 md:flex-row md:items-end">
              <div className="flex-1 space-y-1.5">
                <Label htmlFor="token" className="text-xs uppercase tracking-wide text-muted-foreground">
                  PAT / API token
                </Label>
                <Input
                  ref={tokenInputRef}
                  id="token"
                  type="password"
                  autoComplete="off"
                  placeholder="Paste your Deriv PAT token"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  onInput={(e) => setToken((e.target as HTMLInputElement).value)}
                  className="bg-secondary"
                />

              </div>
              <Button onClick={connect} disabled={connecting} className="md:w-40">
                <Plug className="mr-2 h-4 w-4" />
                {connecting ? "Connecting…" : "Connect"}
              </Button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="grid gap-4 sm:grid-cols-3">
                <Stat label="Account" value={account.loginid} />
                <Stat label="Mode" value={account.mode.toUpperCase()} />
                <Stat
                  label="Balance"
                  value={`${balance.toFixed(2)} ${account.currency}`}
                  accent
                />
              </div>
              <Button variant="secondary" onClick={disconnect}>
                <Power className="mr-2 h-4 w-4" />
                Disconnect
              </Button>
            </div>
          )}
        </section>

        {/* Settings */}
        <section className="panel space-y-5 p-5">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Strategy
          </h2>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label className="text-xs uppercase tracking-wide text-muted-foreground">
                Direction
              </Label>
              <div className="grid grid-cols-2 gap-2">
                <Button
                  variant={direction === "RUNHIGH" ? "default" : "secondary"}
                  disabled={running}
                  onClick={() => setDirection("RUNHIGH")}
                >
                  <ArrowUpRight className="mr-2 h-4 w-4" /> Ups only
                </Button>
                <Button
                  variant={direction === "RUNLOW" ? "destructive" : "secondary"}
                  disabled={running}
                  onClick={() => setDirection("RUNLOW")}
                >
                  <ArrowDownRight className="mr-2 h-4 w-4" /> Downs only
                </Button>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs uppercase tracking-wide text-muted-foreground">
                Entry mode
              </Label>
              <div className="grid grid-cols-2 gap-2">
                <Button
                  variant={entryMode === "normal" ? "default" : "secondary"}
                  disabled={running}
                  onClick={() => setEntryMode("normal")}
                >
                  Normal
                </Button>
                <Button
                  variant={entryMode === "everyTick" ? "default" : "secondary"}
                  disabled={running}
                  onClick={() => setEntryMode("everyTick")}
                >
                  <Zap className="mr-2 h-4 w-4" /> Every tick
                </Button>
              </div>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="market" className="text-xs uppercase tracking-wide text-muted-foreground">
                Market
              </Label>
              <select
                id="market"
                value={symbol}
                disabled={running}
                onChange={(e) => setSymbol(e.target.value)}
                className="h-9 w-full rounded-md border border-input bg-secondary px-3 text-sm"
              >
                {VOLATILITY_MARKETS.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
            </div>
            {numField("ticks", "Duration (ticks, min 2)", ticks, setTicks, "1", "2")}
            {numField("stake", "Base stake", stake, setStake, "0.01", "0.35")}
            {numField("mart", "Martingale multiplier", martingale, setMartingale, "0.1", "1")}
            {numField("tp", "Take profit", takeProfit, setTakeProfit)}
            {numField("sl", "Stop loss", stopLoss, setStopLoss)}
          </div>

          <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
            {!running ? (
              <Button onClick={start} className="min-w-32">
                Start bot
              </Button>
            ) : (
              <Button variant="destructive" onClick={() => stopBot("Bot stopped")} className="min-w-32">
                Stop bot
              </Button>
            )}
            <span className="text-xs text-muted-foreground">
              Next stake <span className="num text-foreground">{currentStake.toFixed(2)}</span> ·
              open trades <span className="num text-foreground">{openTrades}</span>
            </span>
          </div>
        </section>

        {/* Stats */}
        <section className="grid gap-4 sm:grid-cols-4">
          <div className="panel p-4">
            <Stat label="P/L" value={`${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}`} accent={pnl >= 0} danger={pnl < 0} />
          </div>
          <div className="panel p-4">
            <Stat label="Wins" value={String(wins)} accent />
          </div>
          <div className="panel p-4">
            <Stat label="Losses" value={String(losses)} danger />
          </div>
          <div className="panel p-4">
            <Stat label="Current stake" value={currentStake.toFixed(2)} />
          </div>
        </section>

        {/* History */}
        <section className="panel p-5">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Trade history
          </h2>
          {history.length === 0 ? (
            <p className="text-sm text-muted-foreground">No trades yet.</p>
          ) : (
            <div className="divide-y divide-border">
              {history.map((t) => (
                <div key={t.id} className="flex items-center justify-between py-2 text-sm">
                  <span className="flex items-center gap-2">
                    {t.dir === "RUNHIGH" ? (
                      <ArrowUpRight className="h-4 w-4 text-up" />
                    ) : (
                      <ArrowDownRight className="h-4 w-4 text-down" />
                    )}
                    <span className="text-muted-foreground">{t.time}</span>
                  </span>
                  <span className="num text-muted-foreground">stake {t.stake.toFixed(2)}</span>
                  <span className={`num font-medium ${t.win ? "text-up" : "text-down"}`}>
                    {t.profit >= 0 ? "+" : ""}
                    {t.profit.toFixed(2)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}

function Stat({
  label,
  value,
  accent,
  danger,
}: {
  label: string;
  value: string;
  accent?: boolean;
  danger?: boolean;
}) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p
        className={`num mt-1 text-lg font-semibold ${
          danger ? "text-down" : accent ? "text-up" : "text-foreground"
        }`}
      >
        {value}
      </p>
    </div>
  );
}

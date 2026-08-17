# Deriv Up/Down Bot

create a deriv trading tool that trades only ups only downs which has a minimum of 2 ticks trADE DURATION USER ENTERS pat token and cnnects to deriv it fetches and displays balance then fields to set stake martingale tp and SL  if new stake after martingale has more than 2 decimal places it should auto round of to 2dp since deriv doesnt allow stake more than 2 decimals .a button to choose every tick mode or normal mode ,,,,for pat connection here is the exact code:// src/lib/deriv.ts

export const DERIV_LEGACY_APP_ID = "1089";

// PAT tokens use Deriv's new PAT-format App ID.

export const DERIV_NEW_APP_ID = "33uaaVh8xkm8lpUWTHDkm";

const DERIV_LEGACY_WS =

  `wss://ws.derivws.com/websockets/v3?app_id=${DERIV_LEGACY_APP_ID}`;

const DERIV_REST_BASE =

  "https://api.derivws.com/trading/v1/options";

async function derivRest<T>(

  path: string,

  token: string,

  init?: RequestInit

): Promise<T> {

  let response: Response;

  try {

    response = await fetch(`${DERIV_REST_BASE}${path}`, {

      ...init,

      headers: {

        "Authorization": `Bearer ${token}`,

        "Deriv-App-ID": DERIV_NEW_APP_ID,

        "Content-Type": "application/json",

        ...(init?.headers || {}),

      },

    });

  } catch (error: any) {

    throw new Error(

      error?.message || "Could not reach Deriv PAT API"

    );

  }

  let body: any = null;

  try { body = await response.json(); } catch {}

  if (!response.ok) {

    throw new Error(

      extractDerivRestError(

        body,

        `Deriv PAT API failed (${response.status})`

      )

    );

  }

  return body as T;

}

export async function authorizeDeriv(

  rawToken: string

): Promise<DerivAuthResult> {

  const token = rawToken.trim();

  if (!token) throw new Error("Empty token");

  const mode = detectTokenMode(token);

  // ==================== LEGACY ====================

  if (mode === "legacy") {

    const ws = new DerivWS();

    ws.mode = "legacy";

    await ws.connect();

    const auth = await ws.send<any>({

      authorize: token

    });

    if (!auth?.authorize) {

      throw new Error("Invalid token (legacy)");

    }

    return {

      ws,

      loginid: auth.authorize.loginid,

      currency: auth.authorize.currency || "USD",

      balance: Number(auth.authorize.balance ?? 0),

      mode,

    };

  }

  // ==================== PAT ====================

  // Step 1: Get accounts list via REST

  const accountsResponse =

    await derivRest<{ data?: any[] | any }>(

      "/accounts",

      token,

      { method: "GET" }

    );

  const accounts = Array.isArray(accountsResponse.data)

    ? accountsResponse.data

    : accountsResponse.data

      ? [accountsResponse.data]

      : [];

  const account =

    accounts.find((a) => a?.status === "active") ||

    accounts[0];

  const accountId = String(

    account?.account_id ||

    account?.id ||

    account?.loginid ||

    ""

  );

  if (!accountId) {

    throw new Error(

      "No Deriv options account found for this PAT token"

    );

  }

  // Step 2: Request OTP to get an authenticated WebSocket URL

  const otpResponse =

    await derivRest<{

      data?: {

        url?: string;

        websocket_url?: string

      }

    }>(

      `/accounts/${encodeURIComponent(accountId)}/otp`,

      token,

      { method: "POST" }

    );

  const websocketUrl = String(

    otpResponse.data?.url ||

    otpResponse.data?.websocket_url ||

    ""

  );

  if (!websocketUrl) {

    throw new Error(

      "Deriv PAT API did not return a WebSocket URL"

    );

  }

  // Step 3: Connect directly using authenticated URL

  const ws = new DerivWS();

  ws.mode = "pat";

  await ws.connect(websocketUrl);

  // Values come from the REST account object.

  const balance = Number(account?.balance ?? 0);

  const currency = String(account?.currency ?? "USD");

  const loginid = accountId;

  return {

    ws,

    loginid,

    currency,

    balance,

    mode

  };

}                                                                                                                                                                                FOR  INPUT VALIDATION  ERROR WHEN RUNNING TRADES AFTER USING PAT CONNECTION FIX WITH THIS:// src/lib/botEngine.ts

const contractParams = {

  amount: stake,

  basis: "stake",

  contract_type: type,

  currency: "USD",

  duration: 1,

  duration_unit: "t",

  barrier: String(prediction),

};

const buyRes = this.ws.mode === "pat"

  ? await this.buyViaProposal(contractParams, stake)

  : await this.ws.send({

      buy: 1,

      price: stake,

      parameters: {

        ...contractParams,

        symbol: this.cfg.symbol

      },

    });

private async buyViaProposal(

  contractParams: Record<string, any>,

  stake: number

): Promise<any> {

  const proposalRes: any = await this.ws.send({

    proposal: 1,

    ...contractParams,

    underlying_symbol: this.cfg.symbol,

  });

  const proposalId = proposalRes?.proposal?.id;

  if (!proposalId) {

    throw new Error("Deriv did not return a proposal ID");

  }

  return this.ws.send({

    buy: proposalId,

    price: stake

  });

}                                                                                                                                                                             FOR BUY EVERY TICK AND IMMEDIATE MARTINGALE USE:// 1. Place trade

const placeTradeInternal = useCallback(async () => {

  if (tradeStateRef.current !== 'idle') return;

  const stake = currentStakeRef.current;

  const market = selectedMarketRef.current;

  const cur = currencyRef.current;

  tradeStateRef.current = 'buying';

  setTradeState('buying');

  try {

    const barrier =

      parseInt(configRef.current.barrier) || 7;

    const result =

      await derivApi.buyDigitUnder(

        market,

        stake,

        barrier,

        cur

      );

    pendingTradeRef.current = {

      buyPrice: result.buy_price,

      payout: result.payout,

    };

    tradeStateRef.current = 'awaiting';

    setTradeState('awaiting');

  } catch (error) {

    const msg =

      error instanceof Error

        ? error.message

        : 'Trade failed';

    toast.error(msg);

    tradeStateRef.current = 'idle';

    setTradeState('idle');

  }

}, []);

// 2. Tick handler

const tickHandlerRef =

  useRef<(tick: any) => void>(() => {});

tickHandlerRef.current = (tick: any) => {

  const pipSize = tick.pip_size || 2;

  const priceStr =

    Number(tick.quote).toFixed(pipSize);

  setCurrentPrice(priceStr);

  const digit =

    parseInt(priceStr[priceStr.length - 1]);

  setLastDigit(digit);

  const newHistory =

    [...digitHistoryRef.current, digit].slice(-200);

  digitHistoryRef.current = newHistory;

  setDigitHistory(newHistory);

  onTickCallbackRef.current?.(digit);

  onTickCallback2Ref.current?.(digit);

  // Settle pending trade on THIS tick

  if (

    tradeStateRef.current === 'awaiting' &&

    pendingTradeRef.current

  ) {

    const barrier =

      parseInt(configRef.current.barrier) || 7;

    const isWin = digit < barrier;

    const {

      buyPrice,

      payout

    } = pendingTradeRef.current;

    const profit =

      isWin ? payout - buyPrice : -buyPrice;

    processResult(

      isWin,

      profit,

      digit,

      buyPrice

    );

    pendingTradeRef.current = null;

    tradeStateRef.current = 'idle';

    setTradeState('idle');

  }

  // Auto-trade on the SAME tick

  if (

    isAutoTradingRef.current &&

    tradeStateRef.current === 'idle'

  ) {

    const conditions = autoConditionsRef.current;

    const history = digitHistoryRef.current;

    for (const condition of conditions) {

      const n =

        parseInt(condition.consecutiveOver);

      if (

        isNaN(n) ||

        n < 1 ||

        history.length < n

      ) continue;

      const lastN = history.slice(-n);

      const barrier =

        parseInt(configRef.current.barrier) || 7;

      const allOver =

        lastN.every(d => d >= barrier);

      if (allOver) {

        placeTradeInternal();

        break;

      }

    }

  }

};

// 3. Synchronous martingale update

const baseStake =

  parseFloat(configRef.current.stake) || 0.35;

const multiplier =

  parseFloat(configRef.current.martingale);

if (isWin) {

  setCurrentStake(baseStake);

  currentStakeRef.current = baseStake;

} else if (

  !isNaN(multiplier) &&

  multiplier > 1

) {

  const newStake =

    Math.round(

      currentStakeRef.current *

      multiplier *

      100

    ) / 100;

  setCurrentStake(newStake);

  currentStakeRef.current = newStake;

}                                                                                                                                                                              THEN HIDE LOVABLE BADGE USING THIS CODE:The CSS I appended to the end of src/styles.css:

/* Visually hide the Lovable badge overlay without disabling it in project settings. */

#lovable-badge,

a#lovable-badge,

[id^="lovable-badge"],

[class*="lovable-badge"],

a[href*="lovable.dev/projects"],

a[href*="lovable.dev?utm"],

a[href*="lovable.dev/?utm"] {

  display: none !important;

  opacity: 0 !important;

  pointer-events: none !important;

  visibility: hidden !important;

}

That's the whole snippet — no settings changed, the badge just never renders visibly.

This project was built with [Lovable](https://lovable.dev).

## Build with Lovable

Continue developing this project in the [Lovable editor](https://lovable.dev/projects/fb005e6b-4f92-4006-a807-30cc7cda2ef7).

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: every change made in Lovable is committed straight to this repository.
- **Full ownership**: this code is yours. Push to `main` on GitHub and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```

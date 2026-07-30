/**
 * Cashfree integration.
 * Uses environment variables so deployments can switch between sandbox and production safely.
 *
 * Mode selection rules:
 *   - Localhost requests → sandbox by default (prevents accidental real charges during dev)
 *   - Set CASHFREE_ALLOW_LOCAL_PRODUCTION=true to use production mode on localhost
 *   - Remote requests → uses CASHFREE_MODE env var (production or sandbox)
 */

type CashfreeMode = 'sandbox' | 'production';

const CASHFREE_MODE = (process.env.CASHFREE_MODE || 'sandbox').toLowerCase();
const ALLOW_LOCAL_PRODUCTION = process.env.CASHFREE_ALLOW_LOCAL_PRODUCTION === 'true';
const PRODUCTION_BASE_URL = 'https://api.cashfree.com/pg';
const SANDBOX_BASE_URL = 'https://sandbox.cashfree.com/pg';

const APP_ID = process.env.CASHFREE_APP_ID?.trim();
const SECRET_KEY = process.env.CASHFREE_SECRET_KEY?.trim();

function getHostname(value?: string) {
  if (!value) return '';
  try {
    const url = value.startsWith('http') ? new URL(value) : new URL(`https://${value}`);
    return url.hostname.toLowerCase();
  } catch {
    return value.toLowerCase();
  }
}

function isLocalHostname(hostname: string) {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname.startsWith('192.168.') ||
    hostname.startsWith('10.') ||
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(hostname)
  );
}

function detectKeyMode(): CashfreeMode {
  if (!SECRET_KEY) return 'sandbox';
  return SECRET_KEY.includes('_prod_') ? 'production' : 'sandbox';
}

function getRuntime(origin?: string): { mode: CashfreeMode; baseUrl: string } {
  const hostname = getHostname(origin);
  const localRequest = isLocalHostname(hostname);
  const configuredMode = CASHFREE_MODE as CashfreeMode;
  const keyMode = detectKeyMode();

  if (configuredMode !== keyMode) {
    console.warn(
      `Cashfree mode mismatch: CASHFREE_MODE="${configuredMode}" but key is ${keyMode}. Using "${keyMode}".`
    );
  }

  const effectiveMode: CashfreeMode = keyMode;

  if (localRequest && effectiveMode === 'production' && !ALLOW_LOCAL_PRODUCTION) {
    console.warn('Localhost production blocked. Set CASHFREE_ALLOW_LOCAL_PRODUCTION=true to allow.');
    return { mode: 'sandbox', baseUrl: SANDBOX_BASE_URL };
  }

  return {
    mode: effectiveMode,
    baseUrl: effectiveMode === 'production' ? PRODUCTION_BASE_URL : SANDBOX_BASE_URL,
  };
}

function getSafeBaseUrl(origin?: string): string {
  const configuredFrontendUrl = process.env.FRONTEND_URL?.trim();
  const vercelUrl = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : '';
  const originIsLocal = isLocalHostname(getHostname(origin));
  return originIsLocal
    ? configuredFrontendUrl || origin || 'http://localhost:3000'
    : configuredFrontendUrl || origin || vercelUrl || 'http://localhost:3000';
}

function getReturnUrl(origin?: string) {
  return `${getSafeBaseUrl(origin).replace(/\/$/, '')}/order-success?order_id={order_id}`;
}

export async function createCashfreeOrder(payload: any, origin?: string) {
  try {
    if (!APP_ID || !SECRET_KEY) {
      return { error: 'Cashfree credentials are not configured' };
    }

    const runtime = getRuntime(origin);
    const response = await fetch(`${runtime.baseUrl}/orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-version': '2023-08-01',
        'x-client-id': APP_ID,
        'x-client-secret': SECRET_KEY,
      },
      body: JSON.stringify({
        order_id: payload.orderId,
        order_amount: payload.amount,
        order_currency: 'INR',
        customer_details: {
          customer_id: (payload.email || 'guest').replace(/[^a-zA-Z0-9]/g, '_'),
          customer_name: payload.name,
          customer_email: payload.email,
          customer_phone: (payload.phone || '').replace(/[^0-9]/g, '').slice(-10) || '9999999999',
        },
        order_meta: {
          return_url: getReturnUrl(origin),
          notify_url: `${getSafeBaseUrl(origin).replace(/\/$/, '')}/api/webhooks/cashfree`,
        },
      }),
    });

    const text = await response.text();
    let data: any = {};
    try { data = JSON.parse(text); } catch { data = { message: text }; }
    if (!response.ok) {
      console.error('Cashfree raw error response:', { status: response.status, body: text });
      return { error: data.message || data.error || `Cashfree API Error (${response.status})` };
    }
    return { data, mode: runtime.mode };
  } catch (err: any) {
    return { error: err?.message || 'Connection to Cashfree failed' };
  }
}

export async function verifyCashfreePayment(orderId: string, origin?: string) {
  try {
    if (!APP_ID || !SECRET_KEY) return false;

    const runtime = getRuntime(origin);
    const response = await fetch(`${runtime.baseUrl}/orders/${orderId}`, {
      method: 'GET',
      headers: {
        'x-api-version': '2023-08-01',
        'x-client-id': APP_ID,
        'x-client-secret': SECRET_KEY,
      },
    });

    const data = await response.json() as any;
    if (!response.ok) return false;
    return data.order_status === 'PAID';
  } catch {
    return false;
  }
}

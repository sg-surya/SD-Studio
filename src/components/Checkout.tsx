import { type FormEvent, useMemo, useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { ArrowRight, X, ShoppingBag, MapPin, CreditCard, CheckCircle2, Loader2, AlertTriangle } from 'lucide-react';
import toast from 'react-hot-toast';
import { Address, CartItem, Order } from '../types';
import { getOrderTotals, isValidCoupon } from '../utils/commerce';
import { addressSchema, validateForm } from '../utils/validation';
import { useCartStore, useOrderStore, useUserStore } from '../utils/store';
import { useSiteSettings } from '../utils/siteSettings';
import CheckoutSummary from './CheckoutSummary';
import { BRAND_NAME } from '../brand';

const STORAGE_KEY = 'sd_checkout_address';

async function readApiResponse(res: Response) {
  const contentType = res.headers.get('content-type') || '';
  const body = await res.text();

  if (contentType.includes('application/json')) {
    try {
      return body ? JSON.parse(body) : {};
    } catch {
      throw new Error('Payment server returned malformed JSON.');
    }
  }

  if (res.status === 401 || body.includes('Protected deployment') || body.includes('sso-api')) {
    throw new Error('Vercel deployment is protected. Disable Deployment Protection or test on the production domain.');
  }

  throw new Error(`Payment server returned ${res.status || 'an invalid response'}. Check Vercel function logs.`);
}

let sdkLoadPromise: Record<string, Promise<any>> = {};

function loadCashfreeSdk(mode: string): Promise<any> {
  if (sdkLoadPromise[mode]) return sdkLoadPromise[mode];

  sdkLoadPromise[mode] = new Promise((resolve, reject) => {
    delete (window as any).Cashfree;

    const script = document.createElement('script');
    script.src = mode === 'production'
      ? 'https://sdk.cashfree.com/js/v3/cashfree.js'
      : 'https://sandbox.cashfree.com/js/v3/cashfree.js';
    script.async = true;
    script.onload = () => {
      if ((window as any).Cashfree) resolve((window as any).Cashfree);
      else reject(new Error('Cashfree SDK loaded but global not found'));
    };
    script.onerror = () => {
      delete sdkLoadPromise[mode];
      reject(new Error('Failed to load Cashfree SDK'));
    };
    document.body.appendChild(script);
  });

  return sdkLoadPromise[mode];
}

export default function Checkout({ isOpen, items, onClose, onComplete }: { isOpen: boolean; items: CartItem[]; onClose: () => void; onComplete: (o: Order) => void }) {
  // Initialize with empty address
  const [address, setAddress] = useState<Address>({ fullName: '', email: '', phone: '', street: '', city: '', state: '', pincode: '', country: 'India' });
  const [couponCode, setCouponCode] = useState('');
  const [appliedCoupon, setAppliedCoupon] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [isProcessing, setIsProcessing] = useState(false);
  const [sdkError, setSdkError] = useState('');

  const { addOrder } = useOrderStore();
  const { clearCart } = useCartStore();
  const { isAuthenticated, token } = useUserStore();
  const siteSettings = useSiteSettings();
  const cashfreeRef = useRef<any>(null);

  // Load saved address on mount
  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      try {
        setAddress(JSON.parse(saved));
      } catch (e) {
        console.error('Failed to parse saved address');
      }
    }
  }, []);

  // Save address whenever it changes
  useEffect(() => {
    if (address.fullName || address.email || address.phone || address.street) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(address));
    }
  }, [address]);

  const totals = useMemo(() => getOrderTotals(items, appliedCoupon, siteSettings), [items, appliedCoupon, siteSettings]);

  const initiatePayment = async (e: FormEvent) => {
    e.preventDefault();
    const val = validateForm(addressSchema, address);
    if (!val.success) { setErrors(val.errors); return; }

    if (!isAuthenticated) {
      toast.error('Please sign in to place an order');
      setIsProcessing(false);
      return;
    }

    setSdkError('');
    const orderId = `SD-ORD-${Date.now().toString(36).toUpperCase()}`;
    const authHeaders: Record<string, string> = token ? { 'Authorization': `Bearer ${token}` } : {};

    try {
      // Try Cashfree first
      const cfRes = await fetch('/api/payments/cashfree/order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        credentials: 'same-origin',
        body: JSON.stringify({ orderId, amount: totals.total, customerName: address.fullName, customerEmail: address.email, customerPhone: address.phone })
      });

      const cfData = await readApiResponse(cfRes);

      if (!cfRes.ok || !cfData.success) {
        throw new Error(cfData.error || 'Payment gateway unavailable');
      }

      const Cashfree = await loadCashfreeSdk(cfData.cashfreeMode ?? 'sandbox');
      cashfreeRef.current = Cashfree({ mode: cfData.cashfreeMode ?? 'sandbox' });

      cashfreeRef.current.checkout({ paymentSessionId: cfData.paymentSessionId, redirectTarget: "_modal" })
        .then(async (result: any) => {
          if (result.error) { toast.error(result.error.message); setIsProcessing(false); return; }

          const vRes = await fetch('/api/payments/cashfree/verify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders },
            credentials: 'same-origin',
            body: JSON.stringify({ orderId, orderPayload: { id: orderId, items, ...totals, shippingAddress: address, couponCode: appliedCoupon } })
          });

          const vData = await readApiResponse(vRes);
          if (vData.success) {
            addOrder(vData.order);
            clearCart();
            toast.success('Payment Received!');
            onComplete(vData.order);
          } else {
            throw new Error(vData.error);
          }
          setIsProcessing(false);
        })
        .catch((err: any) => {
          toast.error(err?.message || 'Payment verification failed');
          setIsProcessing(false);
        });
    } catch (err: any) {
      const msg = err.message || 'Payment Failed';
      setSdkError(msg);
      toast.error(msg);
      setIsProcessing(false);
    }
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-[90] flex items-center justify-center p-4">
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="absolute inset-0 bg-zinc-950/70 backdrop-blur-sm" onClick={!isProcessing ? onClose : undefined} />
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 20 }} className="relative w-full max-w-6xl max-h-[92vh] overflow-y-auto bg-white dark:bg-zinc-900 rounded-2xl shadow-2xl">
            <div className="sticky top-0 z-10 bg-white dark:bg-zinc-900 border-b border-zinc-100 dark:border-zinc-800 px-6 py-5 flex items-center justify-between rounded-t-2xl">
               <h2 className="text-xl font-bold">{BRAND_NAME} Checkout</h2>
               {!isProcessing && <button onClick={onClose} aria-label="Close"><X className="w-5 h-5 text-zinc-400" /></button>}
            </div>

            <form onSubmit={initiatePayment} className="grid grid-cols-1 lg:grid-cols-[1fr_360px]">
              <div className="p-6 md:p-10 space-y-8">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                  {[
                    { key: 'fullName', label: 'Full Name', type: 'text', autocomplete: 'name' },
                    { key: 'email', label: 'Email Address', type: 'email', autocomplete: 'email' },
                    { key: 'phone', label: 'Phone Number', type: 'tel', autocomplete: 'tel' },
                    { key: 'city', label: 'City', type: 'text', autocomplete: 'address-level2' },
                    { key: 'state', label: 'State', type: 'text', autocomplete: 'address-level1' },
                    { key: 'pincode', label: 'Pincode', type: 'text', autocomplete: 'postal-code' },
                  ].map((f) => (
                    <label key={f.key} className="block">
                      <span className="text-[10px] font-black uppercase text-zinc-400 mb-1.5 block">{f.label}</span>
                      <input
                        value={(address as any)[f.key]}
                        onChange={e => {setAddress({...address, [f.key]: e.target.value}); setErrors({...errors, [f.key]: ''})}}
                        disabled={isProcessing}
                        type={f.type}
                        autoComplete={f.autocomplete}
                        className={`w-full border rounded-xl p-4 text-base outline-none bg-transparent transition-colors ${errors[f.key] ? 'border-red-500' : 'border-zinc-200 dark:border-zinc-700 focus:border-[#925FE2]'}`}
                      />
                      {errors[f.key] && <span className="text-[10px] text-red-500 font-bold mt-1 block">{errors[f.key]}</span>}
                    </label>
                  ))}
                  <label className="block md:col-span-2">
                    <span className="text-[10px] font-black uppercase text-zinc-400 mb-1.5 block">Street Address</span>
                    <textarea
                      value={address.street}
                      onChange={e => setAddress({...address, street: e.target.value})}
                      disabled={isProcessing}
                      rows={3}
                      autoComplete="street-address"
                      className="w-full border border-zinc-200 dark:border-zinc-700 rounded-xl p-4 text-base outline-none bg-transparent focus:border-[#925FE2] transition-colors"
                    />
                  </label>
                </div>
              </div>

              <CheckoutSummary items={items} {...totals}>
                <div className="flex gap-2">
                  <input value={couponCode} onChange={e => setCouponCode(e.target.value)} placeholder="Coupon" className="flex-1 border rounded-lg px-3 py-2 text-sm dark:bg-zinc-800 dark:border-zinc-700 outline-none focus:border-[#925FE2]" />
                  <button type="button" onClick={() => { (siteSettings as any).coupons?.[couponCode.toUpperCase()] ? (setAppliedCoupon(couponCode.toUpperCase()), toast.success('Applied!')) : toast.error('Invalid') }} className="px-4 border rounded-lg text-sm hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors">Apply</button>
                </div>
                {sdkError && (
                  <div className="flex items-start gap-2 p-3 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 rounded-xl text-xs text-red-700 dark:text-red-400">
                    <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                    <span>{sdkError}</span>
                  </div>
                )}
                <button type="submit" disabled={isProcessing} className="do-btn-primary w-full py-4 flex items-center justify-center gap-2 disabled:opacity-50">
                  {isProcessing ? <Loader2 className="animate-spin" /> : 'Pay Securely'} <ArrowRight className="w-4 h-4" />
                </button>
                <p className="text-[10px] text-center text-zinc-400">Secured by Cashfree · Production Ready</p>
              </CheckoutSummary>
            </form>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}

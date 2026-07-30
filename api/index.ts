import express from 'express';
import type { Express, NextFunction, Request, Response } from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import '../server/env'; // Load env first

const app: Express = express();

// Middleware
app.use(cors({ origin: true, credentials: true }));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
  if (err) {
    return res.status(err.status || 400).json({
      success: false,
      error: err?.message || 'Invalid request body',
    });
  }
  return next();
});

// --- CASHFREE ---
app.post('/api/payments/cashfree/order', async (req: Request, res: Response) => {
  try {
    const { createCashfreeOrder } = await import('../server/lib/cashfree');
    const { orderId, amount, customerName, customerEmail, customerPhone } = req.body;
    const origin = req.headers.origin;
    const { data, error, mode } = await createCashfreeOrder({
      orderId,
      amount,
      name: customerName,
      email: customerEmail,
      phone: customerPhone
    }, origin);
    if (error) {
      console.error('Cashfree order error:', { error, payload: { orderId, amount, customerEmail, customerPhone } });
      return res.status(400).json({ success: false, error });
    }
    res.json({ success: true, paymentSessionId: data.payment_session_id, orderId: data.order_id, cashfreeMode: mode });
  } catch (err: any) {
    console.error('Cashfree order route failed:', err);
    res.status(500).json({ success: false, error: err?.message || 'Payment order route failed' });
  }
});

app.post('/api/payments/cashfree/verify', async (req: Request, res: Response) => {
  try {
    const { verifyCashfreePayment } = await import('../server/lib/cashfree');
    const { persistOrder } = await import('../server/lib/orders');
    const { orderId, orderPayload } = req.body;
    const origin = req.headers.origin;
    const isPaid = await verifyCashfreePayment(orderId, origin);
    if (!isPaid) return res.status(400).json({ success: false, error: 'Payment not verified' });

    const order = await persistOrder({ ...orderPayload, status: 'confirmed', paymentMethod: 'card' });
    res.json({ success: true, order });
  } catch (err: any) {
    console.error('Cashfree verify route failed:', err);
    res.status(500).json({ success: false, error: err?.message || 'Order persistence failed' });
  }
});

// --- PING ---
app.get('/api/ping', (req, res) => {
  res.json({ success: true, message: 'pong', timestamp: new Date().toISOString() });
});

// --- HEALTH ---
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', vercel: !!process.env.VERCEL });
});

// --- RAZORPAY ---
app.post('/api/payments/razorpay/order', async (req: Request, res: Response) => {
  try {
    const { createRazorpayOrder, getRazorpayKeyId } = await import('../server/lib/razorpay');
    const { orderId, amount } = req.body;
    const { order, demo } = await createRazorpayOrder(amount, orderId);
    res.json({ success: true, razorpayOrderId: order.id, amount: order.amount, keyId: getRazorpayKeyId(), demo });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || 'Razorpay order failed' });
  }
});

app.post('/api/payments/razorpay/verify', async (req: Request, res: Response) => {
  try {
    const { verifyRazorpaySignature } = await import('../server/lib/razorpay');
    const { persistOrder } = await import('../server/lib/orders');
    const { orderId, razorpayOrderId, razorpayPaymentId, razorpaySignature, orderPayload } = req.body;

    const valid = verifyRazorpaySignature(razorpayOrderId, razorpayPaymentId, razorpaySignature);
    if (!valid) return res.status(400).json({ success: false, error: 'Invalid payment signature' });

    const order = await persistOrder({ ...orderPayload, id: orderId, status: 'paid', paymentMethod: 'razorpay', paymentId: razorpayPaymentId });
    res.json({ success: true, order });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || 'Razorpay verify failed' });
  }
});

// --- PAYMENT CONFIG ---
app.get('/api/payments/config', async (_req: Request, res: Response) => {
  try {
    const { isRazorpayConfigured, getRazorpayKeyId } = await import('../server/lib/razorpay');
    const configured = isRazorpayConfigured();
    res.json({
      razorpayEnabled: configured,
      keyId: configured ? getRazorpayKeyId() : undefined,
      demoMode: !configured,
      autoVerify: process.env.AUTO_VERIFY_PAYMENTS !== 'false',
    });
  } catch {
    res.json({ razorpayEnabled: false, demoMode: true, autoVerify: true });
  }
});

// --- PAYMENT VERIFICATION QUEUE ---
app.post('/api/payments/verify-queue', async (req: Request, res: Response) => {
  try {
    const { enqueuePaymentVerification, shouldAutoVerifyPayments } = await import('../server/lib/payment-queue');
    const { persistOrder } = await import('../server/lib/orders');
    const { orderId, method, reference, amount } = req.body;

    const entry = await enqueuePaymentVerification({ orderId, method, reference, amount });

    if (shouldAutoVerifyPayments()) {
      const order = await persistOrder({
        id: orderId, items: [], subtotal: 0, tax: 0, shipping: 0, discount: 0, total: amount,
        status: 'paid', paymentMethod: method, paymentId: reference,
        shippingAddress: { fullName: '', email: '', phone: '', street: '', city: '', state: '', pincode: '', country: 'India' },
      });
      return res.json({ success: true, autoVerified: true, message: 'Payment auto-verified', order });
    }

    res.json({ success: true, autoVerified: false, message: 'Queued for manual verification', entry });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || 'Verification queue failed' });
  }
});

// --- ORDER TIMELINE ---
app.get('/api/orders/:orderId/timeline', async (req: Request, res: Response) => {
  try {
    const { getOrderTimeline } = await import('../server/lib/timeline');
    const { getOrderByOrderId } = await import('../server/lib/orders');
    const order = await getOrderByOrderId(req.params.orderId);
    if (!order) return res.status(404).json({ success: false, error: 'Order not found' });

    const timeline = await getOrderTimeline(req.params.orderId);
    res.json({ success: true, timeline });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || 'Failed to load timeline' });
  }
});

// --- CUSTOMER AUTH ---
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.ORDER_ACCESS_SECRET?.trim() || 'sd-jwt-dev-secret';

function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, error: 'Authentication required' });
  }
  try {
    const payload = jwt.verify(auth.slice(7), JWT_SECRET) as { email: string; name: string };
    (req as any).user = payload;
    next();
  } catch {
    return res.status(401).json({ success: false, error: 'Invalid or expired token' });
  }
}

app.post('/api/auth/register', async (req: Request, res: Response) => {
  try {
    const prisma = (await import('../server/lib/database')).default;
    const { name, email, password } = req.body;
    if (!name || !email || !password || password.length < 6) {
      return res.status(400).json({ success: false, error: 'Name, valid email, and password (min 6 chars) required' });
    }
    const normalizedEmail = email.trim().toLowerCase();
    const existing = await prisma.user.findUnique({ where: { email: normalizedEmail } });
    if (existing) return res.status(409).json({ success: false, error: 'Email already registered' });

    const hashed = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: { name: name.trim(), email: normalizedEmail, password: hashed, role: 'customer' },
    });
    const token = jwt.sign({ email: user.email, name: user.name }, JWT_SECRET, { expiresIn: '7d' });
    res.status(201).json({ success: true, token, user: { name: user.name, email: user.email } });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || 'Registration failed' });
  }
});

app.post('/api/auth/login', async (req: Request, res: Response) => {
  try {
    const prisma = (await import('../server/lib/database')).default;
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ success: false, error: 'Email and password required' });

    const normalizedEmail = email.trim().toLowerCase();
    const user = await prisma.user.findUnique({ where: { email: normalizedEmail } });
    if (!user) return res.status(401).json({ success: false, error: 'Invalid email or password' });

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ success: false, error: 'Invalid email or password' });

    const token = jwt.sign({ email: user.email, name: user.name }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ success: true, token, user: { name: user.name, email: user.email } });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || 'Login failed' });
  }
});

app.get('/api/auth/me', authMiddleware, async (req: Request, res: Response) => {
  const user = (req as any).user;
  res.json({ success: true, user: { name: user.name, email: user.email } });
});

// --- MOUNT ROUTES ---
app.use('/api', async (req: Request, res: Response, next) => {
  try {
    const [{ default: commerceRoutes }, { default: publicRoutes }, { default: webhooksRoutes }] = await Promise.all([
      import('../server/routes/commerce'),
      import('../server/routes/public'),
      import('../server/routes/webhooks'),
    ]);

    return express.Router()
      .use(commerceRoutes)
      .use(publicRoutes)
      .use(webhooksRoutes)(req, res, next);
  } catch (err: any) {
    console.error('API route mount failed:', err);
    return res.status(500).json({ success: false, error: err?.message || 'API route failed' });
  }
});

app.use((req: Request, res: Response) => {
  if (req.path.startsWith('/api')) {
    res.status(404).json({ success: false, error: `API endpoint not found: ${req.method} ${req.path}` });
  }
});

if (!process.env.VERCEL) {
  const port = Number(process.env.NOTIFICATION_PORT || 5001);
  app.listen(port, () => {
    console.log(`✅ API server listening on http://localhost:${port}`);
  });
}

export default app;

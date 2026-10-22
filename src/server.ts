import Fastify from 'fastify';
import type { FastifyError } from 'fastify';
import argon2 from 'argon2';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import sensible from '@fastify/sensible';
import { z } from 'zod';
import { randomInt, randomUUID } from 'node:crypto';
import { ensureDatabase, turso } from './db.js';
import type { DiscountType, LeaderboardEntry, Order, OrderStatus, Product, Topup, User, Voucher } from './types.js';

declare module 'fastify' { interface FastifyInstance { authenticate: (request: any) => Promise<void>; } }
type DbRow = Record<string, unknown>;
type SqlArg = string | number | null;

const app = Fastify({ logger: true });
const corsOrigins = process.env.CORS_ORIGIN?.split(',').map((item) => item.trim()).filter(Boolean);
await app.register(cors, { origin: corsOrigins?.length ? corsOrigins : true });
await app.register(sensible);
await app.register(jwt, { secret: process.env.JWT_ACCESS_SECRET ?? 'development-secret' });
app.setErrorHandler((error: FastifyError, request, reply) => {
  request.log.error({ err: error }, 'Request failed');
  const statusCode = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;
  const zodError = error instanceof z.ZodError;
  return reply.status(statusCode).send({ statusCode, error: zodError ? 'ValidationError' : error.name || 'RequestError', message: zodError ? 'Dữ liệu gửi lên không hợp lệ' : error.message || 'Có lỗi xảy ra trên máy chủ', details: zodError ? error.issues : (error as any).validation, path: request.url, requestId: request.id });
});

const query = async <T extends DbRow = DbRow>(sql: string, args: SqlArg[] = []) => (await turso.execute({ sql, args: args as any })).rows as unknown as T[];
const first = async <T extends DbRow = DbRow>(sql: string, args: SqlArg[] = []) => (await query<T>(sql, args))[0];
const execute = (sql: string, args: SqlArg[] = []) => turso.execute({ sql, args: args as any });
const createId = (prefix: string) => prefix + '_' + randomUUID().slice(0, 12);
const text = (row: DbRow, key: string) => row[key] == null ? undefined : String(row[key]);
const numeric = (row: DbRow, key: string) => Number(row[key] ?? 0);

const asUser = (row: DbRow): User => ({ id: text(row, 'id')!, username: text(row, 'username')!, email: text(row, 'email')!, phone: text(row, 'phone'), passwordHash: text(row, 'password_hash'), role: text(row, 'role') === 'ADMIN' ? 'ADMIN' : 'USER', balance: numeric(row, 'balance'), status: text(row, 'status') === 'LOCKED' ? 'LOCKED' : 'ACTIVE', createdAt: text(row, 'created_at')! });
const asProduct = (row: DbRow): Product => ({ id: text(row, 'id')!, name: text(row, 'name')!, description: text(row, 'description')!, price: numeric(row, 'price'), resellerPrice: row.reseller_price == null ? undefined : numeric(row, 'reseller_price'), available: numeric(row, 'available') === 1, stock: row.stock == null ? undefined : numeric(row, 'stock') });
const asVoucher = (row: DbRow): Voucher => ({
  id: text(row, 'id')!,
  code: text(row, 'code')!,
  description: text(row, 'description')!,
  discountType: text(row, 'discount_type') as DiscountType,
  discountValue: numeric(row, 'discount_value'),
  minOrderValue: numeric(row, 'min_order_value'),
  maxDiscount: row.max_discount == null ? undefined : numeric(row, 'max_discount'),
  usageLimit: row.usage_limit == null ? undefined : numeric(row, 'usage_limit'),
  usedCount: numeric(row, 'used_count'),
  expiresAt: text(row, 'expires_at'),
  active: numeric(row, 'active') === 1,
  createdAt: text(row, 'created_at')!
});
const asOrder = (row: DbRow): Order => ({ id: text(row, 'id')!, userId: text(row, 'user_id')!, username: text(row, 'username') ?? '', productId: text(row, 'product_id')!, productName: text(row, 'product_name') ?? '', uid: text(row, 'uid')!, quantity: numeric(row, 'quantity'), total: numeric(row, 'total'), originalTotal: row.original_total == null ? undefined : numeric(row, 'original_total'), discount: row.discount == null ? undefined : numeric(row, 'discount'), voucherCode: text(row, 'voucher_code'), status: text(row, 'status') as OrderStatus, note: text(row, 'note'), createdAt: text(row, 'created_at')! });
const asTopup = (row: DbRow): Topup => ({ id: text(row, 'id')!, userId: text(row, 'user_id')!, amount: numeric(row, 'amount'), transferContent: text(row, 'transfer_content')!, status: text(row, 'status') as Topup['status'], providerReference: text(row, 'provider_reference'), createdAt: text(row, 'created_at')! });
const publicUser = (user: User) => { const { passwordHash: _passwordHash, email: _email, ...safe } = user; return safe; };
const transferContent = () => 'NAP' + Array.from({ length: 6 }, () => randomInt(0, 10)).join('') + 'U' + randomInt(0, 10);
const qrUrl = (amount: number, content: string) => {
  if (!process.env.SEPAY_ACCOUNT_NUMBER || !process.env.SEPAY_BANK_CODE) return undefined;
  const url = new URL('https://vietqr.app/img');
  url.searchParams.set('acc', process.env.SEPAY_ACCOUNT_NUMBER);
  url.searchParams.set('bank', process.env.SEPAY_BANK_CODE);
  url.searchParams.set('amount', String(amount));
  url.searchParams.set('des', content);
  url.searchParams.set('template', 'compact');
  url.searchParams.set('showinfo', 'true');
  if (process.env.SEPAY_ACCOUNT_NAME) url.searchParams.set('holder', process.env.SEPAY_ACCOUNT_NAME);
  return url.toString();
};

async function seedDatabase() {
  const now = new Date().toISOString();
  const adminEmail = process.env.ADMIN_EMAIL ?? 'admin@example.com';
  if (!await first('SELECT id FROM users WHERE email = ?', [adminEmail])) await execute('INSERT INTO users (id, username, email, password_hash, role, balance, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', ['admin-demo', 'Admin', adminEmail, await argon2.hash(process.env.ADMIN_PASSWORD ?? 'change-me'), 'ADMIN', 0, 'ACTIVE', now]);
  if (!await first('SELECT id FROM users WHERE id = ?', ['demo-user'])) await execute('INSERT INTO users (id, username, email, phone, password_hash, role, balance, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', ['demo-user', 'Demo User', 'demo@example.com', '0995438093', await argon2.hash('demo123456'), 'USER', 245000, 'ACTIVE', now]);
  const products = [['chung-suc-1', 'Chung sức 1 rương', '1 rương SS, nhập mã sự kiện.', 30000, 25000, 1, 99], ['chung-suc-2', 'Chung sức 2 rương', '2 rương SS + S+, nhập mã sự kiện.', 45000, 35000, 1, 99], ['chung-suc-full', 'Chung sức full 3 rương', 'Full 3 rương Chung Sức.', 60000, 50000, 1, 99], ['acc-clone', 'Acc clone level 12', 'Acc clone bao full khi còn hàng.', 1000, 800, 1, 12]];
  for (const product of products) await execute('INSERT OR IGNORE INTO products (id, name, description, price, reseller_price, available, stock, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [...product, now] as SqlArg[]);

  const defaultVouchers = [
    ['vch_1', 'BINAOV10', 'Giảm 10% cho mọi đơn hàng từ 30.000 Xu', 'PERCENT', 10, 30000, 20000, 100, 0, null, 1, now],
    ['vch_2', 'CHUNGSUC5K', 'Giảm ngay 5.000 Xu cho đơn từ 45.000 Xu', 'FIXED', 5000, 45000, null, 200, 0, null, 1, now],
    ['vch_3', 'VIP20', 'Giảm 20% tối đa 30.000 Xu cho đơn từ 60.000 Xu', 'PERCENT', 20, 60000, 30000, 50, 0, null, 1, now]
  ];
  for (const v of defaultVouchers) {
    await execute('INSERT OR IGNORE INTO vouchers (id, code, description, discount_type, discount_value, min_order_value, max_discount, usage_limit, used_count, expires_at, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', v as SqlArg[]);
  }
}
await ensureDatabase();
await seedDatabase();

app.decorate('authenticate', async (request: any) => { await request.jwtVerify(); });
async function currentUser(request: any, reply: any) {
  const row = await first('SELECT * FROM users WHERE id = ?', [request.user.sub]);
  if (!row) throw reply.unauthorized('Phiên đăng nhập không còn hợp lệ. Hãy đăng nhập lại.');
  return asUser(row);
}
async function admin(request: any, reply: any) {
  const user = await currentUser(request, reply);
  if (user.role !== 'ADMIN') throw reply.forbidden('Admin access required');
  return user;
}
const orderSelect = 'SELECT o.*, u.username, p.name AS product_name FROM orders o JOIN users u ON u.id = o.user_id JOIN products p ON p.id = o.product_id';

app.get('/health', async () => ({ ok: true, service: 'binaov-be' }));
app.get('/api/products', async () => ({ data: (await query('SELECT * FROM products WHERE available = 1 ORDER BY created_at DESC')).map(asProduct) }));

app.get('/api/leaderboard', async () => {
  const rows = await query<{ user_id: string; username: string; total_deposited: number; topup_count: number }>(`
    SELECT u.id AS user_id, u.username,
           COALESCE(SUM(t.amount), 0) AS total_deposited,
           COUNT(t.id) AS topup_count
    FROM users u
    JOIN topup_transactions t ON t.user_id = u.id AND t.status = 'PAID'
    WHERE u.role = 'USER'
    GROUP BY u.id, u.username
    ORDER BY total_deposited DESC
    LIMIT 20
  `);
  const leaderboard: LeaderboardEntry[] = rows.map((r, index) => ({
    rank: index + 1,
    userId: r.user_id,
    username: r.username,
    totalDeposited: numeric(r, 'total_deposited'),
    topupCount: numeric(r, 'topup_count')
  }));
  return { data: leaderboard };
});

app.get('/api/vouchers', async () => {
  const now = new Date().toISOString();
  const vouchers = (await query('SELECT * FROM vouchers WHERE active = 1 AND (expires_at IS NULL OR expires_at > ?) ORDER BY created_at DESC', [now])).map(asVoucher);
  return { data: vouchers };
});

app.post('/api/vouchers/validate', async (request, reply) => {
  const body = z.object({ code: z.string().trim().min(1), orderAmount: z.number().int().min(0) }).parse(request.body);
  const row = await first('SELECT * FROM vouchers WHERE lower(code) = lower(?) AND active = 1', [body.code]);
  if (!row) throw reply.notFound('Mã voucher không tồn tại hoặc đã bị vô hiệu');
  const voucher = asVoucher(row);
  if (voucher.expiresAt && new Date(voucher.expiresAt) < new Date()) {
    throw reply.badRequest('Mã voucher này đã hết hạn sử dụng');
  }
  if (voucher.usageLimit != null && voucher.usedCount >= voucher.usageLimit) {
    throw reply.badRequest('Mã voucher này đã hết lượt sử dụng');
  }
  if (body.orderAmount < voucher.minOrderValue) {
    throw reply.badRequest(`Đơn hàng phải từ ${new Intl.NumberFormat('vi-VN').format(voucher.minOrderValue)} Xu để dùng mã này`);
  }
  let discount = 0;
  if (voucher.discountType === 'PERCENT') {
    discount = Math.round((body.orderAmount * voucher.discountValue) / 100);
    if (voucher.maxDiscount != null && discount > voucher.maxDiscount) {
      discount = voucher.maxDiscount;
    }
  } else {
    discount = voucher.discountValue;
  }
  discount = Math.min(discount, body.orderAmount);
  return { data: { voucher, discount, finalAmount: body.orderAmount - discount } };
});
app.post('/api/auth/register', async (request, reply) => {
  const body = z.object({ username: z.string().trim().min(2).max(40), password: z.string().min(6) }).parse(request.body);
  if (await first('SELECT id FROM users WHERE lower(username) = lower(?)', [body.username])) throw reply.conflict('Tên đăng nhập đã được sử dụng');
  const id = createId('usr');
  const user: User = { id, username: body.username, email: id + '@users.binaov.shop', passwordHash: await argon2.hash(body.password), role: 'USER', balance: 0, status: 'ACTIVE', createdAt: new Date().toISOString() };
  await execute('INSERT INTO users (id, username, email, phone, password_hash, role, balance, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [user.id, user.username, user.email, user.phone ?? null, user.passwordHash!, user.role, 0, user.status, user.createdAt]);
  return reply.code(201).send({ data: { user: publicUser(user), token: app.jwt.sign({ sub: user.id, role: user.role }) } });
});
app.post('/api/auth/login', async (request, reply) => {
  const body = z.object({ username: z.string().trim().min(2).optional(), email: z.string().email().optional(), password: z.string().min(1) }).refine((data) => Boolean(data.username || data.email), { message: 'Nhập tên đăng nhập hoặc email' }).parse(request.body);
  const identifier = body.username ?? body.email!;
  const row = await first('SELECT * FROM users WHERE lower(username) = lower(?) OR lower(email) = lower(?) LIMIT 1', [identifier, identifier]);
  const user = row && asUser(row);
  if (!user || user.status === 'LOCKED' || !user.passwordHash || !(await argon2.verify(user.passwordHash, body.password))) throw reply.unauthorized('Thông tin đăng nhập không hợp lệ');
  return { data: { user: publicUser(user), token: app.jwt.sign({ sub: user.id, role: user.role }) } };
});
app.get('/api/me', { onRequest: [app.authenticate] }, async (request, reply) => ({ data: publicUser(await currentUser(request, reply)) }));
app.get('/api/wallet/balance', { onRequest: [app.authenticate] }, async (request, reply) => ({ data: { balance: (await currentUser(request, reply)).balance } }));
app.get('/api/topups', { onRequest: [app.authenticate] }, async (request, reply) => {
  const user = await currentUser(request, reply);
  return { data: (await query('SELECT * FROM topup_transactions WHERE user_id = ? ORDER BY created_at DESC', [user.id])).map(asTopup) };
});
app.post('/api/topups', { onRequest: [app.authenticate] }, async (request, reply) => {
  const user = await currentUser(request, reply);
  const body = z.object({ amount: z.number().int().min(20000, 'Số tiền nạp tối thiểu là 20.000 Xu') }).parse(request.body);
  const topup: Topup = { id: createId('top'), userId: user.id, amount: Math.round(body.amount), transferContent: transferContent(), status: 'PENDING', createdAt: new Date().toISOString() };
  await execute('INSERT INTO topup_transactions (id, user_id, amount, transfer_content, status, created_at) VALUES (?, ?, ?, ?, ?, ?)', [topup.id, topup.userId, topup.amount, topup.transferContent, topup.status, topup.createdAt]);
  return reply.code(201).send({ data: { ...topup, bankAccount: process.env.SEPAY_ACCOUNT_NUMBER ?? '', bankCode: process.env.SEPAY_BANK_CODE ?? '', qrUrl: qrUrl(topup.amount, topup.transferContent) } });
});
app.post('/api/orders', { onRequest: [app.authenticate] }, async (request, reply) => {
  const user = await currentUser(request, reply);
  const body = z.object({
    productId: z.string(),
    uid: z.string().trim().min(3).max(80),
    quantity: z.number().int().min(1).max(99),
    voucherCode: z.string().trim().optional(),
    note: z.string().max(500).optional()
  }).parse(request.body);
  const productRow = await first('SELECT * FROM products WHERE id = ? AND available = 1', [body.productId]);
  if (!productRow) throw reply.notFound('Sản phẩm không tồn tại hoặc đã tắt');
  const product = asProduct(productRow);
  const originalTotal = product.price * body.quantity;
  let discount = 0;
  let appliedVoucher: Voucher | null = null;

  if (body.voucherCode) {
    const vRow = await first('SELECT * FROM vouchers WHERE lower(code) = lower(?) AND active = 1', [body.voucherCode]);
    if (vRow) {
      const v = asVoucher(vRow);
      const isExpired = v.expiresAt && new Date(v.expiresAt) < new Date();
      const isExhausted = v.usageLimit != null && v.usedCount >= v.usageLimit;
      if (!isExpired && !isExhausted && originalTotal >= v.minOrderValue) {
        appliedVoucher = v;
        if (v.discountType === 'PERCENT') {
          discount = Math.round((originalTotal * v.discountValue) / 100);
          if (v.maxDiscount != null && discount > v.maxDiscount) discount = v.maxDiscount;
        } else {
          discount = v.discountValue;
        }
        discount = Math.min(discount, originalTotal);
      }
    }
  }

  const total = Math.max(0, originalTotal - discount);
  const debit = await execute('UPDATE users SET balance = balance - ? WHERE id = ? AND balance >= ?', [total, user.id, total]);
  if (!debit.rowsAffected) throw reply.badRequest('Số dư không đủ để tạo đơn');
  const now = new Date().toISOString();
  const fullNote = appliedVoucher
    ? `[Voucher ${appliedVoucher.code} - Giảm ${discount} Xu] ${body.note ?? ''}`.trim()
    : body.note;
  const order: Order = {
    id: createId('ord'),
    userId: user.id,
    username: user.username,
    productId: product.id,
    productName: product.name,
    uid: body.uid,
    quantity: body.quantity,
    total,
    originalTotal,
    discount,
    voucherCode: appliedVoucher?.code,
    status: 'PENDING',
    note: fullNote,
    createdAt: now
  };
  try {
    try {
      await execute('INSERT INTO orders (id, user_id, product_id, uid, quantity, total, status, note, created_at, updated_at, voucher_code, discount, original_total) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [order.id, order.userId, order.productId, order.uid, order.quantity, order.total, order.status, order.note ?? null, now, now, order.voucherCode ?? null, order.discount ?? 0, order.originalTotal ?? total]);
    } catch {
      await execute('INSERT INTO orders (id, user_id, product_id, uid, quantity, total, status, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [order.id, order.userId, order.productId, order.uid, order.quantity, order.total, order.status, order.note ?? null, now, now]);
    }
    await execute('INSERT INTO wallet_ledger (id, user_id, type, amount, reference_id, created_at) VALUES (?, ?, ?, ?, ?, ?)', [createId('led'), user.id, 'ORDER_DEBIT', -total, order.id, now]);
    if (appliedVoucher) {
      await execute('UPDATE vouchers SET used_count = used_count + 1 WHERE id = ?', [appliedVoucher.id]);
    }
  } catch (error) {
    await execute('UPDATE users SET balance = balance + ? WHERE id = ?', [total, user.id]);
    throw error;
  }
  return reply.code(201).send({ data: order });
});
app.get('/api/orders', { onRequest: [app.authenticate] }, async (request, reply) => {
  const user = await currentUser(request, reply);
  return { data: (await query(orderSelect + ' WHERE o.user_id = ? ORDER BY o.created_at DESC', [user.id])).map(asOrder) };
});
app.post('/api/webhooks/sepay', async (request, reply) => {
  const expectedSecret = process.env.SEPAY_WEBHOOK_SECRET;
  const expectedApiKey = process.env.SEPAY_API_KEY;
  const oneHeader = (item: string | string[] | undefined) => Array.isArray(item) ? item[0] : item;
  const secret = oneHeader(request.headers['x-sepay-secret'] ?? request.headers['x-secret-key']);
  const authorization = oneHeader(request.headers.authorization);
  if ((expectedSecret || expectedApiKey) && secret !== expectedSecret && authorization !== 'Apikey ' + expectedApiKey) throw reply.unauthorized('Invalid webhook credentials. Configure SePay API Key or Secret Key to match the backend environment.');
  const body = z.object({ id: z.union([z.string(), z.number()]).optional(), amount: z.coerce.number().positive().optional(), transferAmount: z.coerce.number().positive().optional(), content: z.string().optional(), description: z.string().optional(), code: z.string().optional(), referenceCode: z.string().optional() }).parse(request.body);
  const receivedAmount = body.transferAmount ?? body.amount;
  const receivedContent = body.content ?? body.description ?? body.code ?? '';
  if (!receivedAmount || !receivedContent) throw reply.badRequest('Missing transfer amount or content');
  const pending = (await query('SELECT * FROM topup_transactions WHERE status = ?', ['PENDING'])).map(asTopup);
  const topup = pending.find((item) => receivedContent.toUpperCase().includes(item.transferContent.toUpperCase()));
  if (!topup) return { success: true, ok: true, matched: false, message: 'No pending top-up matched this transfer content' };
  if (receivedAmount < topup.amount) return { success: true, ok: true, matched: false, message: 'Transfer amount is lower than requested amount' };
  const now = new Date().toISOString();
  const markPaid = await execute('UPDATE topup_transactions SET status = ?, provider_reference = ?, paid_at = ? WHERE id = ? AND status = ?', ['PAID', body.referenceCode ?? (body.id == null ? null : String(body.id)), now, topup.id, 'PENDING']);
  if (!markPaid.rowsAffected) return { success: true, ok: true, matched: true, credited: false, message: 'Top-up was already processed', topupId: topup.id };
  try {
    await execute('UPDATE users SET balance = balance + ? WHERE id = ?', [topup.amount, topup.userId]);
    await execute('INSERT INTO wallet_ledger (id, user_id, type, amount, reference_id, created_at) VALUES (?, ?, ?, ?, ?, ?)', [createId('led'), topup.userId, 'TOPUP_CREDIT', topup.amount, topup.id, now]);
  } catch (error) { await execute('UPDATE topup_transactions SET status = ?, provider_reference = NULL, paid_at = NULL WHERE id = ?', ['PENDING', topup.id]); throw error; }
  return { success: true, ok: true, matched: true, credited: true, topupId: topup.id };
});
app.get('/api/admin/dashboard', { onRequest: [app.authenticate] }, async (request, reply) => {
  await admin(request, reply);
  const users = await first('SELECT COUNT(*) AS value FROM users WHERE role = ?', ['USER']);
  const orders = await first('SELECT COUNT(*) AS value FROM orders');
  const pending = await first('SELECT COUNT(*) AS value FROM orders WHERE status = ?', ['PENDING']);
  const revenueRow = await first('SELECT COALESCE(SUM(total), 0) AS value FROM orders WHERE status = ?', ['COMPLETED']);
  const topupRow = await first('SELECT COALESCE(SUM(amount), 0) AS value FROM topup_transactions WHERE status = ?', ['PAID']);
  const revenue = numeric(revenueRow!, 'value');
  return { data: { users: numeric(users!, 'value'), orders: numeric(orders!, 'value'), pendingOrders: numeric(pending!, 'value'), revenue, topups: numeric(topupRow!, 'value'), revenueByPeriod: { month: revenue, quarter: revenue, year: revenue } } };
});
app.get('/api/admin/orders', { onRequest: [app.authenticate] }, async (request, reply) => { await admin(request, reply); return { data: (await query(orderSelect + ' ORDER BY o.created_at DESC')).map(asOrder) }; });
app.patch('/api/admin/orders/:id/status', { onRequest: [app.authenticate] }, async (request, reply) => {
  await admin(request, reply);
  const body = z.object({ status: z.enum(['PENDING', 'PROCESSING', 'COMPLETED', 'CANCELLED', 'FAILED']) }).parse(request.body);
  const id = (request.params as { id: string }).id;
  if (!(await execute('UPDATE orders SET status = ?, updated_at = ? WHERE id = ?', [body.status, new Date().toISOString(), id])).rowsAffected) throw reply.notFound('Order not found');
  return { data: asOrder((await first(orderSelect + ' WHERE o.id = ?', [id]))!) };
});
app.get('/api/admin/users', { onRequest: [app.authenticate] }, async (request, reply) => { await admin(request, reply); return { data: (await query('SELECT * FROM users WHERE role = ? ORDER BY created_at DESC', ['USER'])).map(asUser).map(publicUser) }; });
app.get('/api/admin/topups', { onRequest: [app.authenticate] }, async (request, reply) => { await admin(request, reply); return { data: (await query('SELECT * FROM topup_transactions ORDER BY created_at DESC')).map(asTopup) }; });
app.post('/api/admin/products', { onRequest: [app.authenticate] }, async (request, reply) => {
  await admin(request, reply);
  const body = z.object({ id: z.string().min(2), name: z.string().min(2), description: z.string().min(2), price: z.number().int().min(0), resellerPrice: z.number().int().min(0).optional(), stock: z.number().int().min(0).optional(), available: z.boolean().default(true) }).parse(request.body);
  if (await first('SELECT id FROM products WHERE id = ?', [body.id])) throw reply.conflict('Mã sản phẩm đã tồn tại');
  await execute('INSERT INTO products (id, name, description, price, reseller_price, available, stock, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [body.id, body.name, body.description, body.price, body.resellerPrice ?? null, body.available ? 1 : 0, body.stock ?? null, new Date().toISOString()]);
  return reply.code(201).send({ data: asProduct((await first('SELECT * FROM products WHERE id = ?', [body.id]))!) });
});
app.patch('/api/admin/products/:id', { onRequest: [app.authenticate] }, async (request, reply) => {
  await admin(request, reply);
  const body = z.object({ name: z.string().min(2).optional(), description: z.string().min(2).optional(), price: z.number().int().min(0).optional(), resellerPrice: z.number().int().min(0).nullable().optional(), stock: z.number().int().min(0).nullable().optional(), available: z.boolean().optional() }).parse(request.body);
  const id = (request.params as { id: string }).id;
  const columns: string[] = []; const args: SqlArg[] = [];
  const fields: [keyof typeof body, string][] = [['name', 'name'], ['description', 'description'], ['price', 'price'], ['resellerPrice', 'reseller_price'], ['stock', 'stock']];
  for (const [key, column] of fields) if (body[key] !== undefined) { columns.push(column + ' = ?'); args.push(body[key] as SqlArg); }
  if (body.available !== undefined) { columns.push('available = ?'); args.push(body.available ? 1 : 0); }
  if (!columns.length) throw reply.badRequest('Không có dữ liệu để cập nhật');
  if (!(await execute('UPDATE products SET ' + columns.join(', ') + ' WHERE id = ?', [...args, id])).rowsAffected) throw reply.notFound('Product not found');
  return { data: asProduct((await first('SELECT * FROM products WHERE id = ?', [id]))!) };
});
app.delete('/api/admin/products/:id', { onRequest: [app.authenticate] }, async (request, reply) => {
  await admin(request, reply);
  const id = (request.params as { id: string }).id;
  if (!(await execute('DELETE FROM products WHERE id = ?', [id])).rowsAffected) throw reply.notFound('Product not found');
  return { data: { deleted: true } };
});

app.get('/api/admin/vouchers', { onRequest: [app.authenticate] }, async (request, reply) => {
  await admin(request, reply);
  const vouchers = (await query('SELECT * FROM vouchers ORDER BY created_at DESC')).map(asVoucher);
  return { data: vouchers };
});

app.post('/api/admin/vouchers', { onRequest: [app.authenticate] }, async (request, reply) => {
  await admin(request, reply);
  const body = z.object({
    code: z.string().trim().min(2).max(30).transform((s) => s.toUpperCase()),
    description: z.string().trim().min(2).max(250),
    discountType: z.enum(['PERCENT', 'FIXED']),
    discountValue: z.number().int().min(1),
    minOrderValue: z.number().int().min(0).default(0),
    maxDiscount: z.number().int().min(1).optional(),
    usageLimit: z.number().int().min(1).optional(),
    expiresAt: z.string().optional().nullable(),
    active: z.boolean().default(true)
  }).parse(request.body);

  if (await first('SELECT id FROM vouchers WHERE upper(code) = ?', [body.code])) {
    throw reply.conflict('Mã voucher này đã tồn tại');
  }

  const id = createId('vch');
  const now = new Date().toISOString();
  await execute(`
    INSERT INTO vouchers (id, code, description, discount_type, discount_value, min_order_value, max_discount, usage_limit, used_count, expires_at, active, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
  `, [id, body.code, body.description, body.discountType, body.discountValue, body.minOrderValue, body.maxDiscount ?? null, body.usageLimit ?? null, body.expiresAt ?? null, body.active ? 1 : 0, now]);

  return reply.code(201).send({ data: asVoucher((await first('SELECT * FROM vouchers WHERE id = ?', [id]))!) });
});

app.patch('/api/admin/vouchers/:id', { onRequest: [app.authenticate] }, async (request, reply) => {
  await admin(request, reply);
  const id = (request.params as { id: string }).id;
  const body = z.object({
    code: z.string().trim().min(2).max(30).transform((s) => s.toUpperCase()).optional(),
    description: z.string().trim().min(2).max(250).optional(),
    discountType: z.enum(['PERCENT', 'FIXED']).optional(),
    discountValue: z.number().int().min(1).optional(),
    minOrderValue: z.number().int().min(0).optional(),
    maxDiscount: z.number().int().min(1).nullable().optional(),
    usageLimit: z.number().int().min(1).nullable().optional(),
    expiresAt: z.string().nullable().optional(),
    active: z.boolean().optional()
  }).parse(request.body);

  const existing = await first('SELECT * FROM vouchers WHERE id = ?', [id]);
  if (!existing) throw reply.notFound('Voucher không tồn tại');

  if (body.code) {
    const dup = await first('SELECT id FROM vouchers WHERE upper(code) = ? AND id != ?', [body.code, id]);
    if (dup) throw reply.conflict('Mã voucher này đã trùng với voucher khác');
  }

  const columns: string[] = [];
  const args: SqlArg[] = [];
  if (body.code !== undefined) { columns.push('code = ?'); args.push(body.code); }
  if (body.description !== undefined) { columns.push('description = ?'); args.push(body.description); }
  if (body.discountType !== undefined) { columns.push('discount_type = ?'); args.push(body.discountType); }
  if (body.discountValue !== undefined) { columns.push('discount_value = ?'); args.push(body.discountValue); }
  if (body.minOrderValue !== undefined) { columns.push('min_order_value = ?'); args.push(body.minOrderValue); }
  if (body.maxDiscount !== undefined) { columns.push('max_discount = ?'); args.push(body.maxDiscount ?? null); }
  if (body.usageLimit !== undefined) { columns.push('usage_limit = ?'); args.push(body.usageLimit ?? null); }
  if (body.expiresAt !== undefined) { columns.push('expires_at = ?'); args.push(body.expiresAt ?? null); }
  if (body.active !== undefined) { columns.push('active = ?'); args.push(body.active ? 1 : 0); }

  if (columns.length) {
    await execute('UPDATE vouchers SET ' + columns.join(', ') + ' WHERE id = ?', [...args, id]);
  }

  return { data: asVoucher((await first('SELECT * FROM vouchers WHERE id = ?', [id]))!) };
});

app.delete('/api/admin/vouchers/:id', { onRequest: [app.authenticate] }, async (request, reply) => {
  await admin(request, reply);
  const id = (request.params as { id: string }).id;
  if (!(await execute('DELETE FROM vouchers WHERE id = ?', [id])).rowsAffected) throw reply.notFound('Voucher không tồn tại');
  return { data: { deleted: true } };
});

await app.listen({ port: Number(process.env.PORT ?? 4000), host: process.env.HOST ?? '0.0.0.0' });

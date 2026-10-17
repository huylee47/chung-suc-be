import Fastify from 'fastify';
import type { FastifyError } from 'fastify';
import argon2 from 'argon2';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import sensible from '@fastify/sensible';
import { z } from 'zod';
import { randomInt, randomUUID } from 'node:crypto';
import { ensureDatabase, turso } from './db.js';
import type { Order, OrderStatus, Product, Topup, User } from './types.js';

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
const asOrder = (row: DbRow): Order => ({ id: text(row, 'id')!, userId: text(row, 'user_id')!, username: text(row, 'username') ?? '', productId: text(row, 'product_id')!, productName: text(row, 'product_name') ?? '', uid: text(row, 'uid')!, quantity: numeric(row, 'quantity'), total: numeric(row, 'total'), status: text(row, 'status') as OrderStatus, note: text(row, 'note'), createdAt: text(row, 'created_at')! });
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
  const body = z.object({ productId: z.string(), uid: z.string().trim().min(3).max(80), quantity: z.number().int().min(1).max(99), note: z.string().max(500).optional() }).parse(request.body);
  const productRow = await first('SELECT * FROM products WHERE id = ? AND available = 1', [body.productId]);
  if (!productRow) throw reply.notFound('Sản phẩm không tồn tại hoặc đã tắt');
  const product = asProduct(productRow);
  const total = product.price * body.quantity;
  const debit = await execute('UPDATE users SET balance = balance - ? WHERE id = ? AND balance >= ?', [total, user.id, total]);
  if (!debit.rowsAffected) throw reply.badRequest('Số dư không đủ để tạo đơn');
  const now = new Date().toISOString();
  const order: Order = { id: createId('ord'), userId: user.id, username: user.username, productId: product.id, productName: product.name, uid: body.uid, quantity: body.quantity, total, status: 'PENDING', note: body.note, createdAt: now };
  try {
    await execute('INSERT INTO orders (id, user_id, product_id, uid, quantity, total, status, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [order.id, order.userId, order.productId, order.uid, order.quantity, order.total, order.status, order.note ?? null, now, now]);
    await execute('INSERT INTO wallet_ledger (id, user_id, type, amount, reference_id, created_at) VALUES (?, ?, ?, ?, ?, ?)', [createId('led'), user.id, 'ORDER_DEBIT', -total, order.id, now]);
  } catch (error) { await execute('UPDATE users SET balance = balance + ? WHERE id = ?', [total, user.id]); throw error; }
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

await app.listen({ port: Number(process.env.PORT ?? 4000), host: process.env.HOST ?? '0.0.0.0' });

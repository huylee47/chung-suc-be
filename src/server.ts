import Fastify from 'fastify';
import type { FastifyError } from 'fastify';
import argon2 from 'argon2';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import sensible from '@fastify/sensible';
import { z } from 'zod';
import { randomInt } from 'node:crypto';
import { createId, orders, products, seedAdmin, seedDemoUser, topups, users } from './store.js';
import type { OrderStatus, User } from './types.js';

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: any) => Promise<void>;
  }
}

const app = Fastify({ logger: true });
const corsOrigins = process.env.CORS_ORIGIN?.split(',').map((origin) => origin.trim()).filter(Boolean);
await app.register(cors, { origin: corsOrigins?.length ? corsOrigins : true });
await app.register(sensible);
await app.register(jwt, { secret: process.env.JWT_ACCESS_SECRET ?? 'development-secret' });
app.setErrorHandler((error: FastifyError, request, reply) => {
  request.log.error({ err: error }, 'Request failed');
  const statusCode = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;
  const zodError = error instanceof z.ZodError;
  const details = zodError ? error.issues : (error as any).validation;
  return reply.status(statusCode).send({
    statusCode,
    error: zodError ? 'ValidationError' : error.name || 'RequestError',
    message: zodError ? 'Dữ liệu gửi lên không hợp lệ' : error.message || 'Có lỗi xảy ra trên máy chủ',
    details: details ?? undefined,
    path: request.url,
    requestId: request.id
  });
});
seedAdmin(await argon2.hash(process.env.ADMIN_PASSWORD ?? 'change-me'));
seedDemoUser(await argon2.hash('demo123456'));

const money = (value: number) => Math.round(value);
const createTransferContent = () => `NAP${Array.from({ length: 6 }, () => randomInt(0, 10)).join('')}U${randomInt(0, 10)}`;
const createPaymentQrUrl = (amount: number, transferContent: string) => {
  const accountNumber = process.env.SEPAY_ACCOUNT_NUMBER;
  const bankCode = process.env.SEPAY_BANK_CODE;
  if (!accountNumber || !bankCode) return undefined;
  const url = new URL('https://vietqr.app/img');
  url.searchParams.set('acc', accountNumber);
  url.searchParams.set('bank', bankCode);
  url.searchParams.set('amount', String(amount));
  url.searchParams.set('des', transferContent);
  url.searchParams.set('template', 'compact');
  url.searchParams.set('showinfo', 'true');
  url.searchParams.set('fullacc', 'true');
  if (process.env.SEPAY_ACCOUNT_NAME) url.searchParams.set('holder', process.env.SEPAY_ACCOUNT_NAME);
  url.searchParams.set('store', 'CHUNGSUCLIQI');
  return url.toString();
};
const publicUser = (user: User) => { const { passwordHash: _passwordHash, ...safeUser } = user; return safeUser; };
const findUser = (id: string) => users.find((user) => user.id === id);

app.decorate('authenticate', async (request: any) => {
  await request.jwtVerify();
});

function currentUser(request: any) {
  return findUser(request.user.sub);
}

function requireAdmin(request: any, reply: any) {
  const user = currentUser(request);
  if (!user || user.role !== 'ADMIN') throw reply.forbidden('Admin access required');
  return user;
}

app.get('/health', async () => ({ ok: true, service: 'chungsucliqi-be' }));
app.get('/api/products', async () => ({ data: products.filter((product) => product.available) }));

app.post('/api/auth/register', async (request, reply) => {
  const body = z.object({ username: z.string().min(2), email: z.string().email(), phone: z.string().optional(), password: z.string().min(6) }).parse(request.body);
  if (users.some((user) => user.email === body.email)) throw reply.conflict('Email đã được sử dụng');
  const user: User = { id: createId('usr'), username: body.username, email: body.email, phone: body.phone, role: 'USER', balance: 0, status: 'ACTIVE', createdAt: new Date().toISOString() };
  user.passwordHash = await argon2.hash(body.password);
  users.push(user);
  return reply.code(201).send({ data: { user: publicUser(user), token: app.jwt.sign({ sub: user.id, role: user.role }) } });
});

app.post('/api/auth/login', async (request, reply) => {
  const body = z.object({ email: z.string().email(), password: z.string().min(1) }).parse(request.body);
  const user = users.find((candidate) => candidate.email === body.email);
  if (!user || user.status === 'LOCKED' || !user.passwordHash || !(await argon2.verify(user.passwordHash, body.password))) throw reply.unauthorized('Thông tin đăng nhập không hợp lệ');
  return { data: { user: publicUser(user), token: app.jwt.sign({ sub: user.id, role: user.role }) } };
});

app.get('/api/me', { onRequest: [app.authenticate] }, async (request, reply) => {
  const user = currentUser(request);
  if (!user) throw reply.notFound('User not found');
  return { data: publicUser(user) };
});

app.get('/api/wallet/balance', { onRequest: [app.authenticate] }, async (request, reply) => {
  const user = currentUser(request);
  if (!user) throw reply.notFound('User not found');
  return { data: { balance: user.balance } };
});

app.get('/api/topups', { onRequest: [app.authenticate] }, async (request) => {
  const user = currentUser(request)!;
  return { data: topups.filter((topup) => topup.userId === user.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt)) };
});

app.post('/api/topups', { onRequest: [app.authenticate] }, async (request, reply) => {
  const user = currentUser(request)!;
  const body = z.object({ amount: z.number().int().min(20000, 'Số tiền nạp tối thiểu là 20.000 Xu') }).parse(request.body);
  const topup = { id: createId('top'), userId: user.id, amount: money(body.amount), transferContent: createTransferContent(), status: 'PENDING' as const, createdAt: new Date().toISOString() };
  topups.push(topup);
  return reply.code(201).send({ data: { ...topup, bankAccount: process.env.SEPAY_ACCOUNT_NUMBER ?? '', bankCode: process.env.SEPAY_BANK_CODE ?? '', qrUrl: createPaymentQrUrl(topup.amount, topup.transferContent) } });
});

app.post('/api/orders', { onRequest: [app.authenticate] }, async (request, reply) => {
  const user = currentUser(request)!;
  const body = z.object({ productId: z.string(), uid: z.string().trim().min(3).max(80), quantity: z.number().int().min(1).max(99), note: z.string().max(500).optional() }).parse(request.body);
  const product = products.find((candidate) => candidate.id === body.productId && candidate.available);
  if (!product) throw reply.notFound('Sản phẩm không tồn tại hoặc đã tắt');
  const total = money(product.price * body.quantity);
  if (user.balance < total) throw reply.badRequest('Số dư không đủ để tạo đơn');
  user.balance -= total;
  const order = { id: createId('ord'), userId: user.id, username: user.username, productId: product.id, productName: product.name, uid: body.uid, quantity: body.quantity, total, status: 'PENDING' as const, note: body.note, createdAt: new Date().toISOString() };
  orders.unshift(order);
  return reply.code(201).send({ data: order });
});

app.get('/api/orders', { onRequest: [app.authenticate] }, async (request) => {
  const user = currentUser(request)!;
  return { data: orders.filter((order) => order.userId === user.id) };
});

app.post('/api/webhooks/sepay', async (request, reply) => {
  const expectedSecret = process.env.SEPAY_WEBHOOK_SECRET;
  const expectedApiKey = process.env.SEPAY_API_KEY;
  const providedSecret = request.headers['x-sepay-secret'] ?? request.headers['x-secret-key'];
  const authorization = request.headers.authorization;
  const secretValid = Boolean(expectedSecret && providedSecret === expectedSecret);
  const apiKeyValid = Boolean(expectedApiKey && authorization === `Apikey ${expectedApiKey}`);
  if ((expectedSecret || expectedApiKey) && !secretValid && !apiKeyValid) {
    throw reply.unauthorized('Invalid webhook credentials. Use SePay API Key (Authorization: Apikey ...) or Secret Key matching the backend environment.');
  }
  const body = z.object({
    id: z.union([z.string(), z.number()]).optional(),
    amount: z.coerce.number().positive().optional(),
    transferAmount: z.coerce.number().positive().optional(),
    content: z.string().optional(),
    description: z.string().optional(),
    code: z.string().optional(),
    referenceCode: z.string().optional()
  }).parse(request.body);
  const receivedAmount = body.transferAmount ?? body.amount;
  const receivedContent = body.content ?? body.description ?? body.code ?? '';
  if (!receivedAmount || !receivedContent) return reply.badRequest('Missing transfer amount or content');
  const matching = topups.find((topup) => topup.status === 'PENDING' && receivedContent.toUpperCase().includes(topup.transferContent.toUpperCase()));
  if (!matching) return { success: true, ok: true, matched: false };
  matching.status = 'PAID';
  matching.providerReference = body.referenceCode ?? (body.id === undefined ? undefined : String(body.id));
  const user = findUser(matching.userId);
  if (user && receivedAmount >= matching.amount) user.balance += matching.amount;
  return { success: true, ok: true, matched: true, topupId: matching.id };
});

app.get('/api/admin/dashboard', { onRequest: [app.authenticate] }, async (request, reply) => {
  requireAdmin(request, reply);
  const paid = topups.filter((topup) => topup.status === 'PAID');
  const completed = orders.filter((order) => order.status === 'COMPLETED');
  return { data: { users: users.filter((user) => user.role === 'USER').length, orders: orders.length, pendingOrders: orders.filter((order) => order.status === 'PENDING').length, revenue: completed.reduce((sum, order) => sum + order.total, 0), topups: paid.reduce((sum, topup) => sum + topup.amount, 0), revenueByPeriod: { month: completed.reduce((sum, order) => sum + order.total, 0), quarter: completed.reduce((sum, order) => sum + order.total, 0), year: completed.reduce((sum, order) => sum + order.total, 0) } } };
});

app.get('/api/admin/orders', { onRequest: [app.authenticate] }, async (request, reply) => {
  requireAdmin(request, reply);
  return { data: orders };
});

app.patch('/api/admin/orders/:id/status', { onRequest: [app.authenticate] }, async (request, reply) => {
  requireAdmin(request, reply);
  const body = z.object({ status: z.enum(['PENDING', 'PROCESSING', 'COMPLETED', 'CANCELLED', 'FAILED']) }).parse(request.body);
  const order = orders.find((candidate) => candidate.id === (request.params as { id: string }).id);
  if (!order) throw reply.notFound('Order not found');
  order.status = body.status as OrderStatus;
  return { data: order };
});

app.get('/api/admin/users', { onRequest: [app.authenticate] }, async (request, reply) => {
  requireAdmin(request, reply);
  return { data: users.filter((user) => user.role === 'USER').map(publicUser) };
});

app.get('/api/admin/topups', { onRequest: [app.authenticate] }, async (request, reply) => {
  requireAdmin(request, reply);
  return { data: topups };
});

app.post('/api/admin/products', { onRequest: [app.authenticate] }, async (request, reply) => {
  requireAdmin(request, reply);
  const body = z.object({ id: z.string().min(2), name: z.string().min(2), description: z.string().min(2), price: z.number().int().min(0), resellerPrice: z.number().int().min(0).optional(), stock: z.number().int().min(0).optional(), available: z.boolean().default(true) }).parse(request.body);
  if (products.some((product) => product.id === body.id)) throw reply.conflict('Mã sản phẩm đã tồn tại');
  const product = { ...body };
  products.push(product);
  return reply.code(201).send({ data: product });
});

app.patch('/api/admin/products/:id', { onRequest: [app.authenticate] }, async (request, reply) => {
  requireAdmin(request, reply);
  const body = z.object({ name: z.string().min(2).optional(), description: z.string().min(2).optional(), price: z.number().int().min(0).optional(), resellerPrice: z.number().int().min(0).optional(), stock: z.number().int().min(0).nullable().optional(), available: z.boolean().optional() }).parse(request.body);
  const product = products.find((candidate) => candidate.id === (request.params as { id: string }).id);
  if (!product) throw reply.notFound('Product not found');
  Object.assign(product, body);
  return { data: product };
});

app.delete('/api/admin/products/:id', { onRequest: [app.authenticate] }, async (request, reply) => {
  requireAdmin(request, reply);
  const index = products.findIndex((candidate) => candidate.id === (request.params as { id: string }).id);
  if (index < 0) throw reply.notFound('Product not found');
  products.splice(index, 1);
  return { data: { deleted: true } };
});

const port = Number(process.env.PORT ?? 4000);
await app.listen({ port, host: process.env.HOST ?? '0.0.0.0' });

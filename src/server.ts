import Fastify from 'fastify';
import argon2 from 'argon2';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import sensible from '@fastify/sensible';
import { z } from 'zod';
import { createId, orders, products, seedAdmin, seedDemoUser, topups, users } from './store.js';
import type { OrderStatus, User } from './types.js';

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: any) => Promise<void>;
  }
}

const app = Fastify({ logger: true });
await app.register(cors, { origin: process.env.CORS_ORIGIN?.split(',') ?? true });
await app.register(sensible);
await app.register(jwt, { secret: process.env.JWT_ACCESS_SECRET ?? 'development-secret' });
seedAdmin(await argon2.hash(process.env.ADMIN_PASSWORD ?? 'change-me'));
seedDemoUser(await argon2.hash('demo123456'));

const money = (value: number) => Math.round(value);
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
  const body = z.object({ amount: z.number().int().min(1000) }).parse(request.body);
  const topup = { id: createId('top'), userId: user.id, amount: money(body.amount), transferContent: `CSLQ ${user.id.toUpperCase()} ${Date.now()}`, status: 'PENDING' as const, createdAt: new Date().toISOString() };
  topups.push(topup);
  return reply.code(201).send({ data: topup });
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
  const expected = process.env.SEPAY_WEBHOOK_SECRET;
  if (expected && request.headers['x-sepay-secret'] !== expected) throw reply.unauthorized('Invalid webhook secret');
  const body = z.object({ id: z.string().optional(), amount: z.number().positive(), content: z.string(), referenceCode: z.string().optional() }).parse(request.body);
  const matching = topups.find((topup) => topup.status === 'PENDING' && body.content.toUpperCase().includes(topup.transferContent.toUpperCase()));
  if (!matching) return { ok: true, matched: false };
  matching.status = 'PAID';
  matching.providerReference = body.referenceCode ?? body.id;
  const user = findUser(matching.userId);
  if (user && body.amount >= matching.amount) user.balance += matching.amount;
  return { ok: true, matched: true, topupId: matching.id };
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

import { randomUUID } from 'node:crypto';
import type { Order, Product, Topup, User } from './types.js';

export const products: Product[] = [
  { id: 'chung-suc-1', name: 'Chung sức 1 rương', description: '1 rương SS, nhập mã sự kiện.', price: 30000, resellerPrice: 25000, available: true, stock: 99 },
  { id: 'chung-suc-2', name: 'Chung sức 2 rương', description: '2 rương SS + S+, nhập mã sự kiện.', price: 45000, resellerPrice: 35000, available: true, stock: 99 },
  { id: 'chung-suc-full', name: 'Chung sức full 3 rương', description: 'Full 3 rương Chung Sức.', price: 60000, resellerPrice: 50000, available: true, stock: 99 },
  { id: 'acc-clone', name: 'Acc clone level 12', description: 'Acc clone bao full khi còn hàng.', price: 1000, resellerPrice: 800, available: true, stock: 12 }
];

export const users: User[] = [];
export const orders: Order[] = [];
export const topups: Topup[] = [];

export function seedAdmin(passwordHash = '') {
  if (users.some((user) => user.role === 'ADMIN')) return;
  users.push({ id: 'admin-demo', username: 'Admin', email: process.env.ADMIN_EMAIL ?? 'admin@example.com', role: 'ADMIN', balance: 0, status: 'ACTIVE', createdAt: new Date().toISOString(), passwordHash });
}

export function seedDemoUser(passwordHash = '') {
  if (users.some((user) => user.id === 'demo-user')) return;
  users.push({ id: 'demo-user', username: 'Demo User', email: 'demo@example.com', phone: '0995438093', role: 'USER', balance: 245000, status: 'ACTIVE', createdAt: new Date(Date.now() - 86400000 * 12).toISOString(), passwordHash });
  topups.push({ id: 'top_demo_01', userId: 'demo-user', amount: 300000, transferContent: 'CSLQ DEMOUSER 001', status: 'PAID', providerReference: 'SEPAY-DEMO-001', createdAt: new Date(Date.now() - 86400000 * 3).toISOString() });
  orders.push(
    { id: 'ord_demo_02', userId: 'demo-user', username: 'Demo User', productId: 'chung-suc-full', productName: 'Chung sức full 3 rương', uid: '123456789', quantity: 1, total: 60000, status: 'PROCESSING', note: 'Đơn demo đang xử lý', createdAt: new Date(Date.now() - 3600000 * 4).toISOString() },
    { id: 'ord_demo_01', userId: 'demo-user', username: 'Demo User', productId: 'chung-suc-1', productName: 'Chung sức 1 rương', uid: '987654321', quantity: 1, total: 30000, status: 'COMPLETED', note: 'Đơn demo đã hoàn tất', createdAt: new Date(Date.now() - 86400000 * 2).toISOString() }
  );
}

export function createId(prefix: string) {
  return `${prefix}_${randomUUID().slice(0, 8)}`;
}

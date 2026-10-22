export type Role = 'USER' | 'ADMIN';
export type OrderStatus = 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'CANCELLED' | 'FAILED';
export type TopupStatus = 'PENDING' | 'PAID' | 'FAILED' | 'EXPIRED';

export interface User {
  id: string;
  username: string;
  email: string;
  phone?: string;
  role: Role;
  userType?: string;
  balance: number;
  status: 'ACTIVE' | 'LOCKED';
  createdAt: string;
  passwordHash?: string;
}

export interface UserType {
  id: string;
  code: string;
  name: string;
  discountPercent: number;
  description?: string;
  color?: string;
  userCount?: number;
  createdAt: string;
}

export interface Product {
  id: string;
  name: string;
  description: string;
  price: number;
  resellerPrice?: number;
  available: boolean;
  stock?: number;
}

export type DiscountType = 'PERCENT' | 'FIXED';

export interface Voucher {
  id: string;
  code: string;
  description: string;
  discountType: DiscountType;
  discountValue: number;
  minOrderValue: number;
  maxDiscount?: number;
  usageLimit?: number;
  usedCount: number;
  expiresAt?: string;
  active: boolean;
  createdAt: string;
}

export interface LeaderboardEntry {
  rank: number;
  userId: string;
  username: string;
  totalDeposited: number;
  topupCount: number;
}

export interface Order {
  id: string;
  userId: string;
  username: string;
  productId: string;
  productName: string;
  uid: string;
  quantity: number;
  total: number;
  originalTotal?: number;
  discount?: number;
  voucherCode?: string;
  status: OrderStatus;
  note?: string;
  createdAt: string;
}

export interface Topup {
  id: string;
  userId: string;
  amount: number;
  transferContent: string;
  status: TopupStatus;
  providerReference?: string;
  createdAt: string;
}

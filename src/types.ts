export type Role = 'USER' | 'ADMIN';
export type OrderStatus = 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'CANCELLED' | 'FAILED';
export type TopupStatus = 'PENDING' | 'PAID' | 'FAILED' | 'EXPIRED';

export interface User {
  id: string;
  username: string;
  email: string;
  phone?: string;
  role: Role;
  balance: number;
  status: 'ACTIVE' | 'LOCKED';
  createdAt: string;
  passwordHash?: string;
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

export interface Order {
  id: string;
  userId: string;
  username: string;
  productId: string;
  productName: string;
  uid: string;
  quantity: number;
  total: number;
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

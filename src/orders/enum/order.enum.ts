import { OrderStatus } from '@prisma/client';

export const OrderStatusList = [
  OrderStatus.CACELLED,
  OrderStatus.DELIVERED,
  OrderStatus.PENDING,
];

import {
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { CreateOrderDto } from './dto/create-order.dto';
import { PrismaClient } from '@prisma/client';
import { ClientProxy, RpcException } from '@nestjs/microservices';
import { ChangeOrderStatusDto, OrderPaginationDto } from './dto';
import { NATS_SERVICE } from 'src/config/services';
import { firstValueFrom } from 'rxjs';

@Injectable()
export class OrdersService extends PrismaClient implements OnModuleInit {
  private readonly logger = new Logger('OrdersService');

  constructor(@Inject(NATS_SERVICE) private readonly natsClient: ClientProxy) {
    super();
  }

  async onModuleInit() {
    await this.$connect();
    this.logger.log('Database connected');
  }
  async create(createOrderDto: CreateOrderDto) {
    try {
      //Check products Ids
      const productsIds = createOrderDto.items.map((item) => item.productId);
      const products: any[] = await firstValueFrom(
        this.natsClient.send({ cmd: 'validate_products' }, productsIds),
      );
      //Check products Values
      const totalAmount = createOrderDto.items.reduce((total, orderItem) => {
        const price = products.find(
          (product) => product.id === orderItem.productId,
        ).price;

        return total + price * orderItem.quantity;
      }, 0);

      const totalItems = createOrderDto.items.reduce((total, orderItem) => {
        return total + orderItem.quantity;
      }, 0);

      //BD Transaction
      const order = await this.order.create({
        data: {
          totalAmount,
          totalItems,
          OrderItem: {
            createMany: {
              data: createOrderDto.items.map((orderItem) => ({
                price: products.find(
                  (product) => product.id === orderItem.productId,
                ).price,
                productId: orderItem.productId,
                quantity: orderItem.quantity,
              })),
            },
          },
        },
        include: {
          OrderItem: {
            select: {
              price: true,
              quantity: true,
              productId: true,
            },
          },
        },
      });
      return {
        ...order,
        OrderItem: order.OrderItem.map((orderItem) => ({
          ...orderItem,
          name: products.find((product) => product.id === orderItem.productId)
            .name,
        })),
      };
    } catch (error) {
      throw new RpcException({
        status: HttpStatus.BAD_REQUEST,
        message: `Check logs`,
      });
    }
  }

  async findAll(paginationDto: OrderPaginationDto) {
    const { limit, page, status } = paginationDto;
    const totalPages = await this.order.count({ where: { status } });
    const lastPage = Math.ceil(totalPages / limit);

    const data = await this.order.findMany({
      skip: (page - 1) * limit,
      take: limit,
      where: { status },
    });

    return {
      data,
      meta: {
        total: totalPages,
        current_page: page,
        last_page: lastPage,
      },
    };
  }

  async findOne(id: string) {
    const order = await this.order.findUnique({
      where: { id },
      include: {
        OrderItem: {
          select: {
            productId: true,
            price: true,
            quantity: true,
          },
        },
      },
    });
    if (!order)
      throw new RpcException({
        message: `Order with id:${id} not found`,
        status: HttpStatus.BAD_REQUEST,
      });

    //* Separo los ids de los productos del OrderDetail
    const productIds = order.OrderItem.map((orderItem) => orderItem.productId);

    //*Consulto los nombres de los productos en MS de Products
    const products: any[] = await firstValueFrom(
      this.natsClient.send({ cmd: 'validate_products' }, productIds),
    );

    return {
      ...order,
      OrderItem: order.OrderItem.map((orderItem) => ({
        ...orderItem,
        name: products.find((prod) => prod.id === orderItem.productId).name,
      })),
    };
  }

  async changeOrderStatus(changeOrderStatusDto: ChangeOrderStatusDto) {
    const { id, status } = changeOrderStatusDto;

    const order = await this.findOne(id);

    if (order.status === status) return order;

    return this.order.update({
      where: { id },
      data: {
        status,
      },
    });
  }
}

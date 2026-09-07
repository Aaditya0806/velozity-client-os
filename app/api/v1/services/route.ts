import { route } from '@/lib/http/api';
import { created, paginated } from '@/lib/http/response';
import {
  listServices, createService, serviceCreateSchema, serviceListSchema,
} from '@/lib/services/services-catalog';

export const GET = route(
  { permission: 'service:read:org', query: serviceListSchema },
  async ({ ctx, query, db, requestId }) => {
    const result = await db((tx) => listServices(tx, ctx, query), { readOnly: true });
    return paginated(result.rows, result.pagination, requestId);
  },
);

export const POST = route(
  { permission: 'service:manage:org', body: serviceCreateSchema },
  async ({ ctx, body, db, requestId }) => {
    const service = await db((tx) => createService(tx, ctx, body));
    return created(service, requestId, `/api/v1/services/${service.id}`);
  },
);

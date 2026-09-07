import { route } from '@/lib/http/api';
import { created, paginated } from '@/lib/http/response';
import {
  listCompanies, createCompany, companyCreateSchema, companyListSchema,
} from '@/lib/services/companies';

export const GET = route(
  { permission: undefined, anyPermission: ['company:read:own', 'company:read:team', 'company:read:org'], query: companyListSchema },
  async ({ ctx, query, db, requestId }) => {
    const result = await db((tx) => listCompanies(tx, ctx, query), { readOnly: true });
    return paginated(result.rows, result.pagination, requestId);
  },
);

export const POST = route(
  { permission: 'company:create:org', body: companyCreateSchema },
  async ({ ctx, body, db, requestId }) => {
    const company = await db((tx) => createCompany(tx, ctx, body));
    return created(company, requestId, `/api/v1/clients/${company.id}`);
  },
);


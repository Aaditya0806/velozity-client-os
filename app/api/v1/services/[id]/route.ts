import { z } from 'zod';
import { route } from '@/lib/http/api';
import { ok, noContent } from '@/lib/http/response';
import {
  getService, updateService, archiveService, serviceUpdateSchema,
  replaceDefaultTasks, replaceDefaultKpis, replaceRequiredDocuments,
  defaultTaskSchema, defaultKpiSchema, requiredDocumentSchema,
} from '@/lib/services/services-catalog';
import { uuid } from '@/lib/validation/common';

const params = z.object({ id: uuid });

export const GET = route(
  { permission: 'service:read:org', params },
  async ({ ctx, params: { id }, db, requestId }) => {
    const service = await db((tx) => getService(tx, ctx, id), { readOnly: true });
    return ok(service, requestId);
  },
);

const updateBody = serviceUpdateSchema.extend({
  default_tasks: z.array(defaultTaskSchema).optional(),
  default_kpis: z.array(defaultKpiSchema).optional(),
  required_documents: z.array(requiredDocumentSchema).optional(),
});

export const PATCH = route(
  { permission: 'service:manage:org', params, body: updateBody },
  async ({ ctx, params: { id }, body, db, requestId }) => {
    const { default_tasks, default_kpis, required_documents, ...header } = body;
    const service = await db(async (tx) => {
      await updateService(tx, ctx, id, header);
      if (default_tasks) await replaceDefaultTasks(tx, ctx, id, default_tasks);
      if (default_kpis) await replaceDefaultKpis(tx, ctx, id, default_kpis);
      if (required_documents) await replaceRequiredDocuments(tx, ctx, id, required_documents);
      return getService(tx, ctx, id);
    });
    return ok(service, requestId);
  },
);

// Archive rather than delete: a service named on a signed contract must stay
// resolvable forever.
export const DELETE = route(
  { permission: 'service:manage:org', params },
  async ({ ctx, params: { id }, db, requestId }) => {
    await db((tx) => archiveService(tx, ctx, id));
    return noContent(requestId);
  },
);

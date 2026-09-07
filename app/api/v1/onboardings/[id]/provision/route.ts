import { z } from 'zod';
import { route } from '@/lib/http/api';
import { created } from '@/lib/http/response';
import { provisionProject } from '@/lib/workflows/provision-project';
import { uuid, isoDate, shortText } from '@/lib/validation/common';

const params = z.object({ id: uuid });

/**
 * Creates the delivery workspace: workstreams, tasks, deliverables and KPIs,
 * generated from the services actually sold on the accepted proposal.
 * Idempotent - an onboarding that already has a project returns it unchanged.
 */
export const POST = route(
  {
    permission: 'project:create:org',
    params,
    idempotent: true,
    body: z.object({
      project_name: shortText(200).optional(),
      start_date: isoDate.optional(),
      manager_user_id: uuid.nullable().optional(),
      team_id: uuid.nullable().optional(),
      reporting_cadence: z
        .enum(['none', 'weekly', 'fortnightly', 'monthly', 'quarterly'])
        .optional(),
    }),
  },
  async ({ ctx, params: { id }, body, db, requestId }) => {
    const result = await db((tx) =>
      provisionProject(tx, ctx, {
        onboardingId: id,
        projectName: body.project_name,
        startDate: body.start_date,
        managerUserId: body.manager_user_id,
        teamId: body.team_id,
        reportingCadence: body.reporting_cadence,
      }),
    );
    return created(result, requestId, `/api/v1/projects/${result.projectId}`);
  },
);

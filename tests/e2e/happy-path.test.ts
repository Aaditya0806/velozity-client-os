/**
 * The happy path, end to end.
 *
 * create user -> create client -> create opportunity -> qualify -> discovery ->
 * solution -> proposal -> internal approval -> client acceptance -> won -> NDA ->
 * NDA approval -> e-sign -> executed NDA -> agreement -> legal approval ->
 * e-sign -> fully executed -> payment -> onboarding unlocked -> project created ->
 * tasks created -> KPIs created
 *
 * This runs against real PostgreSQL with real RLS, real triggers and the real
 * services. The only substitution is object storage, which is an in-memory map;
 * hashing, versioning and immutability all run unchanged.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';

// Must be installed before the modules under test are imported.
vi.mock('@/lib/documents/storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/documents/storage')>();
  const { objects } = await import('../helpers/storage-state');
  return {
    ...actual,
    async putObject(path: string, body: Buffer, mimeType: string) {
      if (objects.has(path)) throw new Error(`Refusing to overwrite ${path}`);
      objects.set(path, { body: Buffer.from(body), mimeType });
      return {
        bucket: 'documents',
        path,
        sha256: createHash('sha256').update(body).digest('hex'),
        sizeBytes: body.byteLength,
      };
    },
    async getObject(_bucket: string, path: string) {
      const stored = objects.get(path);
      if (!stored) throw new Error(`No stored object at ${path}`);
      return stored.body;
    },
    async createSignedUrl(_bucket: string, path: string) {
      return {
        url: `https://storage.test/signed/${encodeURIComponent(path)}`,
        expiresAt: new Date(Date.now() + 900_000).toISOString(),
      };
    },
  };
});

import { createTestDatabase, type TestDatabase } from '../helpers/pglite';
import { setDriver, withTenant, type Tx } from '@/lib/db';
import { createOrgWithAdmin, createUserWithRole, type SeedOrg, type SeedUser } from '../helpers/factories';
import { testContext } from '../helpers/context';
import type { RequestContext } from '@/lib/auth/session';

import { createCompany } from '@/lib/services/companies';
import { createContact } from '@/lib/services/contacts';
import {
  createOpportunity, updateOpportunity, transitionOpportunity,
} from '@/lib/services/opportunities';
import { createService, replaceDefaultTasks, replaceDefaultKpis, replaceRequiredDocuments } from '@/lib/services/services-catalog';
import { createSolution } from '@/lib/services/solutions';
import {
  createProposal, submitForReview, approveVersion, markVersionSent, acceptVersion,
} from '@/lib/services/proposals';
import { createContract, renderContractDocument, setSigners, submitForLegalReview, approveContract } from '@/lib/services/contracts';
import { sendForSignature } from '@/lib/services/signature-requests';
import { createOnboarding, evaluateGate, markReady, overrideLegalGate } from '@/lib/services/onboarding';
import { provisionProject } from '@/lib/workflows/provision-project';

describe('happy path: lead to delivery', () => {
  let db: TestDatabase;
  let org: SeedOrg;
  let admin: SeedUser;
  let legal: SeedUser;
  let salesRep: SeedUser;
  let adminCtx: RequestContext;
  let legalCtx: RequestContext;
  let salesCtx: RequestContext;

  // Carried across the sequential steps below.
  const state: Record<string, string> = {};

  beforeAll(async () => {
    db = await createTestDatabase();
    setDriver(db.driver);

    const seeded = await createOrgWithAdmin(db.driver, {
      slug: 'velozity-demo',
      name: 'Velozity Global',
    });
    org = seeded.org;
    admin = seeded.admin;

    legal = await createUserWithRole(db.driver, org.id, 'legal_admin', {
      email: 'legal@velozity.test',
      fullName: 'Lena Ortiz',
    });
    salesRep = await createUserWithRole(db.driver, org.id, 'sales', {
      email: 'sales@velozity.test',
      fullName: 'Sam Okafor',
    });
    // Sales needs finance:manage to record the advance in this test; in the
    // product that step belongs to Finance. Granting it explicitly here keeps
    // the test honest about which authority is doing what.
    await db.driver.query(
      `insert into user_roles (org_id, user_id, role_id)
       select $1, $2, id from roles where key = 'finance' and org_id is null`,
      [org.id, admin.id],
    );

    adminCtx = await testContext(db.driver, admin.id, org.id);
    legalCtx = await testContext(db.driver, legal.id, org.id);
    salesCtx = await testContext(db.driver, salesRep.id, org.id);
  });

  afterAll(async () => {
    setDriver(null);
    await db.close();
  });

  const asAdmin = <T>(fn: (tx: Tx) => Promise<T>) =>
    withTenant<T>({ userId: admin.id, orgId: org.id, requestId: 'req_e2e' }, fn);
  const asLegal = <T>(fn: (tx: Tx) => Promise<T>) =>
    withTenant<T>({ userId: legal.id, orgId: org.id, requestId: 'req_e2e' }, fn);
  const asSales = <T>(fn: (tx: Tx) => Promise<T>) =>
    withTenant<T>({ userId: salesRep.id, orgId: org.id, requestId: 'req_e2e' }, fn);

  it('1. sets up a service in the catalogue with tasks, KPIs and required documents', async () => {
    const service = await asAdmin((tx) =>
      createService(tx, adminCtx, {
        code: 'GROWTH-RETAINER',
        name: 'Growth marketing retainer',
        pricing_model: 'monthly_retainer',
        base_price: '12000.00',
        unit_label: 'month',
        min_quantity: '1',
        unit_cost: '5200.00',
        default_duration_days: 90,
        delivery_config: {},
        is_active: true,
        position: 0,
        tags: [],
      }),
    );
    state.serviceId = service.id;

    await asAdmin(async (tx) => {
      await replaceDefaultTasks(tx, adminCtx, service.id, [
        { workstream_name: 'Foundations', title: 'Audit current analytics setup', position: 0, priority: 'high', offset_days: 0, duration_days: 5, is_deliverable: true },
        { workstream_name: 'Foundations', title: 'Implement conversion tracking', position: 1, priority: 'high', offset_days: 5, duration_days: 10, is_deliverable: true },
        { workstream_name: 'Campaigns', title: 'Build the first campaign set', position: 2, priority: 'medium', offset_days: 15, duration_days: 10, is_deliverable: false },
      ]);
      await replaceDefaultKpis(tx, adminCtx, service.id, [
        { name: 'Lead conversion rate', unit: 'percent', target_value: '4.5', direction: 'higher_is_better', period: 'monthly', position: 0 },
        { name: 'Cost per qualified lead', unit: 'currency', target_value: '85', direction: 'lower_is_better', period: 'monthly', position: 1 },
      ]);
      await replaceRequiredDocuments(tx, adminCtx, service.id, [
        { contract_type: 'nda', document_label: 'Executed non-disclosure agreement', is_required: true, blocks_onboarding: true },
        { contract_type: 'msa', document_label: 'Executed master services agreement', is_required: true, blocks_onboarding: true },
      ]);
    });

    const tasks = await asAdmin((tx) =>
      tx.many('select id from service_default_tasks where service_id = $1', [service.id]),
    );
    expect(tasks).toHaveLength(3);
  });

  it('2. creates the client and its contacts', async () => {
    const company = await asSales((tx) =>
      createCompany(tx, salesCtx, {
        name: 'Northwind Analytics',
        legal_name: 'Northwind Analytics Limited',
        is_legal_entity: true,
        lifecycle_stage: 'prospect',
        industry: 'B2B SaaS',
        country: 'GB',
        currency: 'USD',
        owner_user_id: salesRep.id,
        tags: [],
      }),
    );
    state.companyId = company.id;

    const decisionMaker = await asSales((tx) =>
      createContact(tx, salesCtx, {
        company_id: company.id,
        first_name: 'Priya',
        last_name: 'Anand',
        email: 'priya@northwind.test',
        job_title: 'Chief Marketing Officer',
        contact_role: 'decision_maker',
        is_primary: true,
        is_signatory: true,
        is_billing: false,
        last_name_placeholder: undefined,
        tags: [],
      } as Parameters<typeof createContact>[2]),
    );
    state.decisionMakerId = decisionMaker.id;

    expect(company.name).toBe('Northwind Analytics');
    expect(decisionMaker.is_primary).toBe(true);
  });

  it('3. creates an opportunity and qualifies it', async () => {
    const opportunity = await asSales((tx) =>
      createOpportunity(tx, salesCtx, {
        company_id: state.companyId!,
        primary_contact_id: state.decisionMakerId!,
        name: 'Growth retainer — H1',
        amount: '36000.00',
        currency: 'USD',
        probability: 20,
        expected_close_date: '2026-11-30',
        owner_user_id: salesRep.id,
        tags: [],
      } as Parameters<typeof createOpportunity>[2]),
    );
    state.opportunityId = opportunity.id;
    expect(opportunity.stage).toBe('lead');

    // Qualification is refused until the evidence exists.
    await expect(
      asSales((tx) => transitionOpportunity(tx, salesCtx, opportunity.id, { to: 'qualified' })),
    ).rejects.toMatchObject({ code: 'OPPORTUNITY_QUALIFICATION_INCOMPLETE' });

    await asSales((tx) =>
      updateOpportunity(tx, salesCtx, opportunity.id, {
        business_problem:
          'Lead conversion has fallen from 4.1% to 2.1% and attribution gaps make paid spend impossible to justify.',
        budget_indication: '40000.00',
        budget_currency: 'USD',
        decision_maker_contact_id: state.decisionMakerId!,
      }),
    );

    const qualified = await asSales((tx) =>
      transitionOpportunity(tx, salesCtx, opportunity.id, { to: 'qualified' }),
    );
    expect(qualified.entity.stage).toBe('qualified');
  });

  it('4. records discovery', async () => {
    await asSales((tx) =>
      tx.query(
        `insert into discoveries (
           org_id, opportunity_id, company_id, status, business_overview, current_situation,
           business_problem, goals, current_metrics, target_kpis, marketing_stack,
           budget_range_min, budget_range_max, budget_currency, created_by
         ) values ($1,$2,$3,'complete',$4,$5,$6,$7,$8,$9,$10,$11,$12,'USD',$13)`,
        [
          org.id, state.opportunityId, state.companyId,
          'Mid-market analytics vendor selling into finance teams.',
          'Paid acquisition has scaled but conversion has halved since the site redesign.',
          'Lead conversion has fallen from 4.1% to 2.1%.',
          'Return conversion to 4.5% within two quarters.',
          JSON.stringify([{ name: 'Lead conversion', value: '2.1', unit: 'percent', period: 'monthly', source: 'client analytics' }]),
          JSON.stringify([{ name: 'Lead conversion', target: '4.5', unit: 'percent' }]),
          ['GA4', 'HubSpot', 'Google Ads'],
          '30000.00', '45000.00', salesRep.id,
        ],
      ),
    );

    await asSales((tx) => transitionOpportunity(tx, salesCtx, state.opportunityId!, { to: 'discovery' }));

    const discovery = await asSales((tx) =>
      tx.one<{ status: string }>('select status from discoveries where opportunity_id = $1', [
        state.opportunityId,
      ]),
    );
    expect(discovery.status).toBe('complete');
  });

  it('5. builds a priced solution with exact decimal arithmetic', async () => {
    await asSales((tx) => transitionOpportunity(tx, salesCtx, state.opportunityId!, { to: 'solution' }));

    const solution = await asSales((tx) =>
      createSolution(tx, salesCtx, {
        opportunity_id: state.opportunityId!,
        name: 'Growth retainer — 3 months',
        currency: 'USD',
        discount_value: '0',
        line_items: [
          {
            service_id: state.serviceId!,
            name: 'Growth marketing retainer',
            pricing_model: 'monthly_retainer',
            unit_label: 'month',
            quantity: '3',
            unit_price: '12000.00',
            unit_cost: '5200.00',
            discount_type: 'percent',
            discount_value: '10',
            tax_rate: '0',
            is_optional: false,
            is_custom: false,
            position: 0,
          },
        ],
        milestones: [
          { name: 'Advance on signature', percent: '30', due_rule: 'on_signature', is_advance: true, position: 0 },
          { name: 'Balance on delivery', percent: '70', due_rule: 'on_delivery', is_advance: false, position: 1 },
        ],
      } as Parameters<typeof createSolution>[2]),
    );
    state.solutionId = solution.id as string;

    // 3 x 12000 = 36000, less 10% = 32400. Computed in numeric, not float.
    expect(solution.subtotal).toBe('36000.00');
    expect(solution.discount_total).toBe('3600.00');
    expect(solution.total).toBe('32400.00');

    // Sales holds neither margin:read nor cost:read, so those fields are
    // stripped on the way out rather than merely hidden in the UI.
    expect(solution).not.toHaveProperty('margin_amount');
    expect(solution).not.toHaveProperty('cost_total');
    expect(solution.line_items[0]).not.toHaveProperty('unit_cost');

    // The same record, read by someone who may see commercials.
    const { getSolution } = await import('@/lib/services/solutions');
    const withMargin = await asAdmin((tx) => getSolution(tx, adminCtx, solution.id as string));
    // Cost 3 x 5200 = 15600; margin 32400 - 15600 = 16800.
    expect(withMargin.margin_amount).toBe('16800.00');
    expect(withMargin.cost_total).toBe('15600.00');
  });

  it('6. creates a proposal and refuses to send it before internal approval', async () => {
    const proposal = await asSales((tx) =>
      createProposal(tx, salesCtx, {
        opportunity_id: state.opportunityId!,
        title: 'Growth retainer proposal',
        solution_id: state.solutionId!,
        currency: 'USD',
        executive_summary: 'A three-month growth retainer to restore lead conversion.',
        sections: [],
        validity_days: 30,
        terms: {},
      } as Parameters<typeof createProposal>[2]),
    );
    state.proposalId = proposal.id as string;
    const versions = proposal.versions as Array<{ id: string; total: string }>;
    state.versionId = versions[0]!.id;

    expect(versions[0]!.total).toBe('32400.00');

    // The opportunity cannot claim a proposal was sent before one is approved.
    await expect(
      asSales((tx) =>
        transitionOpportunity(tx, salesCtx, state.opportunityId!, { to: 'proposal_sent' }),
      ),
    ).rejects.toMatchObject({ code: 'PROPOSAL_NOT_APPROVED' });
  });

  it('7. refuses approval from a user without proposal:approve', async () => {
    await asSales((tx) => submitForReview(tx, salesCtx, state.versionId!));

    await expect(
      asSales((tx) => approveVersion(tx, salesCtx, state.versionId!, 'Looks fine to me')),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('8. approves internally and sends the proposal', async () => {
    await asAdmin((tx) => approveVersion(tx, adminCtx, state.versionId!, 'Pricing and scope approved.'));

    await asAdmin((tx) =>
      markVersionSent(tx, adminCtx, state.versionId!, [
        { email: 'priya@northwind.test', name: 'Priya Anand' },
      ]),
    );

    const sent = await asAdmin((tx) =>
      transitionOpportunity(tx, adminCtx, state.opportunityId!, { to: 'proposal_sent' }),
    );
    expect(sent.entity.stage).toBe('proposal_sent');
  });

  it('9. accepts the proposal and freezes the accepted version', async () => {
    const accepted = await asAdmin((tx) =>
      acceptVersion(tx, adminCtx, state.versionId!, {
        accepted_by_contact_id: state.decisionMakerId!,
        note: 'Accepted on the call of 14 October.',
      }),
    );
    expect(accepted.versionId).toBe(state.versionId);

    // The accepted version is now immutable.
    await expect(
      asAdmin((tx) =>
        tx.query(`update proposal_versions set total = '1.00' where id = $1`, [state.versionId]),
      ),
    ).rejects.toMatchObject({ code: 'PROPOSAL_VERSION_IMMUTABLE' });
  });

  it('10. wins the opportunity and records the accepted version', async () => {
    const won = await asAdmin((tx) =>
      transitionOpportunity(tx, adminCtx, state.opportunityId!, { to: 'won' }),
    );

    expect(won.entity.stage).toBe('won');
    expect(won.entity.accepted_proposal_version_id).toBe(state.versionId);
    expect(won.entity.probability).toBe(100);
    expect(won.entity.won_at).toBeTruthy();

    // Editing the opportunity afterwards must not repoint the agreement.
    await expect(
      asAdmin((tx) =>
        tx.query(`update opportunities set accepted_proposal_version_id = null where id = $1`, [
          state.opportunityId,
        ]),
      ),
    ).rejects.toMatchObject({ code: 'ACCEPTED_VERSION_FROZEN' });
  });

  it('11. blocks onboarding until the legal requirements are met', async () => {
    const onboarding = await asAdmin((tx) =>
      createOnboarding(tx, adminCtx, {
        company_id: state.companyId!,
        opportunity_id: state.opportunityId!,
      }),
    );
    state.onboardingId = onboarding.onboardingId;

    const gate = await asAdmin((tx) => evaluateGate(tx, onboarding.onboardingId));
    expect(gate.satisfied).toBe(false);
    // An NDA and an MSA are both outstanding.
    expect(gate.unmet.map((u) => u.contract_type).sort()).toEqual(['msa', 'nda']);

    await expect(
      asAdmin((tx) => markReady(tx, adminCtx, onboarding.onboardingId)),
    ).rejects.toMatchObject({ code: 'LEGAL_GATE_BLOCKED' });
  });

  it('12. drafts the NDA from a template, failing when a required value is missing', async () => {
    const template = await asLegal((tx) =>
      tx.one<{ id: string }>(
        `insert into contract_templates (org_id, key, name, contract_type, created_by)
         values ($1,'standard-nda','Standard mutual NDA','nda',$2) returning id`,
        [org.id, legal.id],
      ),
    );

    const templateVersion = await asLegal((tx) =>
      tx.one<{ id: string }>(
        `insert into contract_template_versions (org_id, template_id, version_no, body, variables, status, created_by)
         values ($1,$2,1,$3,$4,'active',$5) returning id`,
        [
          org.id, template.id,
          'MUTUAL NON-DISCLOSURE AGREEMENT\n\nBetween {{company_name}} and {{client_name}}, effective {{effective_date}}.\n\nBoth parties agree to keep confidential information confidential.',
          JSON.stringify([
            { key: 'company_name', label: 'Our company', type: 'string', required: true },
            { key: 'client_name', label: 'Client legal name', type: 'string', required: true },
            { key: 'effective_date', label: 'Effective date', type: 'date', required: true },
          ]),
          legal.id,
        ],
      ),
    );
    state.ndaTemplateVersionId = templateVersion.id;

    const nda = await asLegal((tx) =>
      createContract(tx, legalCtx, {
        company_id: state.companyId!,
        opportunity_id: state.opportunityId!,
        title: 'Mutual NDA — Northwind Analytics',
        contract_type: 'nda',
        origin: 'our_template',
        template_version_id: templateVersion.id,
        // effective_date deliberately omitted.
        variable_values: {
          company_name: 'Velozity Global',
          client_name: 'Northwind Analytics Limited',
        },
        auto_renews: false,
      } as Parameters<typeof createContract>[2]),
    );
    state.ndaId = nda.id;

    // The render FAILS rather than inventing a date.
    await expect(
      asLegal((tx) => renderContractDocument(tx, legalCtx, nda.id)),
    ).rejects.toMatchObject({ code: 'MISSING_TEMPLATE_VARIABLE' });

    const rendered = await asLegal((tx) =>
      renderContractDocument(tx, legalCtx, nda.id, { effective_date: '2026-10-15' }),
    );
    expect(rendered.body).toContain('Northwind Analytics Limited');
    expect(rendered.body).not.toContain('{{');
  });

  it('13. refuses to send the NDA before legal approval, and from a user without send authority', async () => {
    await asLegal((tx) =>
      setSigners(tx, legalCtx, state.ndaId!, [
        { party: 'internal', name: 'Lena Ortiz', email: 'legal@velozity.test', signing_order: 1 },
        { party: 'counterparty', name: 'Priya Anand', email: 'priya@northwind.test', contact_id: state.decisionMakerId!, signing_order: 2 },
      ] as Parameters<typeof setSigners>[3]),
    );

    // Not yet approved.
    await expect(
      asLegal((tx) => sendForSignature(tx, legalCtx, { contractId: state.ndaId! })),
    ).rejects.toMatchObject({ code: 'CONTRACT_NOT_APPROVED' });

    await asLegal((tx) => submitForLegalReview(tx, legalCtx, state.ndaId!));

    // Sales cannot approve a contract, regardless of owning the deal.
    await expect(
      asSales((tx) => approveContract(tx, salesCtx, state.ndaId!, 'fine')),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    await asLegal((tx) => approveContract(tx, legalCtx, state.ndaId!, 'Standard terms, approved.'));

    // Sales still cannot send it, even now it is approved.
    await expect(
      asSales((tx) => sendForSignature(tx, salesCtx, { contractId: state.ndaId! })),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('14. sends the NDA for signature', async () => {
    const sent = await asLegal((tx) =>
      sendForSignature(tx, legalCtx, {
        contractId: state.ndaId!,
        subject: 'NDA for signature',
        idempotencyKey: `nda-send-${randomUUID()}`,
      }),
    );
    state.ndaSignatureRequestId = sent.signatureRequestId;
    state.ndaProviderRequestId = sent.providerRequestId!;

    const contract = await asLegal((tx) =>
      tx.one<{ status: string; sent_by: string }>(
        'select status, sent_by from contracts where id = $1',
        [state.ndaId],
      ),
    );
    expect(contract.status).toBe('sent');
    expect(contract.sent_by).toBe(legal.id);
  });

  it('15. executes the NDA only through the verified webhook pipeline', async () => {
    const { ingestWebhook, processWebhookEvent } = await import('@/lib/webhooks/processor');
    const { signManualWebhook } = await import('@/lib/signature/manual');

    const payload = JSON.stringify({
      event_id: `evt-${randomUUID()}`,
      request_id: state.ndaProviderRequestId,
      type: 'completed',
      occurred_at: new Date().toISOString(),
    });

    // An unsigned delivery is stored but never processed.
    const unsigned = await ingestWebhook(
      'manual',
      Buffer.from(payload),
      new Headers({ 'content-type': 'application/json' }),
      'req_webhook_bad',
    );
    expect(unsigned.accepted).toBe(false);

    const stillSent = await asLegal((tx) =>
      tx.one<{ status: string }>('select status from contracts where id = $1', [state.ndaId]),
    );
    expect(stillSent.status).toBe('sent');

    // A correctly signed delivery is processed.
    const signed = await ingestWebhook(
      'manual',
      Buffer.from(payload),
      new Headers({
        'content-type': 'application/json',
        'x-velozity-signature': signManualWebhook(payload),
      }),
      'req_webhook_good',
    );
    expect(signed.accepted).toBe(true);

    await processWebhookEvent(signed.webhookEventId);

    // Redelivery of the same event is recognised as a duplicate.
    const duplicate = await ingestWebhook(
      'manual',
      Buffer.from(payload),
      new Headers({
        'content-type': 'application/json',
        'x-velozity-signature': signManualWebhook(payload),
      }),
      'req_webhook_dup',
    );
    expect(duplicate.duplicate).toBe(true);
  });

  it('16. downloads, hashes and seals the executed NDA', async () => {
    const { downloadAndStoreExecutedDocument } = await import('@/lib/workflows/executed-document');

    const result = await downloadAndStoreExecutedDocument({
      signatureRequestId: state.ndaSignatureRequestId!,
      contractId: state.ndaId!,
    });
    state.ndaDocumentId = result.documentId;

    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);

    const contract = await asLegal((tx) =>
      tx.one<{ status: string; executed_document_id: string; executed_at: string }>(
        'select status, executed_document_id, executed_at from contracts where id = $1',
        [state.ndaId],
      ),
    );
    expect(contract.status).toBe('fully_executed');
    expect(contract.executed_document_id).toBe(result.documentId);
    expect(contract.executed_at).toBeTruthy();

    // The stored document is immutable.
    const document = await asLegal((tx) =>
      tx.one<{ is_immutable: boolean }>('select is_immutable from documents where id = $1', [
        result.documentId,
      ]),
    );
    expect(document.is_immutable).toBe(true);

    // A fully executed contract is terminal.
    await expect(
      asLegal((tx) =>
        tx.query(`update contracts set title = 'Changed after signing' where id = $1`, [state.ndaId]),
      ),
    ).rejects.toMatchObject({ code: 'CONTRACT_IMMUTABLE' });

    // Running the download again is a no-op rather than a second document.
    const again = await downloadAndStoreExecutedDocument({
      signatureRequestId: state.ndaSignatureRequestId!,
      contractId: state.ndaId!,
    });
    expect(again.documentId).toBe(result.documentId);
  });

  it('17. still blocks onboarding because the MSA is outstanding', async () => {
    const gate = await asAdmin((tx) => evaluateGate(tx, state.onboardingId!));
    expect(gate.satisfied).toBe(false);
    expect(gate.unmet.map((u) => u.contract_type)).toEqual(['msa']);
  });

  it('18. generates the MSA from the accepted proposal version', async () => {
    const templateVersion = await asLegal((tx) => {
      return tx.one<{ id: string }>(
        `with t as (
           insert into contract_templates (org_id, key, name, contract_type, created_by)
           values ($1,'standard-msa','Standard MSA','msa',$2) returning id
         )
         insert into contract_template_versions (org_id, template_id, version_no, body, variables, status, created_by)
         select $1, t.id, 1, $3, $4, 'active', $2 from t
         returning id`,
        [
          org.id, legal.id,
          'MASTER SERVICES AGREEMENT\n\n{{company_name}} will provide services to {{client_name}} for a total of {{contract_value}} {{currency}}, effective {{effective_date}}.',
          JSON.stringify([
            { key: 'company_name', label: 'Our company', type: 'string', required: true },
            { key: 'client_name', label: 'Client legal name', type: 'string', required: true },
            { key: 'contract_value', label: 'Contract value', type: 'money', required: true },
            { key: 'currency', label: 'Currency', type: 'string', required: true },
            { key: 'effective_date', label: 'Effective date', type: 'date', required: true },
          ]),
        ],
      );
    });

    const msa = await asLegal((tx) =>
      createContract(tx, legalCtx, {
        company_id: state.companyId!,
        opportunity_id: state.opportunityId!,
        title: 'Master Services Agreement — Northwind Analytics',
        contract_type: 'msa',
        origin: 'our_template',
        template_version_id: templateVersion.id,
        variable_values: {
          company_name: 'Velozity Global',
          client_name: 'Northwind Analytics Limited',
          contract_value: '32400.00',
          currency: 'USD',
          effective_date: '2026-10-20',
        },
        effective_date: '2026-10-20',
        auto_renews: false,
      } as Parameters<typeof createContract>[2]),
    );
    state.msaId = msa.id;

    // Commercials came from the accepted proposal version, not the opportunity.
    const stored = await asLegal((tx) =>
      tx.one<{ contract_value: string; currency: string; source_proposal_version_id: string }>(
        'select contract_value, currency, source_proposal_version_id from contracts where id = $1',
        [msa.id],
      ),
    );
    expect(stored.contract_value).toBe('32400.00');
    expect(stored.source_proposal_version_id).toBe(state.versionId);

    await asLegal((tx) => renderContractDocument(tx, legalCtx, msa.id));
    await asLegal((tx) =>
      setSigners(tx, legalCtx, msa.id, [
        { party: 'internal', name: 'Lena Ortiz', email: 'legal@velozity.test', signing_order: 1 },
        { party: 'counterparty', name: 'Priya Anand', email: 'priya@northwind.test', signing_order: 2 },
      ] as Parameters<typeof setSigners>[3]),
    );
  });

  it('19. approves, sends and executes the MSA', async () => {
    await asLegal((tx) => submitForLegalReview(tx, legalCtx, state.msaId!));
    await asLegal((tx) => approveContract(tx, legalCtx, state.msaId!, 'Approved by legal.'));

    const sent = await asLegal((tx) =>
      sendForSignature(tx, legalCtx, {
        contractId: state.msaId!,
        idempotencyKey: `msa-send-${randomUUID()}`,
      }),
    );

    const { ingestWebhook, processWebhookEvent } = await import('@/lib/webhooks/processor');
    const { signManualWebhook } = await import('@/lib/signature/manual');
    const { downloadAndStoreExecutedDocument } = await import('@/lib/workflows/executed-document');

    const payload = JSON.stringify({
      event_id: `evt-${randomUUID()}`,
      request_id: sent.providerRequestId,
      type: 'completed',
      occurred_at: new Date().toISOString(),
    });

    const received = await ingestWebhook(
      'manual',
      Buffer.from(payload),
      new Headers({ 'x-velozity-signature': signManualWebhook(payload) }),
      'req_msa_webhook',
    );
    await processWebhookEvent(received.webhookEventId);

    await downloadAndStoreExecutedDocument({
      signatureRequestId: sent.signatureRequestId,
      contractId: state.msaId!,
    });

    const contract = await asLegal((tx) =>
      tx.one<{ status: string }>('select status from contracts where id = $1', [state.msaId]),
    );
    expect(contract.status).toBe('fully_executed');
  });

  it('20. records the advance payment against its requirement', async () => {
    const requirement = await asAdmin((tx) =>
      tx.one<{ id: string }>(
        `insert into payment_requirements (
           org_id, company_id, opportunity_id, contract_id, name, requirement_type,
           percent_of_value, currency, due_rule, blocks_onboarding, created_by
         ) values ($1,$2,$3,$4,'Advance on signature','advance',30,'USD','on_signature',true,$5)
         returning id`,
        [org.id, state.companyId, state.opportunityId, state.msaId, admin.id],
      ),
    );
    state.paymentRequirementId = requirement.id;

    // 30% of 32400 = 9720.
    const required = await asAdmin((tx) =>
      tx.one<{ amount: string }>('select app.payment_requirement_amount($1) as amount', [
        requirement.id,
      ]),
    );
    expect(required.amount).toBe('9720.00');

    // A partial payment does not satisfy the threshold.
    await asAdmin(async (tx) => {
      const partial = await tx.one<{ id: string }>(
        `insert into payments (org_id, company_id, contract_id, reference, amount, currency,
                               fx_rate_to_base, method, status, transaction_date, recorded_by)
         values ($1,$2,$3,'PAY-000001','5000.00','USD',1,'bank_transfer','received',current_date,$4)
         returning id`,
        [org.id, state.companyId, state.msaId, admin.id],
      );
      await tx.query(
        `insert into payment_allocations (org_id, payment_id, payment_requirement_id, amount, currency, created_by)
         values ($1,$2,$3,'5000.00','USD',$4)`,
        [org.id, partial.id, requirement.id, admin.id],
      );
    });

    const partiallyPaid = await asAdmin((tx) =>
      tx.one<{ status: string; satisfied: boolean }>(
        `select status, app.payment_requirement_is_satisfied(id) as satisfied
         from payment_requirements where id = $1`,
        [requirement.id],
      ),
    );
    expect(partiallyPaid.status).toBe('partially_paid');
    expect(partiallyPaid.satisfied).toBe(false);

    // The balance takes it over the threshold.
    await asAdmin(async (tx) => {
      const balance = await tx.one<{ id: string }>(
        `insert into payments (org_id, company_id, contract_id, reference, amount, currency,
                               fx_rate_to_base, method, status, transaction_date, recorded_by)
         values ($1,$2,$3,'PAY-000002','4720.00','USD',1,'bank_transfer','received',current_date,$4)
         returning id`,
        [org.id, state.companyId, state.msaId, admin.id],
      );
      await tx.query(
        `insert into payment_allocations (org_id, payment_id, payment_requirement_id, amount, currency, created_by)
         values ($1,$2,$3,'4720.00','USD',$4)`,
        [org.id, balance.id, requirement.id, admin.id],
      );
    });

    const satisfied = await asAdmin((tx) =>
      tx.one<{ status: string; satisfied: boolean }>(
        `select status, app.payment_requirement_is_satisfied(id) as satisfied
         from payment_requirements where id = $1`,
        [requirement.id],
      ),
    );
    expect(satisfied.status).toBe('satisfied');
    expect(satisfied.satisfied).toBe(true);
  });

  it('21. unblocks onboarding now that every requirement is met', async () => {
    const gate = await asAdmin((tx) => evaluateGate(tx, state.onboardingId!));
    expect(gate.unmet).toEqual([]);
    expect(gate.satisfied).toBe(true);

    const ready = await asAdmin((tx) => markReady(tx, adminCtx, state.onboardingId!));
    expect(ready.entity.status).toBe('ready');
    expect(ready.entity.legal_override_active).toBe(false);
  });

  it('22. provisions the project with workstreams, tasks, deliverables and KPIs', async () => {
    const result = await asAdmin((tx) =>
      provisionProject(tx, adminCtx, {
        onboardingId: state.onboardingId!,
        startDate: '2026-10-26',
        managerUserId: admin.id,
      }),
    );
    state.projectId = result.projectId;

    expect(result.created).toBe(true);
    expect(result.workstreams).toBe(2);
    expect(result.tasks).toBe(3);
    expect(result.kpis).toBe(2);
    expect(result.deliverables).toBe(2);

    // A second run is idempotent.
    const again = await asAdmin((tx) =>
      provisionProject(tx, adminCtx, { onboardingId: state.onboardingId! }),
    );
    expect(again.created).toBe(false);
    expect(again.projectId).toBe(result.projectId);
  });

  it('23. produces a coherent delivery workspace', async () => {
    const project = await asAdmin((tx) =>
      tx.one<{
        code: string; status: string; currency: string; budget_amount: string | null;
        reporting_cadence: string; company_id: string;
      }>('select * from projects where id = $1', [state.projectId]),
    );
    expect(project.status).toBe('not_started');
    expect(project.currency).toBe('USD');
    expect(project.reporting_cadence).toBe('monthly');
    expect(project.company_id).toBe(state.companyId);

    const tasks = await asAdmin((tx) =>
      tx.many<{ title: string; due_date: string; status: string }>(
        'select title, due_date, status from tasks where project_id = $1 order by position',
        [state.projectId],
      ),
    );
    expect(tasks.map((t) => t.title)).toEqual([
      'Audit current analytics setup',
      'Implement conversion tracking',
      'Build the first campaign set',
    ]);
    // Due dates skip weekends: 2026-10-26 is a Monday, +5 business days is Monday 2 Nov.
    expect(tasks[0]!.due_date).toBe('2026-11-02');

    const kpis = await asAdmin((tx) =>
      tx.many<{ name: string; unit: string; currency: string | null; target_value: string }>(
        'select name, unit, currency, target_value from kpis where project_id = $1 order by position',
        [state.projectId],
      ),
    );
    expect(kpis.map((k) => k.name)).toEqual(['Lead conversion rate', 'Cost per qualified lead']);
    expect(kpis[1]!.currency).toBe('USD');

    const checklist = await asAdmin((tx) =>
      tx.many('select id from onboarding_tasks where onboarding_id = $1', [state.onboardingId]),
    );
    expect(checklist.length).toBeGreaterThanOrEqual(7);
  });

  it('24. leaves a complete audit and event trail', async () => {
    const audit = await asAdmin((tx) =>
      tx.many<{ action: string }>(
        `select action from audit_log where org_id = $1 order by occurred_at`,
        [org.id],
      ),
    );
    const actions = audit.map((a) => a.action);

    for (const expected of [
      'company.created',
      'opportunity.created',
      'proposal.approved',
      'proposal.accepted',
      'contract.created',
      'contract.approved_to_send',
      'contract.sent',
      'contract.executed',
      'onboarding.unblocked',
      'project.provisioned',
    ]) {
      expect(actions).toContain(expected);
    }

    const events = await asAdmin((tx) =>
      tx.many<{ name: string }>(`select distinct name from events where org_id = $1`, [org.id]),
    );
    const names = events.map((e) => e.name);
    expect(names).toContain('opportunity.won');
    expect(names).toContain('proposal.accepted');
    expect(names).toContain('contract.executed');
    expect(names).toContain('onboarding.unblocked');
    expect(names).toContain('project.created');
  });

  it('25. records a legal override permanently when one is used', async () => {
    // A second client, deliberately unblocked without paperwork.
    const rushCompany = await asAdmin((tx) =>
      createCompany(tx, adminCtx, {
        name: 'Rush Client Ltd',
        is_legal_entity: true,
        lifecycle_stage: 'client',
        tags: [],
      } as Parameters<typeof createCompany>[2]),
    );

    const rushOnboarding = await asAdmin((tx) =>
      createOnboarding(tx, adminCtx, { company_id: rushCompany.id }),
    );

    await expect(
      asAdmin((tx) => markReady(tx, adminCtx, rushOnboarding.onboardingId)),
    ).rejects.toMatchObject({ code: 'LEGAL_GATE_BLOCKED' });

    // Sales cannot override.
    await expect(
      asSales((tx) =>
        overrideLegalGate(
          tx,
          salesCtx,
          rushOnboarding.onboardingId,
          'The client is in a hurry and has verbally agreed to sign next week.',
        ),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    // A reason that is not a reason is refused.
    await expect(
      asLegal((tx) => overrideLegalGate(tx, legalCtx, rushOnboarding.onboardingId, 'ok')),
    ).rejects.toBeTruthy();

    const overridden = await asLegal((tx) =>
      overrideLegalGate(
        tx,
        legalCtx,
        rushOnboarding.onboardingId,
        'Board-approved exception: delivery starts ahead of the executed MSA, which is with the client legal team.',
      ),
    );
    expect(overridden.overridden).toBe(true);

    const ready = await asLegal((tx) => markReady(tx, legalCtx, rushOnboarding.onboardingId));
    expect(ready.entity.status).toBe('ready');
    expect(ready.entity.legal_override_active).toBe(true);

    // The override cannot be withdrawn.
    await expect(
      asLegal((tx) =>
        tx.query(`update onboardings set legal_override_active = false where id = $1`, [
          rushOnboarding.onboardingId,
        ]),
      ),
    ).rejects.toMatchObject({ code: 'OVERRIDE_PERMANENT' });

    // And the evidence is append-only.
    await expect(
      asLegal((tx) =>
        tx.query(`update legal_overrides set reason = 'nothing to see here' where onboarding_id = $1`, [
          rushOnboarding.onboardingId,
        ]),
      ),
    ).rejects.toBeTruthy();

    const warnings = await asAdmin(async (tx) => {
      const { clientLegalWarnings } = await import('@/lib/services/onboarding');
      return clientLegalWarnings(tx, rushCompany.id);
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.overridden_by_name).toBe('Lena Ortiz');
  });
});

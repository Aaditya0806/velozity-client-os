/**
 * Development seed data.
 *
 * Everything created here is marked `is_demo = true` so it is distinguishable
 * from real data at the database level, not just by naming convention. Nothing
 * in the application reads `is_demo` to change behaviour — it exists so a
 * production database can be audited for accidental demo rows, and so a demo
 * tenant can be removed with one predicate — see `npm run db:unseed`, which
 * suspends the append-only guards for that one transaction, because deleting an
 * organisation cascades into ledgers that correctly refuse DELETE.
 *
 * The seed produces a coherent story rather than random rows: one tenant, eight
 * people with genuinely different permissions, a service catalogue, and deals at
 * every stage including one that has been through the full won → executed →
 * onboarded path.
 */
import { randomUUID } from 'node:crypto';
import type { SqlDriver } from '@/lib/db/types';

export interface SeedResult {
  orgId: string;
  users: Record<string, { id: string; email: string }>;
  companies: Record<string, string>;
  serviceIds: string[];
  /** True when accounts were created through Supabase Auth and can sign in. */
  authProvisioned: boolean;
}

/**
 * Creates (or finds) a Supabase Auth account and returns its id.
 *
 * Supplied by the CLI when a service-role key is configured. Without it the seed
 * falls back to writing `auth.users` directly, which is correct for the local
 * test shim but produces an account GoTrue will not serve: a real Supabase
 * project needs `instance_id`, `aud`, `role` and an identities row, none of
 * which a plain INSERT provides.
 */
export type AuthProvisioner = (person: {
  email: string;
  name: string;
}) => Promise<string>;

export interface SeedOptions {
  provisionAuthUser?: AuthProvisioner;
  password?: string;
}

const DEMO_USERS = [
  { key: 'admin', email: 'admin@velozity.demo', name: 'Alex Mensah', role: 'super_admin', title: 'Founder' },
  { key: 'management', email: 'md@velozity.demo', name: 'Rina Kapoor', role: 'management', title: 'Managing Director' },
  { key: 'legal', email: 'legal@velozity.demo', name: 'Lena Ortiz', role: 'legal_admin', title: 'Head of Legal' },
  { key: 'finance', email: 'finance@velozity.demo', name: 'Tomas Nilsson', role: 'finance', title: 'Financial Controller' },
  { key: 'sales', email: 'sales@velozity.demo', name: 'Sam Okafor', role: 'sales', title: 'Account Executive' },
  { key: 'sales2', email: 'sales2@velozity.demo', name: 'Yuki Tanaka', role: 'sales', title: 'Account Executive' },
  { key: 'pm', email: 'pm@velozity.demo', name: 'Marta Silva', role: 'project_manager', title: 'Delivery Lead' },
  { key: 'delivery', email: 'delivery@velozity.demo', name: 'Idris Bello', role: 'delivery', title: 'Analyst' },
];

const SERVICES = [
  {
    code: 'GROWTH-RETAINER',
    name: 'Growth marketing retainer',
    description: 'Ongoing paid, lifecycle and analytics work against agreed conversion targets.',
    pricingModel: 'monthly_retainer',
    price: '12000.00',
    cost: '5200.00',
    unit: 'month',
    duration: 90,
    tasks: [
      { workstream: 'Foundations', title: 'Audit current analytics and attribution', offset: 0, duration: 5, deliverable: true, priority: 'high' },
      { workstream: 'Foundations', title: 'Implement conversion tracking', offset: 5, duration: 10, deliverable: true, priority: 'high' },
      { workstream: 'Campaigns', title: 'Build the first campaign set', offset: 15, duration: 10, deliverable: false, priority: 'medium' },
      { workstream: 'Campaigns', title: 'Launch and monitor', offset: 25, duration: 15, deliverable: false, priority: 'medium' },
      { workstream: 'Reporting', title: 'First monthly performance review', offset: 30, duration: 2, deliverable: true, priority: 'medium' },
    ],
    kpis: [
      { name: 'Lead conversion rate', unit: 'percent', target: '4.5', direction: 'higher_is_better' },
      { name: 'Cost per qualified lead', unit: 'currency', target: '85', direction: 'lower_is_better' },
      { name: 'Marketing qualified leads', unit: 'number', target: '120', direction: 'higher_is_better' },
    ],
    documents: [
      { type: 'nda', label: 'Executed non-disclosure agreement' },
      { type: 'msa', label: 'Executed master services agreement' },
    ],
  },
  {
    code: 'DATA-PLATFORM',
    name: 'Data platform build',
    description: 'Fixed-scope warehouse, pipeline and reporting layer implementation.',
    pricingModel: 'fixed',
    price: '85000.00',
    cost: '41000.00',
    unit: 'project',
    duration: 120,
    tasks: [
      { workstream: 'Discovery', title: 'Source system mapping', offset: 0, duration: 10, deliverable: true, priority: 'high' },
      { workstream: 'Build', title: 'Warehouse schema and ingestion', offset: 10, duration: 30, deliverable: true, priority: 'high' },
      { workstream: 'Build', title: 'Reporting layer', offset: 40, duration: 20, deliverable: true, priority: 'medium' },
      { workstream: 'Handover', title: 'Documentation and training', offset: 60, duration: 10, deliverable: true, priority: 'medium' },
    ],
    kpis: [
      { name: 'Pipeline reliability', unit: 'percent', target: '99.5', direction: 'higher_is_better' },
      { name: 'Report refresh time', unit: 'hours', target: '2', direction: 'lower_is_better' },
    ],
    documents: [
      { type: 'nda', label: 'Executed non-disclosure agreement' },
      { type: 'msa', label: 'Executed master services agreement' },
      { type: 'sow', label: 'Executed statement of work' },
    ],
  },
  {
    code: 'ADVISORY',
    name: 'Strategic advisory',
    description: 'Fractional senior input, charged by the day.',
    pricingModel: 'daily',
    price: '2200.00',
    cost: '900.00',
    unit: 'day',
    duration: 60,
    tasks: [
      { workstream: 'Advisory', title: 'Kickoff and priority setting', offset: 0, duration: 2, deliverable: false, priority: 'high' },
      { workstream: 'Advisory', title: 'Monthly review', offset: 25, duration: 1, deliverable: true, priority: 'medium' },
    ],
    kpis: [{ name: 'Sessions delivered', unit: 'number', target: '4', direction: 'higher_is_better' }],
    documents: [{ type: 'nda', label: 'Executed non-disclosure agreement' }],
  },
];

const COMPANIES = [
  { key: 'northwind', name: 'Northwind Analytics', legal: 'Northwind Analytics Limited', industry: 'B2B SaaS', country: 'GB', stage: 'client', owner: 'sales' },
  { key: 'meridian', name: 'Meridian Health Group', legal: 'Meridian Health Group PLC', industry: 'Healthcare', country: 'GB', stage: 'client', owner: 'sales2' },
  { key: 'meridian_uk', name: 'Meridian Health UK', legal: 'Meridian Health UK Ltd', industry: 'Healthcare', country: 'GB', stage: 'client', owner: 'sales2', parent: 'meridian' },
  { key: 'ferrous', name: 'Ferrous Manufacturing', legal: 'Ferrous Manufacturing Co', industry: 'Manufacturing', country: 'DE', stage: 'prospect', owner: 'sales' },
  { key: 'lumen', name: 'Lumen Retail', legal: 'Lumen Retail Group', industry: 'Retail', country: 'US', stage: 'prospect', owner: 'sales2' },
  { key: 'atlas', name: 'Atlas Logistics', legal: 'Atlas Logistics BV', industry: 'Logistics', country: 'NL', stage: 'prospect', owner: 'sales' },
  { key: 'kestrel', name: 'Kestrel Financial', legal: 'Kestrel Financial Services', industry: 'Financial services', country: 'GB', stage: 'former_client', owner: 'sales' },
];

/** Deals covering every stage, so the pipeline board is not empty anywhere. */
const OPPORTUNITIES = [
  { company: 'ferrous', name: 'Analytics foundation', stage: 'lead', amount: '38000.00', owner: 'sales', qualified: false },
  { company: 'lumen', name: 'Retail growth programme', stage: 'qualified', amount: '54000.00', owner: 'sales2', qualified: true },
  { company: 'atlas', name: 'Logistics data platform', stage: 'discovery', amount: '92000.00', owner: 'sales', qualified: true },
  { company: 'meridian', name: 'Patient acquisition retainer', stage: 'diagnosis', amount: '72000.00', owner: 'sales2', qualified: true },
  { company: 'kestrel', name: 'Compliance reporting build', stage: 'solution', amount: '61000.00', owner: 'sales', qualified: true },
  { company: 'northwind', name: 'Growth retainer — H1', stage: 'won', amount: '32400.00', owner: 'sales', qualified: true },
  { company: 'ferrous', name: 'Pilot engagement', stage: 'lost', amount: '18000.00', owner: 'sales', qualified: true, lostReason: 'no_budget' },
  { company: 'lumen', name: 'Advisory retainer', stage: 'dormant', amount: '26400.00', owner: 'sales2', qualified: true },
];

export async function seed(db: SqlDriver, options: SeedOptions = {}): Promise<SeedResult> {
  const orgId = randomUUID();
  const now = new Date();
  const iso = (offsetDays: number) =>
    new Date(now.getTime() + offsetDays * 86_400_000).toISOString().slice(0, 10);

  // -- Organisation ----------------------------------------------------------
  await db.query(
    `insert into organizations (id, name, slug, legal_name, base_currency, timezone, is_demo)
     values ($1, 'Velozity Global (Demo)', 'velozity-demo', 'Velozity Global Ltd', 'USD', 'Europe/London', true)`,
    [orgId],
  );

  await db.query(
    `insert into holiday_calendars (org_id, name, timezone, is_default)
     values ($1, 'UK business hours', 'Europe/London', true)`,
    [orgId],
  );

  // Exchange rates. Without these, base-currency reporting shows nothing rather
  // than quietly assuming parity.
  for (const [from, to, rate] of [
    ['GBP', 'USD', '1.27'],
    ['EUR', 'USD', '1.09'],
    ['USD', 'GBP', '0.79'],
    ['USD', 'EUR', '0.92'],
  ] as const) {
    await db.query(
      `insert into fx_rates (org_id, base_currency, quote_currency, rate, as_of, source)
       values ($1,$2,$3,$4, current_date - 400, 'seed')
       on conflict do nothing`,
      [orgId, from, to, rate],
    );
  }

  // -- People ----------------------------------------------------------------
  const users: SeedResult['users'] = {};

  for (const person of DEMO_USERS) {
    // The auth account comes first, because on real Supabase the id is assigned
    // by GoTrue and user_profiles.id must equal it.
    const id = options.provisionAuthUser
      ? await options.provisionAuthUser({ email: person.email, name: person.name })
      : await (async () => {
          const generated = randomUUID();
          await db.query(
            `insert into auth.users (id, email, raw_user_meta_data)
             values ($1,$2,$3)
             on conflict (id) do nothing`,
            [generated, person.email, JSON.stringify({ full_name: person.name })],
          );
          return generated;
        })();

    await db.query(
      `insert into user_profiles (id, email, full_name, job_title, timezone, status, is_demo)
       values ($1,$2,$3,$4,'Europe/London','active',true)`,
      [id, person.email, person.name, person.title],
    );
    await db.query(
      `insert into org_memberships (org_id, user_id, status, is_owner, joined_at)
       values ($1,$2,'active',$3, now())`,
      [orgId, id, person.key === 'admin'],
    );
    await db.query(
      `insert into user_roles (org_id, user_id, role_id)
       select $1, $2, id from roles where key = $3 and org_id is null`,
      [orgId, id, person.role],
    );
    users[person.key] = { id, email: person.email };
  }

  // Teams, so the `team` permission scope is exercised by the demo data.
  const salesTeam = randomUUID();
  const deliveryTeam = randomUUID();
  await db.query(
    `insert into teams (id, org_id, name, slug, lead_user_id) values
       ($1,$2,'Sales','sales',$3),
       ($4,$2,'Delivery','delivery',$5)`,
    [salesTeam, orgId, users.sales!.id, deliveryTeam, users.pm!.id],
  );
  for (const key of ['sales', 'sales2']) {
    await db.query(
      `insert into team_members (org_id, team_id, user_id) values ($1,$2,$3)`,
      [orgId, salesTeam, users[key]!.id],
    );
  }
  for (const key of ['pm', 'delivery']) {
    await db.query(
      `insert into team_members (org_id, team_id, user_id) values ($1,$2,$3)`,
      [orgId, deliveryTeam, users[key]!.id],
    );
  }

  // -- Service catalogue -----------------------------------------------------
  const categoryId = randomUUID();
  await db.query(
    `insert into service_categories (id, org_id, name, slug, position)
     values ($1,$2,'Core services','core',0)`,
    [categoryId, orgId],
  );

  const serviceIds: string[] = [];

  for (const [index, service] of SERVICES.entries()) {
    const id = randomUUID();
    serviceIds.push(id);

    await db.query(
      `insert into services (
         id, org_id, category_id, code, name, short_description, description,
         pricing_model, base_price, currency, unit_label, unit_cost,
         default_duration_days, is_active, position, is_demo, created_by
       ) values ($1,$2,$3,$4,$5,$6,$6,$7,$8,'USD',$9,$10,$11,true,$12,true,$13)`,
      [
        id, orgId, categoryId, service.code, service.name, service.description,
        service.pricingModel, service.price, service.unit, service.cost,
        service.duration, index, users.admin!.id,
      ],
    );

    for (const [position, task] of service.tasks.entries()) {
      await db.query(
        `insert into service_default_tasks (
           org_id, service_id, workstream_name, title, position, priority,
           offset_days, duration_days, is_deliverable, estimated_hours
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          orgId, id, task.workstream, task.title, position, task.priority,
          task.offset, task.duration, task.deliverable, String(task.duration * 4),
        ],
      );
    }

    for (const [position, kpi] of service.kpis.entries()) {
      await db.query(
        `insert into service_default_kpis (
           org_id, service_id, name, unit, target_value, direction, period, position
         ) values ($1,$2,$3,$4,$5,$6,'monthly',$7)`,
        [orgId, id, kpi.name, kpi.unit, kpi.target, kpi.direction, position],
      );
    }

    for (const document of service.documents) {
      await db.query(
        `insert into service_required_documents (
           org_id, service_id, contract_type, document_label, is_required, blocks_onboarding
         ) values ($1,$2,$3,$4,true,true)`,
        [orgId, id, document.type, document.label],
      );
    }
  }

  // -- Clients and contacts --------------------------------------------------
  const companies: Record<string, string> = {};
  const contactIds: Record<string, string> = {};

  for (const company of COMPANIES) {
    const id = randomUUID();
    companies[company.key] = id;

    await db.query(
      `insert into companies (
         id, org_id, name, legal_name, parent_company_id, lifecycle_stage, industry,
         country, currency, owner_user_id, team_id, website, is_demo, created_by
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,'USD',$9,$10,$11,true,$12)`,
      [
        id, orgId, company.name, company.legal,
        company.parent ? companies[company.parent] : null,
        company.stage, company.industry, company.country,
        users[company.owner]!.id, salesTeam,
        `https://${company.key}.example.com`, users.admin!.id,
      ],
    );

    const contacts = [
      { first: 'Priya', last: 'Anand', title: 'Chief Marketing Officer', role: 'decision_maker', primary: true, signatory: true },
      { first: 'Daniel', last: 'Rhodes', title: 'Head of Finance', role: 'finance', primary: false, billing: true },
      { first: 'Aisha', last: 'Okonkwo', title: 'Marketing Manager', role: 'champion', primary: false },
    ];

    for (const contact of contacts) {
      const contactId = randomUUID();
      contactIds[`${company.key}:${contact.first.toLowerCase()}`] = contactId;

      await db.query(
        `insert into contacts (
           id, org_id, company_id, first_name, last_name, email, job_title, contact_role,
           is_primary, is_billing, is_signatory, owner_user_id, team_id, is_demo, created_by
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,true,$14)`,
        [
          contactId, orgId, id, contact.first, contact.last,
          `${contact.first.toLowerCase()}@${company.key}.example.com`,
          contact.title, contact.role, contact.primary,
          contact.billing ?? false, contact.signatory ?? false,
          users[company.owner]!.id, salesTeam, users.admin!.id,
        ],
      );
    }
  }

  // -- Portal access ---------------------------------------------------------
  //
  // Two clients with a login, and deliberately different capabilities: one sees
  // invoices and can accept deliverables, the other cannot. A demo where every
  // account can do everything proves nothing about the parts that restrict.
  const PORTAL_PEOPLE = [
    {
      key: 'northwind:priya',
      email: 'priya@northwind.example.com',
      name: 'Priya Anand',
      company: 'northwind',
      invoices: true,
      documents: true,
      approve: true,
    },
    {
      key: 'meridian:aisha',
      email: 'aisha@meridian.example.com',
      name: 'Aisha Okonkwo',
      company: 'meridian',
      invoices: false,
      documents: true,
      approve: false,
    },
  ] as const;

  for (const person of PORTAL_PEOPLE) {
    const contactId = contactIds[person.key];
    if (!contactId) continue;

    const authId = options.provisionAuthUser
      ? await options.provisionAuthUser({ email: person.email, name: person.name })
      : await (async () => {
          const generated = randomUUID();
          await db.query(
            `insert into auth.users (id, email, raw_user_meta_data)
             values ($1,$2,$3) on conflict (id) do nothing`,
            [generated, person.email, JSON.stringify({ full_name: person.name })],
          );
          return generated;
        })();

    // A profile, but pointedly no org_memberships row: a portal user who had
    // one would satisfy requireContext() and land in the internal application
    // with no permissions — a blank dashboard instead of their portal.
    await db.query(
      `insert into user_profiles (id, email, full_name, timezone, status, is_demo)
       values ($1,$2,$3,'Europe/London','active',true)
       on conflict (id) do nothing`,
      [authId, person.email, person.name],
    );

    await db.query(
      `insert into portal_users (
         org_id, company_id, contact_id, user_id, status,
         can_view_invoices, can_view_documents, can_approve_deliverables,
         invited_by, invited_at
       ) values ($1,$2,$3,$4,'active',$5,$6,$7,$8, now())
       on conflict (org_id, company_id, user_id) do nothing`,
      [
        orgId,
        companies[person.company],
        contactId,
        authId,
        person.invoices,
        person.documents,
        person.approve,
        users.admin!.id,
      ],
    );
  }

  // -- Opportunities ---------------------------------------------------------
  // Stages are written directly here, marking the transaction so the channel
  // guard permits it. Seed data is fixture setup, not a user action; putting it
  // through the transition service would demand fabricated approvals and
  // proposals for stages that only exist to make the board look real.
  await db.query(`select set_config('app.in_transition', 'on', false)`);

  const opportunityIds: Record<string, string> = {};

  for (const [index, deal] of OPPORTUNITIES.entries()) {
    const id = randomUUID();
    opportunityIds[`${deal.company}-${deal.stage}`] = id;

    const decisionMaker = await db.query<{ id: string }>(
      `select id from contacts where company_id = $1 and contact_role = 'decision_maker' limit 1`,
      [companies[deal.company]],
    );

    await db.query(
      `insert into opportunities (
         id, org_id, company_id, primary_contact_id, reference, name, stage,
         amount, currency, fx_rate_to_base, amount_base, probability, expected_close_date,
         business_problem, budget_indication, budget_currency, decision_maker_contact_id,
         owner_user_id, team_id, source, lost_reason, dormant_from_stage,
         won_at, is_demo, created_by
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,'USD',1,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,true,$21)`,
      [
        id, orgId, companies[deal.company], decisionMaker.rows[0]?.id ?? null,
        `OPP-${String(index + 1).padStart(6, '0')}`, deal.name, deal.stage,
        deal.amount,
        deal.stage === 'won' ? 100 : deal.stage === 'lost' ? 0 : 20 + index * 10,
        iso(20 + index * 7),
        deal.qualified
          ? 'Conversion has fallen materially since the last site release, and attribution gaps make paid spend impossible to justify.'
          : null,
        deal.qualified ? deal.amount : null,
        deal.qualified ? 'USD' : null,
        deal.qualified ? (decisionMaker.rows[0]?.id ?? null) : null,
        users[deal.owner]!.id, salesTeam, 'referral',
        deal.lostReason ?? null,
        deal.stage === 'dormant' ? 'qualified' : null,
        deal.stage === 'won' ? new Date(now.getTime() - 30 * 86_400_000).toISOString() : null,
        users.admin!.id,
      ],
    );

    await db.query(
      `insert into state_transitions (org_id, entity_type, entity_id, from_state, to_state, reason, actor_user_id, actor_type)
       values ($1,'opportunity',$2,'lead',$3,'Seeded demo data',$4,'system')`,
      [orgId, id, deal.stage, users.admin!.id],
    );
  }

  // Reference sequence must continue past the seeded ones.
  await db.query(
    `insert into entity_sequences (org_id, entity, last_value) values ($1,'opportunity',$2)
     on conflict (org_id, entity) do update set last_value = excluded.last_value`,
    [orgId, OPPORTUNITIES.length],
  );

  // -- Contract templates ----------------------------------------------------
  for (const template of [
    {
      key: 'standard-nda',
      name: 'Standard mutual NDA',
      type: 'nda',
      body: `MUTUAL NON-DISCLOSURE AGREEMENT

This agreement is made between {{company_name}} and {{client_name}}, effective {{effective_date}}.

1. Each party may disclose confidential information to the other for the purpose of evaluating a possible working relationship.

2. Each party shall keep the other's confidential information confidential, and shall not disclose it to any third party without prior written consent.

3. This agreement remains in force for three years from the effective date.

Signed for {{company_name}}: ______________________

Signed for {{client_name}}: ______________________`,
      variables: [
        { key: 'company_name', label: 'Our company', type: 'string', required: true, source_hint: 'organization.legal_name' },
        { key: 'client_name', label: 'Client legal name', type: 'string', required: true, source_hint: 'company.legal_name' },
        { key: 'effective_date', label: 'Effective date', type: 'date', required: true },
      ],
    },
    {
      key: 'standard-msa',
      name: 'Standard master services agreement',
      type: 'msa',
      body: `MASTER SERVICES AGREEMENT

Between {{company_name}} and {{client_name}}, effective {{effective_date}}.

1. SERVICES
{{company_name}} shall provide the services described in each statement of work agreed between the parties.

2. FEES
The total contract value is {{contract_value}} {{currency}}, payable in accordance with the agreed payment schedule.

3. TERM
This agreement runs from the effective date until terminated in accordance with clause 6.

Signed for {{company_name}}: ______________________

Signed for {{client_name}}: ______________________`,
      variables: [
        { key: 'company_name', label: 'Our company', type: 'string', required: true },
        { key: 'client_name', label: 'Client legal name', type: 'string', required: true },
        { key: 'contract_value', label: 'Contract value', type: 'money', required: true },
        { key: 'currency', label: 'Currency', type: 'string', required: true },
        { key: 'effective_date', label: 'Effective date', type: 'date', required: true },
      ],
    },
  ]) {
    const templateId = randomUUID();
    const versionId = randomUUID();

    await db.query(
      `insert into contract_templates (id, org_id, key, name, contract_type, is_active, is_demo, created_by)
       values ($1,$2,$3,$4,$5,true,true,$6)`,
      [templateId, orgId, template.key, template.name, template.type, users.legal!.id],
    );
    await db.query(
      `insert into contract_template_versions (
         id, org_id, template_id, version_no, body, variables, status, approved_by, approved_at, created_by
       ) values ($1,$2,$3,1,$4,$5,'active',$6, now(), $6)`,
      [versionId, orgId, templateId, template.body, JSON.stringify(template.variables), users.legal!.id],
    );
    await db.query(`update contract_templates set current_version_id = $2 where id = $1`, [
      templateId,
      versionId,
    ]);
  }

  // -- Email templates -------------------------------------------------------
  for (const template of [
    {
      key: 'nda_request',
      name: 'NDA for signature',
      category: 'contract',
      subject: 'NDA for {{client_name}}',
      body: '<p>Hello {{contact_name}},</p><p>Please find attached our mutual NDA. Once signed we can move on to the detail.</p><p>Best regards</p>',
    },
    {
      key: 'proposal_sent',
      name: 'Proposal delivered',
      category: 'proposal',
      subject: 'Proposal: {{opportunity_name}}',
      body: '<p>Hello {{contact_name}},</p><p>Our proposal is attached. I am happy to walk through it whenever suits.</p><p>Best regards</p>',
    },
  ]) {
    const templateId = randomUUID();
    const versionId = randomUUID();

    await db.query(
      `insert into email_templates (id, org_id, key, name, category, is_active, is_demo, created_by)
       values ($1,$2,$3,$4,$5,true,true,$6)`,
      [templateId, orgId, template.key, template.name, template.category, users.admin!.id],
    );
    await db.query(
      `insert into email_template_versions (
         id, org_id, template_id, version_no, subject, body_html, status, created_by
       ) values ($1,$2,$3,1,$4,$5,'active',$6)`,
      [versionId, orgId, templateId, template.subject, template.body, users.admin!.id],
    );
    await db.query(`update email_templates set current_version_id = $2 where id = $1`, [
      templateId,
      versionId,
    ]);
  }

  // -- Automations -----------------------------------------------------------
  await db.query(
    `insert into automations (
       org_id, name, description, is_active, trigger_event, trigger_filter,
       conditions, actions, max_depth, cooldown_seconds, is_demo, created_by
     ) values
     ($1, 'Draft NDA when a deal is won',
      'When a deal is won and the client has no NDA yet, produce a draft and tell legal.',
      true, 'opportunity.stage_changed', $2, $3, $4, 5, 60, true, $5),
     ($1, 'Flag a client with no recent contact',
      'Creates a follow-up task when a project goes off track.',
      false, 'project.health_changed', $6, $7, $8, 5, 3600, true, $5)`,
    [
      orgId,
      JSON.stringify({ to: 'won' }),
      JSON.stringify([{ path: 'client.nda_status', op: 'eq', value: 'pending' }]),
      JSON.stringify([
        { type: 'generate_contract', params: { contract_type: 'nda', template_key: 'standard-nda' } },
        { type: 'draft_email', params: { template: 'nda_request', to: 'decision_maker', variables: {} } },
        { type: 'notify', params: { target: 'role:legal_admin', title: 'NDA drafted for a won deal', priority: 'high' } },
      ]),
      users.admin!.id,
      JSON.stringify({}),
      JSON.stringify([{ path: 'project.health', op: 'in', value: ['at_risk', 'off_track'] }]),
      JSON.stringify([
        { type: 'create_task', params: { title: 'Review project health with the client', assign_to: 'project.manager', due_in_days: 3, priority: 'high' } },
        { type: 'notify', params: { target: 'role:management', title: 'A project has gone off track', priority: 'high' } },
      ]),
    ],
  );

  await db.query(`select set_config('app.in_transition', 'off', false)`);

  void options;
  return { orgId, users, companies, serviceIds, authProvisioned: Boolean(options.provisionAuthUser) };
}

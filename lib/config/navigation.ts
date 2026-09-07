/**
 * The application navigation.
 *
 * Each entry declares the permission that makes it reachable. The sidebar hides
 * what a user cannot open — not as a security measure (the server enforces that
 * regardless) but because a menu full of things that will 403 is a bad menu.
 */
import type { LucideIcon } from 'lucide-react';
import {
  LayoutDashboard, GitBranch, Building2, Package, FolderKanban, CheckSquare,
  FileText, Scale, BarChart3, Sparkles, Workflow, Wallet, Settings, RefreshCw,
} from 'lucide-react';

export interface NavItem {
  label: string;
  href: string;
  icon: LucideIcon;
  /** Extra words the command palette should match on, beyond the label. */
  keywords?: string;
  /** Any one of these grants visibility. Empty means always visible. */
  anyPermission?: string[];
  /** Matches child routes for active state. */
  matchPrefix?: boolean;
}

export interface NavSection {
  label?: string;
  items: NavItem[];
}

export const NAVIGATION: NavSection[] = [
  {
    items: [
      { label: 'Dashboard', href: '/dashboard', icon: LayoutDashboard, keywords: 'home overview today summary' },
      {
        label: 'Pipeline',
        href: '/pipeline',
        keywords: 'deals opportunities funnel kanban sales board',
        icon: GitBranch,
        matchPrefix: true,
        anyPermission: ['opportunity:read:own', 'opportunity:read:team', 'opportunity:read:org'],
      },
      {
        label: 'Clients',
        href: '/clients',
        keywords: 'companies accounts customers organisations',
        icon: Building2,
        matchPrefix: true,
        anyPermission: ['company:read:own', 'company:read:team', 'company:read:org'],
      },
      {
        label: 'Services',
        href: '/services',
        keywords: 'catalogue offerings pricing packages',
        icon: Package,
        matchPrefix: true,
        anyPermission: ['service:read:org'],
      },
    ],
  },
  {
    label: 'Delivery',
    items: [
      {
        label: 'Projects',
        href: '/projects',
        keywords: 'delivery engagements workstreams',
        icon: FolderKanban,
        matchPrefix: true,
        anyPermission: ['project:read:own', 'project:read:team', 'project:read:org'],
      },
      {
        label: 'Tasks',
        href: '/tasks',
        keywords: 'todo work assigned overdue due',
        icon: CheckSquare,
        matchPrefix: true,
        anyPermission: ['task:read:own', 'task:read:team', 'task:read:org'],
      },
      {
        label: 'Documents',
        href: '/documents',
        keywords: 'files uploads attachments pdf',
        icon: FileText,
        matchPrefix: true,
        anyPermission: ['document:read:org'],
      },
    ],
  },
  {
    label: 'Commercial',
    items: [
      {
        label: 'Legal',
        href: '/legal',
        keywords: 'contracts nda msa sow agreements signatures',
        icon: Scale,
        matchPrefix: true,
        anyPermission: ['contract:read:own', 'contract:read:team', 'contract:read:org'],
      },
      {
        label: 'Renewals',
        href: '/legal/renewals',
        keywords: 'renewal churn retention expiring contracts at risk',
        icon: RefreshCw,
        anyPermission: ['renewal:read:own', 'renewal:read:team', 'renewal:read:org'],
      },
      {
        label: 'Finance',
        href: '/finance',
        keywords: 'invoices payments revenue billing money',
        icon: Wallet,
        matchPrefix: true,
        anyPermission: ['finance:read:org'],
      },
      {
        label: 'Reports',
        href: '/reports',
        keywords: 'analytics metrics kpis insights',
        icon: BarChart3,
        matchPrefix: true,
        anyPermission: ['report:read:org'],
      },
    ],
  },
  {
    label: 'Intelligence',
    items: [
      {
        label: 'AI',
        href: '/ai',
        keywords: 'assistant copilot ask intelligence',
        icon: Sparkles,
        matchPrefix: true,
        anyPermission: ['ai:use:org', 'ai:read:org'],
      },
      {
        label: 'Automations',
        href: '/automations',
        keywords: 'workflows rules triggers when then',
        icon: Workflow,
        matchPrefix: true,
        anyPermission: ['automation:read:org'],
      },
    ],
  },
  {
    items: [
      {
        label: 'Settings',
        href: '/settings',
        icon: Settings,
        matchPrefix: true,
        keywords: 'preferences configuration admin team roles',
      },
    ],
  },
];

export function visibleNavigation(permissions: readonly string[]): NavSection[] {
  const held = new Set(permissions);
  return NAVIGATION.map((section) => ({
    ...section,
    items: section.items.filter(
      (item) => !item.anyPermission || item.anyPermission.some((p) => held.has(p)),
    ),
  })).filter((section) => section.items.length > 0);
}

/**
 * Every href in the navigation, longest first.
 *
 * Used to decide which prefix-matching entry wins when one nav item sits
 * underneath another: /legal/renewals is inside /legal, and without this both
 * would light up, which reads as a bug rather than as a hierarchy.
 */
const ALL_HREFS: string[] = NAVIGATION.flatMap((section) => section.items.map((i) => i.href))
  .sort((a, b) => b.length - a.length);

export function isActive(pathname: string, item: NavItem): boolean {
  if (pathname === item.href) return true;
  if (!item.matchPrefix) return false;
  if (!pathname.startsWith(`${item.href}/`)) return false;

  // A prefix match only counts when no more specific entry also matches: the
  // deepest destination is the one the person actually chose.
  const better = ALL_HREFS.find(
    (href) =>
      href !== item.href &&
      href.startsWith(`${item.href}/`) &&
      (pathname === href || pathname.startsWith(`${href}/`)),
  );

  return better === undefined;
}

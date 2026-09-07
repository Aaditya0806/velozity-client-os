import { LayoutDashboard, FolderKanban, FileText, Receipt, BarChart3 } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { PortalCapabilities } from '@/lib/auth/portal';

export interface PortalNavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Hidden unless the client holds this capability. */
  requires?: keyof PortalCapabilities;
}

const ITEMS: PortalNavItem[] = [
  { href: '/portal', label: 'Overview', icon: LayoutDashboard },
  { href: '/portal/projects', label: 'Projects', icon: FolderKanban },
  { href: '/portal/documents', label: 'Documents', icon: FileText, requires: 'viewDocuments' },
  { href: '/portal/invoices', label: 'Invoices', icon: Receipt, requires: 'viewInvoices' },
  { href: '/portal/reports', label: 'Reports', icon: BarChart3 },
];

/**
 * Navigation is filtered by capability, but that is a courtesy rather than a
 * control: the pages themselves refuse, and the views behind them return
 * nothing. Hiding a link the server would deny is politeness; relying on it
 * would be the mistake the portal projections exist to prevent.
 */
export function portalNavigation(capabilities: PortalCapabilities): PortalNavItem[] {
  return ITEMS.filter((item) => !item.requires || capabilities[item.requires]);
}

export function isPortalActive(pathname: string, href: string): boolean {
  if (href === '/portal') return pathname === '/portal';
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * Which navigation entry is highlighted.
 *
 * One item sitting inside another — /legal/renewals under /legal — made both
 * light up, because /legal matches by prefix. Two highlighted rows read as a
 * bug rather than as a hierarchy, and the fix is easy to undo by accident when
 * a future page is added under an existing section.
 */
import { describe, it, expect } from 'vitest';
import { NAVIGATION, isActive, type NavItem } from '@/lib/config/navigation';

const items: NavItem[] = NAVIGATION.flatMap((section) => section.items);
const find = (href: string): NavItem => {
  const item = items.find((i) => i.href === href);
  if (!item) throw new Error(`No nav item for ${href}`);
  return item;
};

/** Every entry that would highlight for this path. */
const activeFor = (pathname: string) =>
  items.filter((item) => isActive(pathname, item)).map((item) => item.href);

describe('navigation highlighting', () => {
  it('highlights exactly one entry for every nav destination', () => {
    for (const item of items) {
      expect(activeFor(item.href), `${item.href} should highlight only itself`).toEqual([
        item.href,
      ]);
    }
  });

  it('gives a nested page to the deepest entry, not its parent', () => {
    expect(activeFor('/legal/renewals')).toEqual(['/legal/renewals']);
    expect(isActive('/legal/renewals', find('/legal'))).toBe(false);
  });

  it('still highlights the parent for its own children', () => {
    // A contract detail page belongs to Legal; there is no deeper entry.
    expect(activeFor('/legal/contracts/abc-123')).toEqual(['/legal']);
  });

  it('highlights nothing for a path outside the navigation', () => {
    expect(activeFor('/portal')).toEqual([]);
  });

  it('does not treat a prefix that is not a path segment as a match', () => {
    // /legally-distinct is not inside /legal.
    expect(activeFor('/legally-distinct')).toEqual([]);
  });
});

'use client';

import * as RT from '@radix-ui/react-tabs';
import type { ReactNode } from 'react';
import { cn } from '@/lib/format';

export const Tabs = RT.Root;
export const TabsContent = RT.Content;

export function TabsList({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <RT.List
      className={cn('flex gap-1 overflow-x-auto overflow-y-hidden border-b border-line [scrollbar-width:none]', className)}
      aria-label="Sections"
    >
      {children}
    </RT.List>
  );
}

export function TabsTrigger({ value, children, count }: { value: string; children: ReactNode; count?: number | null }) {
  return (
    <RT.Trigger
      value={value}
      className="group relative -mb-px inline-flex items-center gap-1.5 whitespace-nowrap border-b-2 border-transparent px-3 py-2 text-sm font-medium text-ink-muted hover:text-ink data-[state=active]:border-action data-[state=active]:text-navy"
    >
      {children}
      {typeof count === 'number' && (
        <span className="rounded bg-navy-50 px-1 text-2xs font-semibold tabular text-ink-muted group-data-[state=active]:bg-action-100 group-data-[state=active]:text-action-700">
          {count}
        </span>
      )}
    </RT.Trigger>
  );
}

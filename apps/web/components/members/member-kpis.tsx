'use client';

import { CalendarClock, FileWarning, Plane, Ship, UserCheck, UsersRound } from 'lucide-react';
import { cn } from '@/lib/format';
import { KpiTiles, type KpiTile } from '@/components/ui/kpi-tiles';
import type { MemberStats, MemberStatus } from './types';

const pct = (n: number, total: number) => (total ? `${Math.round((n / total) * 100)} %` : '—');

/**
 * Indicateurs de la population visible (même périmètre que la liste). Les tuiles de statut filtrent la liste ;
 * la tuile certificats ouvre l'explorateur des certificats Members.
 */
export function MemberKpis({
  stats,
  loading,
  status,
  onStatus,
}: {
  stats: MemberStats | undefined;
  loading: boolean;
  status: string;
  onStatus: (s: string) => void;
}) {
  const grid = 'min-[1700px]:grid-cols-6';
  if (loading || !stats) return <KpiTiles tiles={[]} loading label="Indicateurs des fiches" className={grid} />;
  const n = (s: MemberStatus) => stats.byStatus[s] ?? 0;
  const inactive = n('INACTIVE');
  const filter = (s: MemberStatus) => ({ active: status === s, onClick: () => onStatus(status === s ? '' : s) });
  const tiles: KpiTile[] = [
    {
      key: 'all',
      icon: UsersRound,
      tone: 'navy',
      value: stats.total,
      label: 'Fiches',
      sub: inactive ? `dont ${inactive} inactive${inactive > 1 ? 's' : ''}` : 'Marins et personnel',
      onClick: () => onStatus(''),
    },
    { key: 'onboard', icon: Ship, tone: 'teal', value: n('ON_BOARD'), label: 'À bord', sub: `${pct(n('ON_BOARD'), stats.total)} des fiches`, ...filter('ON_BOARD') },
    { key: 'planned', icon: CalendarClock, tone: 'warn', value: n('PLANNED_JOIN'), label: 'Embarquement prévu', sub: 'Affectation planifiée', ...filter('PLANNED_JOIN') },
    { key: 'leave', icon: Plane, tone: 'info', value: n('ON_LEAVE'), label: 'En congé', sub: `${pct(n('ON_LEAVE'), stats.total)} des fiches`, ...filter('ON_LEAVE') },
    { key: 'available', icon: UserCheck, tone: 'ok', value: n('AVAILABLE'), label: 'Disponibles', sub: 'Pour une affectation', ...filter('AVAILABLE') },
  ];
  const c = stats.certificates;
  if (c) {
    tiles.push({
      key: 'certificates',
      icon: FileWarning,
      tone: 'danger',
      value: c.expired + c.expiringSoon,
      label: 'Certificats à surveiller',
      sub: `${c.expired} expiré${c.expired > 1 ? 's' : ''} · ${c.expiringSoon} sous ${stats.expiringSoonDays} j`,
      href: `/certificates?subjectKind=MEMBER&validity=${c.expired ? 'EXPIRED' : 'EXPIRING_SOON'}`,
    });
  }
  return <KpiTiles tiles={tiles} label="Indicateurs des fiches" className={cn(tiles.length === 6 ? grid : 'min-[1700px]:grid-cols-5')} />;
}

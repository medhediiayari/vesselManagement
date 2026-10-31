import {
  Anchor,
  Bell,
  Building2,
  ClipboardList,
  FileCheck2,
  FileSignature,
  FileText,
  Gauge,
  KeyRound,
  LayoutDashboard,
  type LucideIcon,
  Navigation,
  Package,
  Receipt,
  ScrollText,
  Settings,
  ShieldCheck,
  ShoppingCart,
  Ship,
  Truck,
  Users,
  UsersRound,
} from 'lucide-react';

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Au moins une de ces permissions (indication UI ; le serveur décide) */
  anyOf?: string[];
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

/** Navigation cible (CDC §1.3) regroupée par métier. */
export const NAV: NavGroup[] = [
  {
    label: 'Pilotage',
    items: [
      { href: '/', label: 'Tableau de bord', icon: LayoutDashboard, anyOf: ['dashboard.view'] },
      { href: '/notifications', label: 'Notifications', icon: Bell },
    ],
  },
  {
    label: 'Flotte & équipages',
    items: [
      { href: '/vessels', label: 'Navires', icon: Ship, anyOf: ['vessels.view'] },
      { href: '/members', label: 'Marins & personnel', icon: UsersRound, anyOf: ['members.view'] },
    ],
  },
  {
    label: 'Conformité',
    items: [
      { href: '/certificates', label: 'Certificats', icon: FileCheck2, anyOf: ['certificates.view'] },
      { href: '/cso', label: 'Documents CSO', icon: ShieldCheck, anyOf: ['cso.view'] },
    ],
  },
  {
    label: 'Achats',
    items: [
      { href: '/purchasing/requests', label: 'Purchase Requests', icon: ClipboardList, anyOf: ['pr.view'] },
      { href: '/purchasing/rfqs', label: 'RFQ & devis', icon: FileText, anyOf: ['rfq.view', 'quotation.view'] },
      { href: '/purchasing/orders', label: 'Bons de commande', icon: ShoppingCart, anyOf: ['bc.view'] },
      { href: '/purchasing/deliveries', label: 'Livraisons & réceptions', icon: Truck, anyOf: ['receiving.view'] },
      { href: '/purchasing/invoices', label: 'Factures', icon: Receipt, anyOf: ['invoice.view'] },
      { href: '/purchasing/suppliers', label: 'Fournisseurs', icon: Package, anyOf: ['suppliers.view'] },
    ],
  },
  {
    label: 'Opérations',
    items: [
      { href: '/voyages', label: 'Voyages', icon: Navigation, anyOf: ['voyages.view'] },
      { href: '/charter-parties', label: 'Charter Parties', icon: FileSignature, anyOf: ['charter_party.view'] },
      { href: '/noon-reports', label: 'Noon Reports', icon: Anchor, anyOf: ['noon.view'] },
    ],
  },
  {
    label: 'Administration',
    items: [
      { href: '/admin/users', label: 'Utilisateurs', icon: Users, anyOf: ['users.view'] },
      { href: '/admin/roles', label: 'Rôles & permissions', icon: KeyRound, anyOf: ['roles.view'] },
      { href: '/admin/departments', label: 'Départements', icon: Building2, anyOf: ['departments.view', 'departments.manage'] },
      {
        href: '/admin/audit',
        label: "Journal d'audit",
        icon: ScrollText,
        anyOf: ['audit.view.admin', 'audit.view.fleet', 'audit.view.members', 'audit.view.certificates', 'audit.view.purchasing', 'audit.view.voyages', 'audit.view.platform', 'cso.audit.view'],
      },
      { href: '/admin/settings', label: 'Paramètres', icon: Settings, anyOf: ['settings.manage'] },
      { href: '/admin/system', label: 'État du système', icon: Gauge, anyOf: ['settings.manage'] },
    ],
  },
];

/**
 * Page d'accueil selon les droits : tableau de bord, sinon première entrée de navigation autorisée
 * (ex. Crewing sans `dashboard.view` → Marins & personnel, ADM-09). Notifications en dernier recours.
 */
export function homeHref(canAny: (...permissions: string[]) => boolean): string {
  for (const group of NAV) for (const item of group.items) if (item.anyOf && canAny(...item.anyOf)) return item.href;
  return '/notifications';
}

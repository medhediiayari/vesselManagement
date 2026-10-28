export interface RoleRef {
  id: string;
  key: string;
  name: string;
}

export interface UserListItem {
  id: string;
  username: string;
  email: string | null;
  emailVerifiedAt: string | null;
  displayName: string;
  jobTitle: string | null;
  status: 'ACTIVE' | 'DEACTIVATED';
  locked: boolean;
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  vesselScope: 'ALL_FLEET' | 'SELECTED';
  memberId: string | null;
  roles: RoleRef[];
  departments: { id: string; code: string; name: string; status: string; isPrimary: boolean }[];
  createdAt: string;
}

export interface UserDetail extends UserListItem {
  overrides: { id: string; permissionKey: string; effect: 'ALLOW' | 'DENY'; reason: string | null; createdAt: string }[];
  vessels: { id: string; code: string; name: string }[];
  member: { id: string; firstName: string; lastName: string; amcRef: string | null } | null;
  activeSessions: number;
  effectivePermissions: string[];
  failedLogins: number;
}

export interface RoleDto {
  id: string;
  key: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  permissions: string[];
  userCount: number;
  updatedAt: string;
}

export interface PermissionDto {
  key: string;
  module: string;
  label: string;
  isSensitive: boolean;
}

export interface DepartmentDto {
  id: string;
  code: string;
  name: string;
  status: 'ACTIVE' | 'INACTIVE';
  primaryManager: { id: string; displayName: string } | null;
  deputies: { id: string; displayName: string }[];
  memberCount: number;
}

export const MODULE_LABELS: Record<string, string> = {
  admin: 'Administration',
  fleet: 'Flotte',
  members: 'Members',
  certificates: 'Certificats',
  cso: 'CSO (sûreté)',
  purchasing: 'Achats',
  voyages: 'Voyages',
  noon: 'Noon Reports',
  platform: 'Plateforme',
};

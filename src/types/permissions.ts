import { SuperRole } from './super-role';

export type Permission =
  | 'canViewUsers'
  | 'canCreateUsers'
  | 'canUpdateUsers'
  | 'canDeleteUsers'
  | 'canManagePermissions'
  | 'canViewDashboard'  // Example from your sample
  | 'canManageClasses'  // Add more as needed
  | 'canManageTursoDBs'
  | 'canManageSchools'
  | 'canSendSchoolInvites';
  // Extend with your school-like permissions if relevant, e.g., 'canViewStudents'

export type PermissionFlags = Record<Permission, boolean>;

export const defaultPermissions: Record<SuperRole, PermissionFlags> = {
  [SuperRole.SUPERADMIN]: {
    canViewUsers: true,
    canCreateUsers: true,
    canUpdateUsers: true,
    canDeleteUsers: true,
    canManagePermissions: true,
    canViewDashboard: true,
    canManageClasses: true,
    canManageTursoDBs: true,
    canManageSchools: true,
    canSendSchoolInvites: true,
  },
  [SuperRole.SUPERMANAGER]: {
    canViewUsers: true,
    canCreateUsers: false,
    canUpdateUsers: true,
    canDeleteUsers: false,
    canManagePermissions: false,
    canViewDashboard: true,
    canManageClasses: true,
    canManageTursoDBs: true,
    canManageSchools: true,
    canSendSchoolInvites: true,
  },
  [SuperRole.SUPERUSER]: {
    canViewUsers: false,
    canCreateUsers: false,
    canUpdateUsers: false,
    canDeleteUsers: false,
    canManagePermissions: false,
    canViewDashboard: false,
    canManageClasses: false,
    canManageTursoDBs: true,
    canManageSchools: true,
    canSendSchoolInvites: true,
  },
  // Add more roles/defaults
};
// server/shared/roles.js
// الأدوار (ROLES) ومجموعات الصلاحيات (ROLE_GROUPS) الخاصة بنظام Cortez
//
// القيم مسحوبة بالضبط من: (1) enum ديال role فـ User schema فـ server.js،
// و(2) كل مصفوفات verifyAuth([...]) الأصلية من قبل الـ refactor (git history).
// يعني هاذ الكاش مطابق 100% للأصلي، ماشي تخمين.

const ROLES = {
    DON: 'Don',
    UNDERBOSS: 'Underboss',
    BUSINESS_MANAGER: 'Business_Manager',
    GRH: 'GRH',
    GANG_SUPERVISOR: 'Gang_Supervisor',
    CHEF_BRAQUAGE: 'Chef_Braquage',
    SOLDAT: 'Soldat',
    GANG_MEMBER: 'Gang_Member'
};

const ROLE_GROUPS = {
    DON_ONLY: [ROLES.DON],
    ADMIN: [ROLES.UNDERBOSS, ROLES.GRH],
    DON_AND_ADMIN: [ROLES.DON, ROLES.UNDERBOSS, ROLES.GRH],
    SHOP_MANAGER: [ROLES.UNDERBOSS, ROLES.BUSINESS_MANAGER],
    DON_AND_SHOP: [ROLES.DON, ROLES.UNDERBOSS, ROLES.BUSINESS_MANAGER],
    ORDER_APPROVERS: [ROLES.DON, ROLES.UNDERBOSS, ROLES.BUSINESS_MANAGER, ROLES.GRH, ROLES.CHEF_BRAQUAGE],
    ATTENDANCE_VIEW: [ROLES.DON, ROLES.UNDERBOSS, ROLES.GRH, ROLES.BUSINESS_MANAGER],
    GANG_MEMBER_ONLY: [ROLES.GANG_MEMBER],
    MEMBERS: [ROLES.UNDERBOSS, ROLES.SOLDAT, ROLES.GRH, ROLES.CHEF_BRAQUAGE, ROLES.BUSINESS_MANAGER, ROLES.GANG_SUPERVISOR]
};

module.exports = { ROLES, ROLE_GROUPS };

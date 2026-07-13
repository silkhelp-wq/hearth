/** Permission bits — must mirror server/src/perms.js exactly. */

export const P = {
  VIEW_CHANNEL:    1 << 0,
  SEND_MESSAGES:   1 << 1,
  EMBED_LINKS:     1 << 2,
  MANAGE_MESSAGES: 1 << 3,
  CREATE_CHANNELS: 1 << 4,
  MANAGE_CHANNELS: 1 << 5,
  MANAGE_ROLES:    1 << 6,
  CONNECT:         1 << 7,
  SPEAK:           1 << 8,
  MUTE_MEMBERS:    1 << 9,
  KICK_MEMBERS:    1 << 10,
  ADMINISTRATOR:   1 << 11,
  MANAGE_EMOJIS:   1 << 12
};

export const ALL = (1 << 13) - 1;

export const PERM_LABELS = [
  [P.VIEW_CHANNEL, 'View channels'],
  [P.SEND_MESSAGES, 'Send messages'],
  [P.EMBED_LINKS, 'Embed links'],
  [P.MANAGE_MESSAGES, 'Manage messages (delete others\u2019, pin)'],
  [P.CREATE_CHANNELS, 'Create channels'],
  [P.MANAGE_CHANNELS, 'Manage channels (rename, delete, access)'],
  [P.MANAGE_ROLES, 'Manage roles'],
  [P.CONNECT, 'Connect to voice'],
  [P.SPEAK, 'Speak in voice'],
  [P.MUTE_MEMBERS, 'Mute members'],
  [P.KICK_MEMBERS, 'Kick members'],
  [P.MANAGE_EMOJIS, 'Manage emojis (upload, delete)'],
  [P.ADMINISTRATOR, 'Administrator (everything)']
];

export const has = (perms, bit) => (perms & bit) === bit;

/** Client-side base perms: OR of @everyone + held roles; owner = ALL. */
export function basePerms(user, roles, roleIds) {
  if (user?.isOwner) return ALL;
  let perms = 0;
  for (const r of roles) {
    if (r.id === 'everyone' || roleIds.includes(r.id)) perms |= r.permissions;
  }
  return (perms & P.ADMINISTRATOR) ? ALL : perms;
}

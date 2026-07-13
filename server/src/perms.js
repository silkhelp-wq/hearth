'use strict';
/**
 * Permission engine — Discord-shaped, trimmed to bits Hearth actually uses.
 *
 * Resolution order (same algorithm Discord documents):
 *   1. OR together @everyone + all of the user's roles      → base
 *   2. ADMINISTRATOR in base (or server owner)              → everything
 *   3. Channel overwrite for @everyone: strip deny, add allow
 *   4. Channel overwrites for the user's roles: OR the denies (strip),
 *      OR the allows (add)
 *   5. Channel overwrite for the member themselves: strip deny, add allow
 *
 * CREATE_CHANNELS is deliberately split out of MANAGE_CHANNELS (Discord
 * bundles them) so "everyone creates, admins delete" is expressible.
 */

const P = {
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

const ALL = (1 << 13) - 1;

const DEFAULT_EVERYONE =
  P.VIEW_CHANNEL | P.SEND_MESSAGES | P.EMBED_LINKS |
  P.CREATE_CHANNELS | P.CONNECT | P.SPEAK;

/** base = OR of every role the user holds (roles must include @everyone). */
function computeBase(isOwner, roleRows) {
  if (isOwner) return ALL;
  let perms = 0;
  for (const r of roleRows) perms |= r.permissions;
  if (perms & P.ADMINISTRATOR) return ALL;
  return perms;
}

/**
 * Apply channel overwrites to a base permission set.
 * overwrites: [{target_type:'role'|'user', target_id, allow, deny}]
 */
function computeChannel(base, overwrites, userId, roleIds) {
  if ((base & P.ADMINISTRATOR) === P.ADMINISTRATOR || base === ALL) return ALL;
  let perms = base;

  const everyone = overwrites.find(
    (o) => o.target_type === 'role' && o.target_id === 'everyone');
  if (everyone) { perms &= ~everyone.deny; perms |= everyone.allow; }

  let allow = 0, deny = 0;
  for (const o of overwrites) {
    if (o.target_type === 'role' && o.target_id !== 'everyone' &&
        roleIds.includes(o.target_id)) {
      allow |= o.allow; deny |= o.deny;
    }
  }
  perms &= ~deny; perms |= allow;

  const member = overwrites.find(
    (o) => o.target_type === 'user' && o.target_id === userId);
  if (member) { perms &= ~member.deny; perms |= member.allow; }

  return perms;
}

const has = (perms, bit) => (perms & bit) === bit;

module.exports = { P, ALL, DEFAULT_EVERYONE, computeBase, computeChannel, has };

const plexService = require('../services/plex');
const logger = require('./logger');

function normalizeValue(value) {
  if (value === undefined || value === null) {
    return '';
  }
  return String(value).trim().toLowerCase();
}

function gatherStrings(candidate) {
  if (!candidate) {
    return [];
  }
  if (Array.isArray(candidate)) {
    return candidate.flatMap(gatherStrings);
  }
  if (typeof candidate === 'object') {
    return [];
  }
  const value = String(candidate).trim();
  return value ? [value] : [];
}

function extractUserEmailCandidates(user) {
  if (!user) {
    return [];
  }
  const account = user.account || {};
  const values = [
    user.email,
    user.username,
    user.title,
    user.name,
    user.friendlyName,
    user.displayName,
    user.invitedEmail,
    account.email,
    account.username,
    account.title,
  ];
  if (Array.isArray(user.emails)) {
    values.push(...user.emails);
  }
  if (Array.isArray(user.invitations)) {
    values.push(
      ...user.invitations.flatMap((invitation) =>
        gatherStrings(invitation && (invitation.email || invitation.username))
      )
    );
  }
  return values
    .flatMap(gatherStrings)
    .map(normalizeValue)
    .filter((value) => value);
}

function extractUserIdCandidates(user) {
  if (!user) {
    return [];
  }
  const account = user.account || {};
  const values = [
    user.id,
    user.uuid,
    user.userID,
    user.machineIdentifier,
    user.accountID,
    account.id,
    account.uuid,
    account.machineIdentifier,
  ];
  return values
    .flatMap(gatherStrings)
    .map(normalizeValue)
    .filter((value) => value);
}

function isPlexUserPending(user) {
  if (!user) {
    return false;
  }
  if (user.pending === true) {
    return true;
  }
  const states = [user.status, user.state, user.friendStatus, user.requestStatus];
  return states
    .flatMap(gatherStrings)
    .map((value) => value.toLowerCase())
    .some((value) => value.includes('pending') || value.includes('invited'));
}

function preparePlexUserIndex(users) {
  return (Array.isArray(users) ? users : []).map((user) => ({
    user,
    emails: new Set(extractUserEmailCandidates(user)),
    ids: new Set(extractUserIdCandidates(user)),
    pending: isPlexUserPending(user),
  }));
}

function collectDonorEmailCandidates(donor) {
  const invites = Array.isArray(donor && donor.invites) ? donor.invites : [];
  const values = [donor && donor.email];
  invites.forEach((invite) => {
    values.push(invite && invite.recipientEmail);
    values.push(invite && invite.plexEmail);
  });
  return values
    .flatMap(gatherStrings)
    .map(normalizeValue)
    .filter((value) => value);
}

function collectDonorIdCandidates(donor) {
  const invites = Array.isArray(donor && donor.invites) ? donor.invites : [];
  const values = [donor && donor.plexAccountId];
  invites.forEach((invite) => {
    values.push(invite && invite.plexAccountId);
    values.push(invite && invite.plexInviteId);
  });
  return values
    .flatMap(gatherStrings)
    .map(normalizeValue)
    .filter((value) => value);
}

function annotateDonorWithPlex(donor, context) {
  const invites = Array.isArray(donor && donor.invites) ? donor.invites : [];
  const emailCandidates = collectDonorEmailCandidates(donor || {});
  const idCandidates = collectDonorIdCandidates(donor || {});
  const emailSet = new Set(emailCandidates);
  const idSet = new Set(idCandidates);
  const index = context && Array.isArray(context.index) ? context.index : [];
  const matchedEntry = index.find((entry) => {
    if (!entry) {
      return false;
    }
    const hasEmailMatch = emailCandidates.some((value) => entry.emails.has(value));
    const hasIdMatch = !hasEmailMatch && idCandidates.some((value) => entry.ids.has(value));
    return hasEmailMatch || hasIdMatch;
  });

  const plexShared = Boolean(matchedEntry && !matchedEntry.pending);
  const plexPendingFromUser = Boolean(matchedEntry && matchedEntry.pending);
  const hasActiveInvite = invites.some(
    (invite) => invite && !invite.revokedAt && (invite.plexInviteId || invite.inviteUrl)
  );
  const plexPending = plexPendingFromUser || (!plexShared && hasActiveInvite);
  const normalizedStatus = normalizeValue((donor && donor.status) || '');
  const statusIsRevoked = ['cancelled', 'canceled', 'expired', 'suspended'].includes(
    normalizedStatus
  );
  const statusIsActive = normalizedStatus === 'active';
  const hasEmail = emailSet.size > 0 && normalizeValue((donor && donor.email) || '') !== '';
  const canInvite = Boolean(
    context && context.configured && hasEmail && !statusIsRevoked && statusIsActive
  );
  const needsPlexInvite = canInvite && !plexShared && !plexPending && !hasActiveInvite;
  const plexShareState = plexShared ? 'shared' : plexPending ? 'pending' : 'not_shared';

  return {
    ...(donor || {}),
    plexShared,
    plexPending,
    needsPlexInvite,
    plexShareState,
  };
}

async function loadPlexContext({ logContext } = {}) {
  if (!plexService.isConfigured()) {
    return { configured: false, users: [], index: [], error: null };
  }

  const contextSuffix = logContext ? ` for ${logContext}` : '';

  try {
    const users = await plexService.listUsers();
    let sharedMembers = [];

    try {
      sharedMembers = await plexService.listSharedServerMembers();
    } catch (err) {
      logger.warn(
        `Failed to load Plex shared server members${contextSuffix}`,
        err && err.message
      );
      sharedMembers = [];
    }

    const sharedUsers = (Array.isArray(sharedMembers) ? sharedMembers : [])
      .map((member) => {
        if (!member) {
          return null;
        }

        const emails = Array.isArray(member.emails)
          ? member.emails.map((email) => String(email).trim()).filter(Boolean)
          : [];
        const ids = Array.isArray(member.ids)
          ? member.ids.map((id) => String(id).trim()).filter(Boolean)
          : [];

        if (!emails.length && !ids.length) {
          return null;
        }

        const primaryEmail = emails[0] || null;
        const primaryId = ids[0] || null;
        const statusValue = member && member.status ? String(member.status).trim() : '';
        const status = statusValue || (member && member.pending ? 'pending' : 'accepted');

        const baseUser = {
          email: primaryEmail,
          username: primaryEmail,
          title: primaryEmail,
          friendlyName: primaryEmail,
          invitedEmail: primaryEmail,
          emails,
          invitations: emails.map((email) => ({ email })),
          account: primaryEmail || primaryId
            ? {
                email: primaryEmail,
                id: primaryId,
                uuid: primaryId,
                machineIdentifier: primaryId,
              }
            : {},
          id: primaryId,
          uuid: primaryId,
          userID: primaryId,
          machineIdentifier: primaryId,
          accountID: primaryId,
          status,
          state: status,
          friendStatus: status,
          requestStatus: status,
        };

        return baseUser;
      })
      .filter(Boolean);

    const index = preparePlexUserIndex([...users, ...sharedUsers]);
    return { configured: true, users, index, error: null };
  } catch (err) {
    logger.warn(`Failed to load Plex users${contextSuffix}`, err && err.message);
    return {
      configured: true,
      users: [],
      index: [],
      error:
        err && err.message ? String(err.message) : 'Failed to load Plex users',
    };
  }
}

module.exports = {
  normalizeValue,
  gatherStrings,
  extractUserEmailCandidates,
  extractUserIdCandidates,
  isPlexUserPending,
  preparePlexUserIndex,
  collectDonorEmailCandidates,
  collectDonorIdCandidates,
  annotateDonorWithPlex,
  loadPlexContext,
};

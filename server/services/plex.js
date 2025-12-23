const fetch = require('node-fetch');
const { getPlexSettings } = require('../state/settings');
const { buildHeaders: buildPlexClientHeaders } = require('./plex-oauth');
const logger = require('../utils/logger');

const USER_LIST_ENDPOINTS = ['/accounts', '/api/v2/home/users', '/api/home/users'];
const LIBRARY_SECTIONS_ENDPOINT = '/library/sections';
const PLEX_TV_BASE_URL = 'https://plex.tv';
const userListPathCache = new Map();
const serverDescriptorCache = new Map();

const V2_SHARED_SERVERS_PATH = '/api/v2/friends';
const LEGACY_SHARED_SERVERS_PATH = (serverId) =>
  `/api/servers/${encodeURIComponent(String(serverId))}/shared_servers`;
const HOME_USER_EMAIL_KEYS = [
  'email',
  'username',
  'title',
  'friendlyname',
  'friendly_name',
  'name',
  'invitedemail',
  'invited_email',
];
const HOME_USER_ID_KEYS = [
  'invitedid',
  'invited_id',
  'homeuserid',
  'home_user_id',
  'userid',
  'user_id',
  'useruuid',
  'user_uuid',
  'uuid',
  'id',
  'accountid',
  'account_id',
  'machineidentifier',
  'machine_id',
  'machineid',
];
const SHARED_MEMBER_STATUS_KEYS = [
  'status',
  'state',
  'friendStatus',
  'friend_status',
  'friendState',
  'friend_state',
  'requestStatus',
  'request_status',
  'shareStatus',
  'share_status',
  'sharingStatus',
  'sharing_status',
  'sharingState',
  'sharing_state',
  'connectionState',
  'connection_state',
  'invitedState',
  'invited_state',
  'accepted',
  'approved',
];
const SHARED_MEMBER_TOP_LEVEL_ID_KEYS = HOME_USER_ID_KEYS.filter((key) => key !== 'id');
const SHARED_MEMBER_NESTED_KEYS = [
  'account',
  'user',
  'homeUser',
  'home_user',
  'sharedServer',
  'shared_server',
  'sharedServers',
  'shared_servers',
  'member',
  'friend',
  'recipient',
  'profile',
  'invited',
  'invitedUser',
  'invited_user',
  'server',
  'servers',
  'sharingSettings',
  'sharing_settings',
];
const SHARED_MEMBER_DEFAULT_STATUS = 'accepted';
const to01 = (value) => (value ? '1' : '0');

const asStringArray = (value) => {
  if (!value && value !== 0) {
    return [];
  }

  if (Array.isArray(value)) {
    return value.map((entry) => String(entry).trim()).filter((entry) => entry);
  }

  return String(value)
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry);
};

function normalizeId(value) {
  return String(value == null ? '' : value)
    .trim()
    .toLowerCase()
    .replace(/-/g, '');
}

function collectStrings(value) {
  if (value === undefined || value === null) {
    return [];
  }

  if (Array.isArray(value)) {
    return value.flatMap(collectStrings);
  }

  if (typeof value === 'object') {
    return [];
  }

  const normalized = String(value).trim();
  return normalized ? [normalized] : [];
}

function gatherValuesFromSource(result, source, keys) {
  if (!source || typeof source !== 'object') {
    return;
  }

  keys.forEach((key) => {
    if (!Object.prototype.hasOwnProperty.call(source, key)) {
      return;
    }

    result.push(...collectStrings(source[key]));
  });
}

function createSharedMemberAccumulator() {
  const store = new Map();

  const normalizeKeyPart = (values) =>
    values
      .map((value) => String(value).trim().toLowerCase())
      .filter((value) => value.length > 0)
      .sort()
      .join('|');

  const add = (member) => {
    if (!member) {
      return;
    }

    const emailKey = Array.isArray(member.emails)
      ? normalizeKeyPart(member.emails)
      : '';
    const idKey = Array.isArray(member.ids) ? normalizeKeyPart(member.ids) : '';
    const key = [emailKey, idKey].filter(Boolean).join('#');

    if (!key) {
      return;
    }

    if (store.has(key)) {
      const existing = store.get(key);

      const mergeArray = (target, values) => {
        values
          .map((value) => String(value).trim())
          .filter((value) => value.length > 0)
          .forEach((value) => {
            if (!target.includes(value)) {
              target.push(value);
            }
          });
      };

      mergeArray(existing.emails, Array.isArray(member.emails) ? member.emails : []);
      mergeArray(existing.ids, Array.isArray(member.ids) ? member.ids : []);

      existing.pending = existing.pending && Boolean(member.pending);

      const existingStatus = existing.status ? String(existing.status) : '';
      const candidateStatus = member.status ? String(member.status) : '';

      if (!existingStatus && candidateStatus) {
        existing.status = candidateStatus;
      } else if (existingStatus && candidateStatus) {
        const existingPending = existingStatus.toLowerCase().includes('pending');
        const candidatePending = candidateStatus.toLowerCase().includes('pending');
        if (existingPending && !candidatePending) {
          existing.status = candidateStatus;
        }
      }

      return;
    }

    const emails = Array.isArray(member.emails)
      ? member.emails
          .map((value) => String(value).trim())
          .filter((value) => value.length > 0)
      : [];
    const ids = Array.isArray(member.ids)
      ? member.ids
          .map((value) => String(value).trim())
          .filter((value) => value.length > 0)
      : [];

    store.set(key, {
      emails,
      ids,
      pending: Boolean(member.pending),
      status: member.status || (member.pending ? 'pending' : null),
    });
  };

  return {
    add,
    values() {
      return Array.from(store.values());
    },
  };
}

function normalizeSharedServerMember(candidate) {
  if (!candidate || typeof candidate !== 'object') {
    return null;
  }

  const emailValues = [];
  const idValues = [];
  const statusValues = [];
  const visitedStatusSources = new Set();

  gatherValuesFromSource(emailValues, candidate, HOME_USER_EMAIL_KEYS);
  gatherValuesFromSource(idValues, candidate, SHARED_MEMBER_TOP_LEVEL_ID_KEYS);
  gatherValuesFromSource(statusValues, candidate, SHARED_MEMBER_STATUS_KEYS);

  const nestedSources = SHARED_MEMBER_NESTED_KEYS.map((key) => candidate[key]).filter(
    (value) => value && typeof value === 'object'
  );

  nestedSources.forEach((source) => {
    gatherValuesFromSource(emailValues, source, HOME_USER_EMAIL_KEYS);
    gatherValuesFromSource(idValues, source, HOME_USER_ID_KEYS);
    gatherValuesFromSource(statusValues, source, SHARED_MEMBER_STATUS_KEYS);

    if (Array.isArray(source.emails)) {
      emailValues.push(...source.emails.flatMap(collectStrings));
    }
  });

  if (Array.isArray(candidate.emails)) {
    emailValues.push(...candidate.emails.flatMap(collectStrings));
  }

  const collectBooleanStatuses = (source) => {
    if (!source || typeof source !== 'object') {
      return;
    }

    if (visitedStatusSources.has(source)) {
      return;
    }

    visitedStatusSources.add(source);

    if (Array.isArray(source)) {
      source.forEach((entry) => collectBooleanStatuses(entry));
      return;
    }

    Object.entries(source).forEach(([key, value]) => {
      const normalizedKey = String(key || '').trim().toLowerCase();
      if (!normalizedKey) {
        return;
      }

      if (value && typeof value === 'object') {
        collectBooleanStatuses(value);
        return;
      }

      if (
        !normalizedKey.includes('pending') &&
        !normalizedKey.includes('invite') &&
        !normalizedKey.includes('accept') &&
        !normalizedKey.includes('approve')
      ) {
        return;
      }

      const normalizedValue = String(value).trim().toLowerCase();
      if (!normalizedValue) {
        return;
      }

      const isTruthy =
        value === true ||
        normalizedValue === 'true' ||
        normalizedValue === '1' ||
        normalizedValue === 'yes';
      const isFalsy =
        value === false ||
        normalizedValue === 'false' ||
        normalizedValue === '0' ||
        normalizedValue === 'no';

      if (normalizedKey.includes('pending') || normalizedKey.includes('invite')) {
        if (isTruthy || normalizedValue.includes('pending') || normalizedValue.includes('invite')) {
          statusValues.push('pending');
        }
      }

      if (normalizedKey.includes('accept') || normalizedKey.includes('approve')) {
        if (isTruthy || normalizedValue.includes('accept') || normalizedValue.includes('approve')) {
          statusValues.push('accepted');
        } else if (isFalsy) {
          statusValues.push('pending');
        }
      }
    });
  };

  collectBooleanStatuses(candidate);
  nestedSources.forEach((source) => collectBooleanStatuses(source));

  const emails = Array.from(
    new Set(emailValues.map((value) => String(value).trim()).filter((value) => value))
  );
  const ids = Array.from(
    new Set(idValues.map((value) => String(value).trim()).filter((value) => value))
  );
  const statuses = Array.from(
    new Set(statusValues.map((value) => String(value).trim()).filter((value) => value))
  );
  const normalizedStatuses = statuses.map((status) => status.toLowerCase());

  if (!emails.length && !ids.length) {
    return null;
  }

  let pending = normalizedStatuses.some((status) => {
    return (
      status.includes('pending') ||
      status.includes('invite') ||
      status.includes('request') ||
      status === 'false' ||
      status === '0' ||
      status === 'no'
    );
  });

  const prioritizedStatus = statuses.find((status) => {
    const normalized = status.toLowerCase();
    if (normalized === 'true' || normalized === 'false' || normalized === '1' || normalized === '0') {
      return false;
    }
    return true;
  });

  let status = prioritizedStatus || null;

  if (!status) {
    if (normalizedStatuses.includes('accepted')) {
      status = 'accepted';
    } else if (normalizedStatuses.includes('approved')) {
      status = 'approved';
    }
  }

  if (!pending && normalizedStatuses.includes('pending')) {
    pending = true;
  }

  if (!status) {
    status = pending ? 'pending' : SHARED_MEMBER_DEFAULT_STATUS;
  }

  return { emails, ids, pending, status };
}

function parseSharedServerMembersFromObject(data) {
  if (!data || typeof data !== 'object') {
    return [];
  }

  const accumulator = createSharedMemberAccumulator();
  const visited = new Set();

  const visit = (value) => {
    if (!value) {
      return;
    }

    if (typeof value !== 'object') {
      return;
    }

    if (visited.has(value)) {
      return;
    }
    visited.add(value);

    if (Array.isArray(value)) {
      value.forEach((entry) => visit(entry));
      return;
    }

    const member = normalizeSharedServerMember(value);
    if (member) {
      accumulator.add(member);
    }

    Object.values(value).forEach((child) => {
      if (child && typeof child === 'object') {
        visit(child);
      }
    });
  };

  visit(data);

  return accumulator.values();
}

function parseSharedServerMembersFromXml(payload) {
  if (!payload) {
    return [];
  }

  const text = String(payload);
  const accumulator = createSharedMemberAccumulator();

  const attr = (source, key) => {
    const pattern = new RegExp(`${key}="([^"]*)"`, 'i');
    const match = pattern.exec(source);
    return match ? match[1] : null;
  };

  const extractFromAttributes = (attributes = '', inner = '') => {
    const emailValues = [];
    const idValues = [];
    const statusValues = [];

    const emailAttr =
      attr(attributes, 'invitedEmail') ||
      attr(attributes, 'invited_email') ||
      attr(attributes, 'email') ||
      attr(attributes, 'username');
    if (emailAttr) {
      emailValues.push(emailAttr);
    }

    const idCandidates = [
      attr(attributes, 'invitedId'),
      attr(attributes, 'invited_id'),
      attr(attributes, 'invitedID'),
      attr(attributes, 'userId'),
      attr(attributes, 'userID'),
      attr(attributes, 'user_id'),
      attr(attributes, 'uuid'),
      attr(attributes, 'accountId'),
      attr(attributes, 'accountID'),
      attr(attributes, 'account_id'),
      attr(attributes, 'machineIdentifier'),
      attr(attributes, 'machineidentifier'),
      attr(attributes, 'machineID'),
      attr(attributes, 'machine_id'),
      attr(attributes, 'machineid'),
    ];
    idCandidates.filter(Boolean).forEach((value) => idValues.push(value));

    const statusCandidate =
      attr(attributes, 'status') ||
      attr(attributes, 'state') ||
      attr(attributes, 'friendStatus') ||
      attr(attributes, 'friend_status') ||
      attr(attributes, 'requestStatus') ||
      attr(attributes, 'request_status') ||
      attr(attributes, 'shareStatus') ||
      attr(attributes, 'share_status');
    if (statusCandidate) {
      statusValues.push(statusCandidate);
    }

    const nestedPattern = /<(User|Account)\b([^>]*)\/?>(?:<\/\1>)?/gi;
    let nestedMatch;
    while ((nestedMatch = nestedPattern.exec(inner))) {
      const nestedAttributes = nestedMatch[2] || '';
      const nestedEmail =
        attr(nestedAttributes, 'email') ||
        attr(nestedAttributes, 'username') ||
        attr(nestedAttributes, 'title');
      if (nestedEmail) {
        emailValues.push(nestedEmail);
      }
      const nestedId =
        attr(nestedAttributes, 'id') ||
        attr(nestedAttributes, 'uuid') ||
        attr(nestedAttributes, 'userID') ||
        attr(nestedAttributes, 'accountID') ||
        attr(nestedAttributes, 'machineIdentifier');
      if (nestedId) {
        idValues.push(nestedId);
      }
      const nestedStatus =
        attr(nestedAttributes, 'status') ||
        attr(nestedAttributes, 'state') ||
        attr(nestedAttributes, 'friendStatus');
      if (nestedStatus) {
        statusValues.push(nestedStatus);
      }
    }

    const emails = Array.from(
      new Set(emailValues.map((value) => String(value).trim()).filter((value) => value))
    );
    const ids = Array.from(
      new Set(idValues.map((value) => String(value).trim()).filter((value) => value))
    );
    const statuses = Array.from(
      new Set(statusValues.map((value) => String(value).trim()).filter((value) => value))
    );

    if (!emails.length && !ids.length) {
      return;
    }

    const pending = statuses.some((status) => {
      const normalized = status.toLowerCase();
      return normalized.includes('pending') || normalized.includes('invite');
    });
    const status = statuses[0] || (pending ? 'pending' : SHARED_MEMBER_DEFAULT_STATUS);

    accumulator.add({ emails, ids, pending, status });
  };

  const blockPattern = /<SharedServer\b([^>]*)>([\s\S]*?)<\/SharedServer>/gi;
  let blockMatch;
  while ((blockMatch = blockPattern.exec(text))) {
    extractFromAttributes(blockMatch[1] || '', blockMatch[2] || '');
  }

  const selfClosingPattern = /<SharedServer\b([^>]*)\/>/gi;
  let selfClosingMatch;
  while ((selfClosingMatch = selfClosingPattern.exec(text))) {
    extractFromAttributes(selfClosingMatch[1] || '', '');
  }

  return accumulator.values();
}

function parseSharedServerMembersPayload(payload) {
  if (!payload && payload !== 0) {
    return [];
  }

  if (typeof payload === 'object') {
    return parseSharedServerMembersFromObject(payload);
  }

  const text = String(payload).trim();
  if (!text) {
    return [];
  }

  try {
    const json = JSON.parse(text);
    return parseSharedServerMembersFromObject(json);
  } catch (err) {
    // fall back to XML parsing
  }

  return parseSharedServerMembersFromXml(text);
}

function hostFromUrl(url) {
  if (!url) {
    return '';
  }

  try {
    return new URL(url).host.toLowerCase();
  } catch (err) {
    return '';
  }
}

function isHttps(url) {
  if (!url) {
    return false;
  }

  try {
    return new URL(url).protocol === 'https:';
  } catch (err) {
    return false;
  }
}

function mapConnectionUri(connection) {
  if (!connection) {
    return null;
  }

  if (typeof connection === 'string') {
    return connection;
  }

  return (
    connection.uri ||
    connection.address ||
    connection.host ||
    null
  );
}

function pickPrimaryConnection(device) {
  const rawConnections = Array.isArray(device && device.connections)
    ? device.connections
    : [];

  const uris = rawConnections
    .map((connection) => mapConnectionUri(connection))
    .filter(Boolean);

  if (!uris.length) {
    return null;
  }

  const scored = uris
    .map((uri) => {
      const host = hostFromUrl(uri);
      const normalizedHost = host || '';
      const score =
        (isHttps(uri) ? 10 : 0) +
        (normalizedHost.startsWith('192.168.') ||
        normalizedHost.startsWith('10.') ||
        normalizedHost.startsWith('172.16.') ||
        normalizedHost.startsWith('172.17.') ||
        normalizedHost.startsWith('172.18.') ||
        normalizedHost.startsWith('172.19.') ||
        normalizedHost.startsWith('172.20.') ||
        normalizedHost.startsWith('172.21.') ||
        normalizedHost.startsWith('172.22.') ||
        normalizedHost.startsWith('172.23.') ||
        normalizedHost.startsWith('172.24.') ||
        normalizedHost.startsWith('172.25.') ||
        normalizedHost.startsWith('172.26.') ||
        normalizedHost.startsWith('172.27.') ||
        normalizedHost.startsWith('172.28.') ||
        normalizedHost.startsWith('172.29.') ||
        normalizedHost.startsWith('172.30.') ||
        normalizedHost.startsWith('172.31.')
          ? 2
          : 0);

      return { uri, score };
    })
    .sort((a, b) => b.score - a.score);

  return scored[0] ? scored[0].uri : null;
}

function getPlexConfig(overrideSettings) {
  if (overrideSettings && typeof overrideSettings === 'object') {
    return overrideSettings;
  }
  return getPlexSettings();
}

function isConfigured() {
  const plex = getPlexConfig();
  return Boolean(plex.baseUrl && plex.token);
}

function parseLibrarySectionIds(value) {
  return asStringArray(value);
}

function ensureBaseConfiguration(plex) {
  if (!plex.baseUrl || !plex.token) {
    throw new Error('Plex base URL and token must be configured');
  }
}

function ensureInviteConfiguration(plex) {
  ensureBaseConfiguration(plex);
  if (!plex.serverIdentifier) {
    throw new Error('Plex server UUID must be configured to create invites');
  }
}

function coerceArray(value) {
  if (!value) {
    return [];
  }
  if (Array.isArray(value)) {
    return value;
  }
  return [value];
}

const POSSIBLE_USER_INDICATOR_KEYS = new Set([
  ...HOME_USER_EMAIL_KEYS,
  ...HOME_USER_ID_KEYS,
  'emails',
  'invitations',
  'pending',
  'status',
  'state',
  'friendStatus',
  'requestStatus',
]);

function looksLikePlexUser(candidate) {
  if (!candidate || typeof candidate !== 'object') {
    return false;
  }

  return Array.from(POSSIBLE_USER_INDICATOR_KEYS).some((key) =>
    Object.prototype.hasOwnProperty.call(candidate, key)
  );
}

function normalizeUserPayload(value) {
  if (!value) {
    return [];
  }

  if (Array.isArray(value)) {
    return value.flatMap(normalizeUserPayload).filter(Boolean);
  }

  if (typeof value !== 'object') {
    return [];
  }

  const nestedCandidates = [];

  if (Object.prototype.hasOwnProperty.call(value, 'MediaContainer')) {
    nestedCandidates.push(value.MediaContainer);
  }

  if (Object.prototype.hasOwnProperty.call(value, 'mediaContainer')) {
    nestedCandidates.push(value.mediaContainer);
  }

  ['users', 'user', 'Users', 'User'].forEach((key) => {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      nestedCandidates.push(value[key]);
    }
  });

  if (nestedCandidates.length > 0) {
    return nestedCandidates.flatMap(normalizeUserPayload).filter(Boolean);
  }

  return looksLikePlexUser(value) ? [value] : [];
}

function mapSharedLibrariesFromResponse(data) {
  const container = data && (data.invitation || data);
  if (!container) {
    return [];
  }

  const candidates =
    container.libraries ||
    container.sharedLibraries ||
    (container.Metadata && container.Metadata.Metadata);

  const libraries = coerceArray(candidates).flatMap((entry) => {
    if (!entry) {
      return [];
    }
    if (Array.isArray(entry)) {
      return entry;
    }
    return [entry];
  });

  return libraries
    .map((library) => ({
      id:
        (library.id !== undefined && library.id !== null
          ? String(library.id)
          : library.sectionID !== undefined
          ? String(library.sectionID)
          : library.key
          ? String(library.key).replace(/^[^\d]*/, '')
          : null) || null,
      title:
        library.title ||
        library.name ||
        (library.librarySectionTitle || library.sectionTitle) ||
        null,
    }))
    .filter((library) => library.id || library.title);
}

function extractInviteId(data) {
  const container = data && (data.invitation || data);
  if (!container) {
    return null;
  }

  const candidate =
    container.id ||
    container.uuid ||
    container.inviteId ||
    container.identifier ||
    (container.Metadata && container.Metadata.id);

  if (candidate === undefined || candidate === null) {
    return null;
  }

  return String(candidate);
}

function extractInviteUrl(data) {
  const container = data && (data.invitation || data);
  if (!container) {
    return null;
  }

  const candidate =
    container.inviteUrl ||
    container.shareUrl ||
    container.uri ||
    container.url ||
    container.invite_uri ||
    (container.links && container.links.invite);

  if (!candidate) {
    const visited = new Set();
    const queue = [];

    const enqueue = (value) => {
      if (!value) {
        return;
      }

      if (visited.has(value)) {
        return;
      }

      if (typeof value === 'object' || Array.isArray(value)) {
        visited.add(value);
      }

      queue.push(value);
    };

    enqueue(container.links);

    while (queue.length) {
      const current = queue.shift();

      if (!current) {
        continue;
      }

      if (Array.isArray(current)) {
        for (const entry of current) {
          enqueue(entry);
        }
        continue;
      }

      if (typeof current !== 'object') {
        continue;
      }

      const rel =
        current.rel !== undefined && current.rel !== null
          ? String(current.rel).toLowerCase()
          : '';
      const type =
        current.type !== undefined && current.type !== null
          ? String(current.type).toLowerCase()
          : '';

      if (
        rel.includes('invite') ||
        rel.includes('accept') ||
        rel.includes('web') ||
        type.includes('invite') ||
        type.includes('accept') ||
        type.includes('web')
      ) {
        const linkCandidate = current.uri || current.url || current.href;
        if (linkCandidate) {
          return String(linkCandidate);
        }
      }

      for (const key of Object.keys(current)) {
        if (key === 'uri' || key === 'url' || key === 'href') {
          continue;
        }
        enqueue(current[key]);
      }
    }

    return null;
  }

  return String(candidate);
}

function extractInviteStatus(data) {
  const container = data && (data.invitation || data);
  if (!container) {
    return null;
  }

  const candidate = container.status || container.state || null;
  return candidate ? String(candidate) : null;
}

function extractInviteTimestamp(data) {
  const container = data && (data.invitation || data);
  if (!container) {
    return null;
  }

  const candidate =
    container.created_at ||
    container.createdAt ||
    container.addedAt ||
    container.last_modified ||
    null;

  if (!candidate) {
    return null;
  }

  const date = new Date(candidate);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date.toISOString();
}

function mapInviteResponse(data) {
  return {
    inviteId: extractInviteId(data),
    inviteUrl: extractInviteUrl(data),
    sharedLibraries: mapSharedLibrariesFromResponse(data),
    status: extractInviteStatus(data),
    invitedAt: extractInviteTimestamp(data),
  };
}

function normalizeBaseUrl(baseUrl) {
  if (!baseUrl) {
    return '';
  }
  return String(baseUrl).trim().replace(/\/+$/, '');
}

function buildUrlFromConfig(pathname, plex) {
  if (!plex || !plex.baseUrl) {
    throw new Error('Plex base URL is not configured');
  }
  if (!plex.token) {
    throw new Error('Plex token is not configured');
  }

  const base = normalizeBaseUrl(plex.baseUrl);
  const separator = pathname.includes('?') ? '&' : '?';
  return `${base}${pathname}${separator}X-Plex-Token=${encodeURIComponent(
    plex.token
  )}`;
}

function buildUrl(pathname, overrideSettings) {
  const plex = getPlexConfig(overrideSettings);
  return buildUrlFromConfig(pathname, plex);
}

async function extractErrorMessage(response) {
  try {
    const text = await response.text();
    const trimmed = text.trim();
    if (!trimmed) {
      return '';
    }
    if (/^</.test(trimmed)) {
      return '';
    }
    if (trimmed.length > 300) {
      return `${trimmed.slice(0, 297)}...`;
    }
    return trimmed;
  } catch (err) {
    return '';
  }
}

function getCacheKey(plex) {
  return normalizeBaseUrl(plex && plex.baseUrl);
}

function getServerIdCacheKey(plex) {
  if (!plex) {
    return null;
  }

  const token = plex.token ? String(plex.token).trim() : '';
  const identifier = plex.serverIdentifier
    ? String(plex.serverIdentifier).trim()
    : '';

  if (!token || !identifier) {
    return null;
  }

  return `${token}:${identifier}`;
}

function buildPlexTvUrl(pathname, plex) {
  if (!plex || !plex.token) {
    throw new Error('Plex token is not configured');
  }

  const raw = String(pathname || '').trim();
  const [pathPart, queryPart] = raw.split('?', 2);
  const normalizedPath = `/${String(pathPart || '')
    .trim()
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')}`;
  const baseUrl = `${PLEX_TV_BASE_URL}${normalizedPath}${
    queryPart ? `?${queryPart}` : ''
  }`;

  const separator = baseUrl.includes('?') ? '&' : '?';
  return `${baseUrl}${separator}X-Plex-Token=${encodeURIComponent(plex.token)}`;
}

function normalizeServerEntry(entry, defaults = {}) {
  if (!entry || typeof entry !== 'object') {
    return null;
  }

  const idCandidate =
    entry.id !== undefined && entry.id !== null
      ? entry.id
      : entry.serverID !== undefined && entry.serverID !== null
      ? entry.serverID
      : entry.serverId !== undefined && entry.serverId !== null
      ? entry.serverId
      : entry.server_id !== undefined && entry.server_id !== null
      ? entry.server_id
      : entry.serverid !== undefined && entry.serverid !== null
      ? entry.serverid
      : null;

  const machineIdentifierCandidate =
    entry.machineIdentifier ||
    entry.machine_identifier ||
    entry.machineID ||
    entry.machineid ||
    entry.machine_id ||
    entry.uuid ||
    entry.clientIdentifier ||
    entry.clientidentifier ||
    entry.client_id ||
    entry.clientID ||
    null;

  const id = idCandidate != null ? String(idCandidate).trim() : null;
  const machineIdentifier = machineIdentifierCandidate
    ? String(machineIdentifierCandidate).trim()
    : null;
  const clientIdentifier = entry.clientIdentifier
    ? String(entry.clientIdentifier).trim()
    : entry.clientidentifier
    ? String(entry.clientidentifier).trim()
    : entry.client_id
    ? String(entry.client_id).trim()
    : entry.clientID
    ? String(entry.clientID).trim()
    : null;
  const uuid = entry.uuid ? String(entry.uuid).trim() : null;
  const providesRaw =
    entry.provides !== undefined && entry.provides !== null
      ? entry.provides
      : defaults.defaultProvides !== undefined
      ? defaults.defaultProvides
      : null;
  const provides =
    providesRaw !== null && providesRaw !== undefined
      ? String(providesRaw).trim()
      : null;
  const nameCandidate =
    entry.name ||
    entry.friendlyName ||
    entry.device ||
    defaults.defaultName ||
    null;
  const name = nameCandidate ? String(nameCandidate).trim() : 'unknown';

  if (!id && !machineIdentifier && !clientIdentifier && !uuid) {
    return null;
  }

  return {
    id,
    machineIdentifier,
    clientIdentifier,
    uuid,
    provides,
    name,
  };
}

function flattenServerEntries(value) {
  return coerceArray(value).flatMap((entry) => {
    if (!entry || typeof entry !== 'object') {
      return [];
    }

    if (entry.Server || entry.server) {
      return flattenServerEntries(entry.Server || entry.server);
    }

    return [entry];
  });
}

function parseServerListFromObject(data) {
  if (Array.isArray(data)) {
    return data
      .map((entry) => normalizeServerEntry(entry, { defaultProvides: 'server' }))
      .filter(Boolean);
  }

  if (!data || typeof data !== 'object') {
    return [];
  }

  const container =
    data.MediaContainer || data.mediaContainer || data.container || data;

  const rawEntries = [
    container.Server,
    container.server,
    container.Servers,
    container.servers,
    container.Items,
    container.items,
    container.children,
    container.Children,
  ]
    .flatMap((value) => flattenServerEntries(value))
    .filter((entry) => entry && typeof entry === 'object');

  if (!rawEntries.length) {
    return flattenServerEntries(container)
      .map((entry) => normalizeServerEntry(entry, { defaultProvides: 'server' }))
      .filter(Boolean);
  }

  return rawEntries
    .map((entry) => normalizeServerEntry(entry, { defaultProvides: 'server' }))
    .filter(Boolean);
}

function extractXmlAttribute(tag, key) {
  if (!tag) {
    return null;
  }

  const pattern = new RegExp(`${key}="([^"]*)"`, 'i');
  const match = pattern.exec(tag);
  return match ? match[1] : null;
}

function parseServerListFromXml(payload) {
  if (!payload) {
    return [];
  }

  const xml = String(payload);
  const trimmed = xml.trim();
  if (!trimmed) {
    return [];
  }

  const containerMatch = /<MediaContainer[\s\S]*?>([\s\S]*?)<\/MediaContainer>/i.exec(trimmed);
  const body = containerMatch ? containerMatch[1] : trimmed;

  const results = [];
  const serverPattern = /<Server\b[^>]*\/?>(?:<\/Server>)?/gi;
  let match;

  while ((match = serverPattern.exec(body))) {
    const tag = match[0] || '';
    const rawAttributes = tag
      .replace(/^<Server\b/i, '')
      .replace(/\/?>(?:\s*<\/Server>)?$/i, '');
    const attributes = {};

    rawAttributes.replace(/([\w:-]+)="([^"]*)"/g, (_, key, value) => {
      attributes[key] = value;
      return '';
    });

    if (attributes.id == null) {
      const idValue = extractXmlAttribute(rawAttributes, 'id');
      if (idValue != null) {
        attributes.id = idValue;
      }
    }

    if (attributes.machineIdentifier == null) {
      const machine = extractXmlAttribute(rawAttributes, 'machineIdentifier');
      if (machine != null) {
        attributes.machineIdentifier = machine;
      }
    }

    if (attributes.clientIdentifier == null) {
      const client = extractXmlAttribute(rawAttributes, 'clientIdentifier');
      if (client != null) {
        attributes.clientIdentifier = client;
      }
    }

    if (attributes.provides == null) {
      attributes.provides = 'server';
    }

    results.push(attributes);
  }

  return results
    .map((entry) => normalizeServerEntry(entry, { defaultProvides: 'server' }))
    .filter(Boolean);
}

function parseServerListPayload(payload) {
  if (!payload) {
    return [];
  }

  const trimmed = String(payload).trim();
  if (!trimmed) {
    return [];
  }

  try {
    const data = JSON.parse(trimmed);
    const servers = Array.isArray(data)
      ? data
          .map((entry) => normalizeServerEntry(entry, { defaultProvides: 'server' }))
          .filter(Boolean)
      : parseServerListFromObject(data);

    if (servers.length) {
      return servers;
    }
  } catch (err) {
    // Ignore JSON parsing errors and fall back to XML parsing.
  }

  return parseServerListFromXml(trimmed);
}

function parseResourcesPayload(payload) {
  if (!payload) {
    return [];
  }

  const trimmed = String(payload).trim();
  if (!trimmed) {
    return [];
  }

  const mapConnections = (rawConnections) =>
    (Array.isArray(rawConnections) ? rawConnections : [])
      .map((connection) => {
        if (!connection || typeof connection !== 'object') {
          return null;
        }

        const uri =
          connection.uri ||
          connection.address ||
          connection.host ||
          connection.relay ||
          '';
        return { uri: uri ? String(uri) : '' };
      })
      .filter(Boolean);

  const mapDevice = (device) => {
    if (!device || typeof device !== 'object') {
      return null;
    }

    return {
      name: device.name || device.product || device.device || 'unknown',
      provides: String(device.provides || '').toLowerCase(),
      clientIdentifier: device.clientIdentifier || null,
      machineIdentifier: device.machineIdentifier || null,
      accessToken: device.accessToken || null,
      owned:
        device.owned !== undefined && device.owned !== null
          ? String(device.owned).trim().toLowerCase()
          : null,
      connections: mapConnections(device.connections || device.Connection),
    };
  };

  try {
    const json = JSON.parse(trimmed);
    if (Array.isArray(json)) {
      return json.map(mapDevice).filter(Boolean);
    }

    const devices = json && json.MediaContainer && json.MediaContainer.Device;
    if (Array.isArray(devices)) {
      return devices.map(mapDevice).filter(Boolean);
    }
  } catch (err) {
    // fall back to XML parsing
  }

  const devices = [];
  const devicePattern = /<Device\b([^>]+)>([\s\S]*?)<\/Device>/gi;
  const attr = (source, key) => {
    const match = new RegExp(`${key}="([^"]*)"`, 'i').exec(source);
    return match ? match[1] : null;
  };
  const connectionPattern = /<Connection\b([^>]+?)\/?>(?:<\/Connection>)?/gi;

  let deviceMatch;
  while ((deviceMatch = devicePattern.exec(trimmed))) {
    const deviceAttributes = deviceMatch[1] || '';
    const inner = deviceMatch[2] || '';
    const provides = String(attr(deviceAttributes, 'provides') || '').toLowerCase();
    const clientIdentifier = attr(deviceAttributes, 'clientIdentifier');
    const machineIdentifier = attr(deviceAttributes, 'machineIdentifier');
    const name =
      attr(deviceAttributes, 'name') ||
      attr(deviceAttributes, 'product') ||
      attr(deviceAttributes, 'device') ||
      'unknown';
    const accessToken = attr(deviceAttributes, 'accessToken');
    const ownedAttr = attr(deviceAttributes, 'owned');

    const connections = [];
    let connectionMatch;
    while ((connectionMatch = connectionPattern.exec(inner))) {
      const connectionAttributes = connectionMatch[1] || '';
      const uri =
        attr(connectionAttributes, 'uri') ||
        attr(connectionAttributes, 'address') ||
        attr(connectionAttributes, 'host') ||
        attr(connectionAttributes, 'relay') ||
        '';
      connections.push({ uri: uri ? String(uri) : '' });
    }

    devices.push({
      name,
      provides,
      clientIdentifier,
      machineIdentifier,
      accessToken,
      owned: ownedAttr ? ownedAttr.toLowerCase() : null,
      connections,
    });
  }

  return devices;
}

async function fetchPlexResources(plex) {
  const headers = buildPlexClientHeaders(getClientIdentifier(plex), {
    'X-Plex-Token': plex.token,
  });
  delete headers['Content-Type'];
  delete headers.Accept;

  const url = buildPlexTvUrl('/api/resources?includeHttps=1&includeRelay=1', plex);
  let response;
  try {
    response = await fetch(url, { headers });
  } catch (err) {
    throw new Error(`Failed to fetch Plex resources: ${err.message}`);
  }

  if (response.status === 401 || response.status === 403) {
    throw new Error('Plex rejected the provided token.');
  }

  if (!response.ok) {
    const details = await extractErrorMessage(response);
    const statusText = response.statusText || 'Error';
    const suffix = details ? `: ${details}` : '';
    throw new Error(
      `Failed to fetch Plex resources: ${response.status} (${statusText})${suffix}`
    );
  }

  const payload = await response.text();
  return parseResourcesPayload(payload);
}

function detectServerFromResources(resources, baseUrlHost) {
  const entries = Array.isArray(resources) ? resources : [];
  const serverDevices = entries.filter((device) => {
    if (!device || typeof device !== 'object') {
      return false;
    }

    return String(device.provides || '').includes('server');
  });

  if (!serverDevices.length) {
    return null;
  }

  if (baseUrlHost) {
    for (const device of serverDevices) {
      if (!device || !Array.isArray(device.connections)) {
        continue;
      }

      const hasMatch = device.connections.some((connection) => {
        if (!connection || !connection.uri) {
          return false;
        }
        return hostFromUrl(connection.uri) === baseUrlHost;
      });

      if (hasMatch && device.clientIdentifier) {
        return { type: 'clientIdentifier', value: device.clientIdentifier, source: device };
      }
    }
  }

  if (serverDevices.length === 1) {
    const device = serverDevices[0];
    if (device && device.clientIdentifier) {
      return { type: 'clientIdentifier', value: device.clientIdentifier, source: device };
    }
  }

  return { type: 'ambiguous', candidates: serverDevices };
}

async function fetchPlexServers(plex) {
  const headers = buildPlexClientHeaders(getClientIdentifier(plex), {
    'X-Plex-Token': plex.token,
  });
  delete headers['Content-Type'];
  delete headers.Accept;

  let response;
  try {
    response = await fetch(buildPlexTvUrl('/api/servers', plex), { headers });
  } catch (err) {
    throw new Error(`Failed to resolve Plex server id: ${err.message}`);
  }

  if (response.status === 401 || response.status === 403) {
    throw new Error('Plex rejected the provided token.');
  }

  if (!response.ok) {
    const details = await extractErrorMessage(response);
    const statusText = response.statusText || 'Error';
    const suffix = details ? `: ${details}` : '';
    throw new Error(
      `Failed to resolve Plex server id: ${response.status} (${statusText})${suffix}`
    );
  }

  const payload = await response.text();
  return parseServerListPayload(payload);
}

function detectServerFromServers(servers) {
  const list = Array.isArray(servers) ? servers.filter(Boolean) : [];
  if (list.length === 1) {
    const entry = list[0];
    const value = entry.machineIdentifier || entry.clientIdentifier || null;
    if (value) {
      return { type: 'machineIdentifier', value, source: entry };
    }
  }

  return null;
}

async function getOrResolveServerIdentifier(plex) {
  if (plex && plex.serverIdentifier) {
    const normalized = normalizeId(plex.serverIdentifier);
    if (normalized) {
      return String(plex.serverIdentifier).trim();
    }
  }

  const baseUrlHost = hostFromUrl(plex && plex.baseUrl);

  try {
    const resources = await fetchPlexResources(plex);
    const detected = detectServerFromResources(resources, baseUrlHost);
    if (detected && detected.type === 'clientIdentifier' && detected.value) {
      const normalized = normalizeId(detected.value);
      if (normalized) {
        return String(detected.value).trim();
      }
    }

    if (detected && detected.type === 'ambiguous') {
      // fall through to /api/servers to disambiguate
    }
  } catch (err) {
    // Ignore and fall back to /api/servers
  }

  try {
    const servers = await fetchPlexServers(plex);
    const detected = detectServerFromServers(servers);
    if (detected && detected.value) {
      const normalized = normalizeId(detected.value);
      if (normalized) {
        return String(detected.value).trim();
      }
    }

    const sample = summarizeServerIdentifiers(servers, 5);
    if (sample.length > 1) {
      throw new Error(
        `Multiple Plex servers found; set \"serverIdentifier\" or provide \"baseUrl\" to disambiguate. Candidates: ${JSON.stringify(
          sample
        )}`
      );
    }
  } catch (err) {
    throw new Error(`Failed to auto-detect Plex server identifier: ${err.message}`);
  }

  throw new Error('Failed to auto-detect Plex server identifier: No matching server found.');
}

function findServerMatch(servers, normalizedIdentifier) {
  if (!Array.isArray(servers) || !servers.length) {
    return null;
  }

  const matches = (value) => {
    const normalized = normalizeId(value);
    return normalized && normalized === normalizedIdentifier;
  };

  for (const server of servers) {
    if (!server || typeof server !== 'object') {
      continue;
    }

    const candidates = [
      server.machineIdentifier,
      server.clientIdentifier,
      server.uuid,
      server.id,
      server.server_id,
      server.serverId,
      server.serverID,
    ];

    if (candidates.some(matches)) {
      return server;
    }
  }

  return null;
}

function summarizeServerIdentifiers(servers, limit = 10) {
  if (!Array.isArray(servers) || !servers.length) {
    return [];
  }

  return servers.slice(0, limit).reduce((acc, server) => {
    if (!server || typeof server !== 'object') {
      return acc;
    }

    acc.push({
      name: server.name || server.friendlyName || server.device || 'unknown',
      machineIdentifier: server.machineIdentifier || null,
      clientIdentifier: server.clientIdentifier || null,
      id: server.id || null,
      uuid: server.uuid || null,
      provides: server.provides || null,
    });

    return acc;
  }, []);
}

async function resolveServerId(plex) {
  const descriptor = await resolveServerDescriptor(plex);

  // Try legacy numeric ID first
  if (descriptor.legacyNumericId) {
    return descriptor.legacyNumericId;
  }

  // Fall back to machine identifier - modern Plex accepts this too
  if (descriptor.machineIdentifier) {
    logger.info('Using machine identifier as server ID (legacy numeric ID not available)');
    return descriptor.machineIdentifier;
  }

  const sample = summarizeServerIdentifiers([
    {
      name: descriptor.name,
      machineIdentifier: descriptor.machineIdentifier,
      id: descriptor.legacyNumericId,
    },
  ]);
  throw new Error(
    `Could not determine server ID for invite API. Matched: ${JSON.stringify(sample)}`
  );
}

async function resolveServerDescriptor(plex) {
  if (!plex || !plex.serverIdentifier) {
    throw new Error('Plex server UUID must be configured to create invites');
  }

  const machineIdentifier = String(plex.serverIdentifier).trim();
  if (!machineIdentifier) {
    throw new Error('Plex server UUID must be configured to create invites');
  }

  const cacheKey = getServerIdCacheKey(plex);
  if (cacheKey && serverDescriptorCache.has(cacheKey)) {
    return serverDescriptorCache.get(cacheKey);
  }

  const normalizedIdentifier = normalizeId(machineIdentifier);
  if (!normalizedIdentifier) {
    throw new Error('Plex server UUID must be configured to create invites');
  }

  let resources;
  try {
    resources = await fetchPlexResources(plex);
  } catch (err) {
    throw new Error(`Failed to resolve Plex server via /api/resources: ${err.message}`);
  }

  const serversFromResources = Array.isArray(resources)
    ? resources.filter((device) => {
        if (!device || typeof device !== 'object') {
          return false;
        }

        return String(device.provides || '').toLowerCase().includes('server');
      })
    : [];

  if (!serversFromResources.length) {
    throw new Error(
      'No Plex servers were returned from /api/resources. Confirm the token owns the server and that it is published.'
    );
  }

  const ownedServers = serversFromResources.filter((device) => {
    const ownedValue = device.owned;
    if (ownedValue === undefined || ownedValue === null) {
      return false;
    }

    const normalized = String(ownedValue).trim().toLowerCase();
    return ownedValue === true || ownedValue === 1 || normalized === '1' || normalized === 'true' || normalized === 'yes';
  });

  if (!ownedServers.length) {
    const sample = summarizeServerIdentifiers(serversFromResources, 5);
    throw new Error(
      `/api/resources did not return any owned Plex servers. Ensure the server is claimed by this account. Servers=${JSON.stringify(sample)}`
    );
  }

  const candidates = ownedServers;
  let matchedDevice = candidates.find((device) => {
    const possible = [device.clientIdentifier, device.machineIdentifier];
    return possible.some((value) => normalizeId(value) === normalizedIdentifier);
  });

  if (!matchedDevice && candidates.length === 1) {
    matchedDevice = candidates[0];
  }

  if (!matchedDevice) {
    const sample = candidates.slice(0, 5).map((device) => ({
      name: device.name || 'unknown',
      clientIdentifier: device.clientIdentifier || null,
      owned: device.owned || null,
    }));
    throw new Error(
      `Plex server identifier "${machineIdentifier}" was not found in /api/resources. Owned servers: ${JSON.stringify(sample)}`
    );
  }

  if (matchedDevice.owned !== undefined && matchedDevice.owned !== null) {
    const normalizedOwned = String(matchedDevice.owned).trim().toLowerCase();
    const isOwned =
      matchedDevice.owned === true ||
      matchedDevice.owned === 1 ||
      normalizedOwned === '1' ||
      normalizedOwned === 'true' ||
      normalizedOwned === 'yes';

    if (!isOwned) {
      throw new Error(
        `Plex token does not own server "${matchedDevice.name || 'unknown'}". Ensure the PMS is claimed by this account.`
      );
    }
  }

  let legacyNumericId = null;
  try {
    const servers = await fetchPlexServers(plex);
    const match =
      findServerMatch(servers, normalizedIdentifier) ||
      findServerMatch(
        Array.isArray(servers)
          ? servers.filter((server) =>
              server && typeof server === 'object'
                ? String(server.provides || '').toLowerCase().includes('server')
                : false
            )
          : [],
        normalizedIdentifier
      );

    if (match && match.id != null) {
      legacyNumericId = String(match.id).trim();
    } else if (match && match.server_id != null) {
      legacyNumericId = String(match.server_id).trim();
    } else if (match && match.serverId != null) {
      legacyNumericId = String(match.serverId).trim();
    }
  } catch (err) {
    // Ignore failure; legacy id is only required for fallback paths.
  }

  const descriptor = {
    machineIdentifier: matchedDevice.clientIdentifier
      ? String(matchedDevice.clientIdentifier).trim()
      : machineIdentifier,
    legacyNumericId: legacyNumericId || null,
    name: matchedDevice.name || 'unknown',
    clientIdentifier: matchedDevice.clientIdentifier || null,
    device: matchedDevice,
  };

  if (cacheKey) {
    serverDescriptorCache.set(cacheKey, descriptor);
  }

  return descriptor;
}

async function buildSharedServersPath(plex) {
  if (!plex || !plex.serverIdentifier) {
    throw new Error('Plex server UUID must be configured to create invites');
  }

  const serverId = await resolveServerId(plex);
  return LEGACY_SHARED_SERVERS_PATH(serverId);
}

async function buildSharedServerUrl(plex, inviteId) {
  const basePath = await buildSharedServersPath(plex);
  if (inviteId === undefined || inviteId === null) {
    return buildPlexTvUrl(basePath, plex);
  }

  const encodedId = encodeURIComponent(String(inviteId));
  return buildPlexTvUrl(`${basePath}/${encodedId}`, plex);
}

function getClientIdentifier(plex) {
  if (!plex) {
    return 'plex-donate';
  }

  if (plex.clientIdentifier) {
    return String(plex.clientIdentifier).trim() || 'plex-donate';
  }

  if (plex.serverIdentifier) {
    return `plex-donate-${String(plex.serverIdentifier).trim() || 'server'}`;
  }

  return 'plex-donate';
}

function buildSharedServerHeaders(plex, extra = {}) {
  if (!plex || !plex.token) {
    throw new Error('Plex token is not configured');
  }

  return buildPlexClientHeaders(getClientIdentifier(plex), {
    'X-Plex-Token': plex.token,
    ...extra,
  });
}

async function fetchSharedServerMembersLegacy(plex, headers) {
  const workingPlex = { ...plex };
  let serverIdentifier;

  try {
    serverIdentifier = await getOrResolveServerIdentifier(workingPlex);
  } catch (err) {
    throw new Error(
      `Failed to resolve Plex server identifier for shared members: ${err.message}`
    );
  }

  workingPlex.serverIdentifier = serverIdentifier;

  const sharedServerUrl = await buildSharedServerUrl(workingPlex);

  let response;
  try {
    response = await fetch(sharedServerUrl, {
      method: 'GET',
      headers,
    });
  } catch (err) {
    throw new Error(`Failed to connect to Plex shared server API: ${err.message}`);
  }

  if (response.status === 401 || response.status === 403) {
    throw new Error('Plex rejected the provided token.');
  }

  if (response.status === 404 || response.status === 410) {
    return [];
  }

  if (!response.ok) {
    const details = await extractErrorMessage(response);
    const statusText = response.statusText || 'Error';
    const suffix = details ? `: ${details}` : '';
    throw new Error(
      `Failed to fetch Plex shared servers: ${response.status} (${statusText})${suffix}`
    );
  }

  const payload = await response.text();
  return parseSharedServerMembersPayload(payload);
}

function friendSharesServer(candidate, normalizedServerId) {
  if (!candidate || typeof candidate !== 'object' || !normalizedServerId) {
    return false;
  }

  const visited = new Set();
  const stack = [candidate];
  const SERVER_ID_KEYS = [
    'machineIdentifier',
    'machineidentifier',
    'serverId',
    'server_id',
    'serverid',
    'serverUuid',
    'server_uuid',
    'serveruuid',
  ];
  const NESTED_SERVER_KEYS = [
    'sharedServers',
    'shared_servers',
    'sharedServer',
    'shared_server',
    'servers',
    'server',
    'sharingSettings',
    'sharing_settings',
  ];

  while (stack.length) {
    const current = stack.pop();
    if (!current || typeof current !== 'object' || visited.has(current)) {
      continue;
    }
    visited.add(current);

    for (const key of SERVER_ID_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(current, key)) {
        continue;
      }

      const value = current[key];
      if (Array.isArray(value)) {
        if (value.some((entry) => normalizeId(entry) === normalizedServerId)) {
          return true;
        }
      } else if (normalizeId(value) === normalizedServerId) {
        return true;
      }
    }

    for (const key of NESTED_SERVER_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(current, key)) {
        continue;
      }

      const nested = current[key];
      if (Array.isArray(nested)) {
        nested.forEach((entry) => {
          if (entry && typeof entry === 'object') {
            stack.push(entry);
          }
        });
      } else if (nested && typeof nested === 'object') {
        stack.push(nested);
      }
    }
  }

  return false;
}

function filterFriendsPayloadByServer(data, serverIdentifier) {
  if (!serverIdentifier || !data || typeof data !== 'object') {
    return data;
  }

  const normalizedServerId = normalizeId(serverIdentifier);
  if (!normalizedServerId) {
    return data;
  }

  const mediaContainer = data.MediaContainer;
  if (!mediaContainer || typeof mediaContainer !== 'object') {
    return data;
  }

  const metadata = mediaContainer.Metadata;
  if (!Array.isArray(metadata)) {
    return data;
  }

  const filteredMetadata = metadata.filter((entry) => friendSharesServer(entry, normalizedServerId));
  if (filteredMetadata.length === metadata.length) {
    return data;
  }

  return {
    ...data,
    MediaContainer: {
      ...mediaContainer,
      Metadata: filteredMetadata,
    },
  };
}

async function fetchSharedServerMembersV2(plex, headers) {
  const url =
    `https://plex.tv${V2_SHARED_SERVERS_PATH}?` +
    new URLSearchParams({ 'X-Plex-Token': plex.token }).toString();

  let response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers,
    });
  } catch (err) {
    throw new Error(`Failed to connect to Plex shared server API: ${err.message}`);
  }

  if (response.status === 401 || response.status === 403) {
    throw new Error('Plex rejected the provided token.');
  }

  if (response.status === 404 || response.status === 410) {
    return { members: [], notFound: true };
  }

  if (!response.ok) {
    const details = await extractErrorMessage(response);
    const statusText = response.statusText || 'Error';
    const suffix = details ? `: ${details}` : '';
    throw new Error(
      `Failed to fetch Plex shared server members: ${response.status} (${statusText})${suffix}`
    );
  }

  const payload = await response.text();

  try {
    const json = JSON.parse(payload);
    const filtered = filterFriendsPayloadByServer(json, plex.serverIdentifier);
    return { members: parseSharedServerMembersFromObject(filtered), notFound: false };
  } catch (err) {
    return { members: parseSharedServerMembersPayload(payload), notFound: false };
  }
}

function normalizeLibraryList(libraries) {
  const seen = new Set();
  return mapSharedLibrariesFromResponse({ libraries })
    .map((library) => {
      if (!library) {
        return null;
      }
      const id = library.id != null ? String(library.id).trim() : '';
      if (!id) {
        return null;
      }
      const title = library.title ? String(library.title).trim() : '';
      return { id, title: title || id };
    })
    .filter((library) => {
      if (!library) {
        return false;
      }
      if (seen.has(library.id)) {
        return false;
      }
      seen.add(library.id);
      return true;
    });
}

function parseLibrarySectionsPayload(payload) {
  if (!payload) {
    return [];
  }

  try {
    const data = JSON.parse(payload);
    if (data && typeof data === 'object') {
      const container =
        data.MediaContainer || data.mediaContainer || data.container || data;
      if (container && typeof container === 'object') {
        const directories =
          container.Directory ||
          container.directory ||
          container.Metadata ||
          container.metadata ||
          [];
        const normalized = normalizeLibraryList(coerceArray(directories));
        if (normalized.length) {
          return normalized;
        }
      }
    }
  } catch (err) {
    // Ignore JSON parsing errors and fall back to XML parsing.
  }

  const directories = [];
  const pattern = /<Directory\b[^>]*>/gi;
  let match;
  while ((match = pattern.exec(payload))) {
    const tag = match[0];
    const attributes = {};
    tag.replace(/([\w-]+)="([^"]*)"/g, (_, key, value) => {
      attributes[key] = value;
      return '';
    });
    directories.push(attributes);
  }

  return normalizeLibraryList(directories);
}

function normalizeSectionKeyParts(value) {
  const raw = value === undefined || value === null ? '' : String(value).trim();
  if (!raw) {
    return { raw: '', sanitized: '', numeric: '' };
  }

  const sanitized = raw.split(/[?#]/)[0].replace(/\/+$/, '');
  const numericMatch = sanitized.match(/(?:^|\/)(\d+)$/);
  const numeric = numericMatch && numericMatch[1] ? numericMatch[1] : '';

  return { raw, sanitized: sanitized || raw, numeric };
}

function parseServerSectionsPayload(payload) {
  if (!payload) {
    return { sectionIds: [], keyToIdMap: {} };
  }

  const sectionIds = new Set();
  const keyToIdMap = new Map();

  const addSectionId = (value) => {
    if (value === undefined || value === null) {
      return null;
    }

    const normalized = String(value).trim();
    if (!normalized) {
      return null;
    }

    sectionIds.add(normalized);
    return normalized;
  };

  const recordKeyMapping = (keyCandidate, idValue) => {
    if (idValue === undefined || idValue === null) {
      return;
    }

    const normalizedId = String(idValue).trim();
    if (!normalizedId) {
      return;
    }

    const parts = normalizeSectionKeyParts(keyCandidate);
    if (!parts.raw) {
      return;
    }

    keyToIdMap.set(parts.raw, normalizedId);
    if (parts.sanitized && parts.sanitized !== parts.raw) {
      keyToIdMap.set(parts.sanitized, normalizedId);
    }
    if (parts.numeric) {
      keyToIdMap.set(parts.numeric, normalizedId);
    }
  };

  const pushSectionLike = (section) => {
    if (!section) {
      return;
    }

    if (typeof section === 'object') {
      const hasExplicitId = Object.prototype.hasOwnProperty.call(section, 'id');
      const idValue = hasExplicitId ? section.id : section.ID;
      const hasUsableId =
        idValue !== undefined && idValue !== null && String(idValue).trim() !== '';

      const normalizedId = hasUsableId ? addSectionId(idValue) : null;

      const keyCandidate =
        Object.prototype.hasOwnProperty.call(section, 'key')
          ? section.key
          : Object.prototype.hasOwnProperty.call(section, 'Key')
          ? section.Key
          : undefined;

      if (normalizedId) {
        recordKeyMapping(keyCandidate, normalizedId);
      } else if (keyCandidate !== undefined) {
        const keyParts = normalizeSectionKeyParts(keyCandidate);
        if (keyParts.numeric) {
          const fallbackId = addSectionId(keyParts.numeric);
          if (fallbackId) {
            recordKeyMapping(keyCandidate, fallbackId);
          }
        }
      }

      return;
    }

    const fallbackId = addSectionId(section);
    if (fallbackId) {
      recordKeyMapping(section, fallbackId);
    }
  };

  try {
    const data = JSON.parse(payload);
    if (data && typeof data === 'object') {
      const container = data.MediaContainer || data.mediaContainer || data.container || data;
      const servers = coerceArray(
        (container && (container.Server || container.server)) ||
          (container && (container.Servers || container.servers)) ||
          []
      );

      servers.forEach((server) => {
        const sections = coerceArray(
          (server && (server.Section || server.section)) ||
            (server && (server.Sections || server.sections)) ||
            (server && (server.Directory || server.directory)) ||
            (server && (server.Metadata || server.metadata)) ||
            []
        );

        sections.forEach((section) => {
          pushSectionLike(section);
        });
      });
    }
  } catch (err) {
    // Ignore JSON parsing errors and fall back to XML parsing.
  }

  const pattern = /<Section\b[^>]*>/gi;
  let match;
  while ((match = pattern.exec(payload))) {
    const attributes = {};
    match[0].replace(/([\w-]+)="([^"]*)"/g, (_, attribute, value) => {
      attributes[String(attribute || '').toLowerCase()] = value;
      return '';
    });
    pushSectionLike({
      id: attributes.id,
      key: attributes.key,
    });
  }

  const normalizedKeyToIdMap = Object.fromEntries(
    Array.from(keyToIdMap.entries()).map(([key, value]) => [String(key), String(value)])
  );

  const normalizedSectionIds = Array.from(sectionIds).map((id) => String(id));
  normalizedSectionIds.forEach((id) => {
    normalizedKeyToIdMap[id] = id;
  });

  const mapValues = Object.values(normalizedKeyToIdMap);
  const uniqueMapValues = Array.from(new Set(mapValues));
  const finalSectionIds = normalizedSectionIds.length
    ? normalizedSectionIds
    : uniqueMapValues;

  return {
    sectionIds: finalSectionIds,
    keyToIdMap: normalizedKeyToIdMap,
  };
}

async function fetchSectionKeysFromPlexServer(plex, descriptor) {
  if (!descriptor || !descriptor.device) {
    throw new Error('Unable to determine Plex server details from /api/resources.');
  }

  const machineIdentifier =
    descriptor.device?.clientIdentifier || descriptor.machineIdentifier || plex.serverIdentifier;

  if (!machineIdentifier) {
    throw new Error('Unable to determine Plex server machine identifier from /api/resources.');
  }

  const path = `/api/servers/${encodeURIComponent(String(machineIdentifier))}`;
  const url = buildPlexTvUrl(path, plex);

  let response;
  try {
    response = await fetch(url, { method: 'GET' });
  } catch (err) {
    throw new Error(`Failed to query Plex library sections from ${url}: ${err.message}`);
  }

  if (response.status === 401 || response.status === 403) {
    throw new Error('Plex rejected the provided token.');
  }

  if (!response.ok) {
    const statusText = response.statusText || 'Error';
    throw new Error(
      `Failed to query Plex library sections from ${url}: ${response.status} (${statusText})`
    );
  }

  const body = await response.text();
  const { sectionIds, keyToIdMap } = parseServerSectionsPayload(body);

  const normalizedSectionIds = Array.from(new Set(sectionIds.map((id) => String(id).trim()))).filter(
    Boolean
  );

  const fallbackSectionIds =
    normalizedSectionIds.length > 0
      ? normalizedSectionIds
      : Array.from(
          new Set(
            Object.values(keyToIdMap || {}).map((value) => String(value).trim()).filter(Boolean)
          )
        );

  if (!fallbackSectionIds.length) {
    throw new Error(
      'Plex did not return any library sections for the selected server; verify the server is reachable and published.'
    );
  }

  return {
    sectionIds: fallbackSectionIds,
    keyToIdMap: keyToIdMap || {},
  };
}

function resolveSectionSelectionId(rawValue, availableIdsSet, keyToIdMap = {}) {
  const parts = normalizeSectionKeyParts(rawValue);
  const candidates = [parts.raw, parts.sanitized, parts.numeric].filter(Boolean);

  for (const candidate of candidates) {
    if (availableIdsSet.has(candidate)) {
      return candidate;
    }

    const mapped = keyToIdMap[candidate];
    if (mapped !== undefined && mapped !== null) {
      const normalizedMapped = String(mapped).trim();
      if (!normalizedMapped) {
        continue;
      }

      if (availableIdsSet.has(normalizedMapped)) {
        return normalizedMapped;
      }

      const mappedParts = normalizeSectionKeyParts(normalizedMapped);
      if (mappedParts.raw && availableIdsSet.has(mappedParts.raw)) {
        return mappedParts.raw;
      }

      if (mappedParts.numeric && availableIdsSet.has(mappedParts.numeric)) {
        return mappedParts.numeric;
      }

      return normalizedMapped;
    }
  }

  return null;
}

async function resolveInvitedIdByEmail(plex, email) {
  const normalizedEmail = email ? String(email).trim() : '';
  if (!normalizedEmail) {
    return null;
  }

  const params = new URLSearchParams({ invitedEmail: normalizedEmail });
  const url = buildPlexTvUrl(`/api/home/users?${params.toString()}`, plex);

  let response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
  } catch (err) {
    throw new Error(
      `Failed to resolve Plex invitedId via /api/home/users: ${err.message}`
    );
  }

  if (response.status === 401 || response.status === 403) {
    throw new Error('Plex rejected the provided token.');
  }

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    const statusText = response.statusText || 'Error';
    const details = await extractErrorMessage(response);
    const suffix = details ? `: ${details}` : '';
    throw new Error(
      `Failed to resolve Plex invitedId via /api/home/users: ${response.status} (${statusText})${suffix}`
    );
  }

  const payload = await response.text();
  const invitedId = parseInvitedIdFromHomeUsersPayload(payload, normalizedEmail);
  if (invitedId) {
    return invitedId;
  }

  try {
    const { users } = await fetchUsersList(plex);
    const normalized = normalize(normalizedEmail);
    for (const user of coerceArray(users)) {
      if (!user || typeof user !== 'object') {
        continue;
      }

      const candidates = [user];
      if (user.account && typeof user.account === 'object') {
        candidates.push(user.account);
      }

      const hasMatch = candidates.some((entry) =>
        matchesEmail(entry, normalizedEmail) ||
        normalize(getCaseInsensitive(entry, 'email')) === normalized
      );

      if (!hasMatch) {
        continue;
      }

      for (const entry of candidates) {
        const id = extractIdFromCandidate(entry);
        if (id) {
          return id;
        }
      }

      const fallbackId = extractIdFromCandidate(user);
      if (fallbackId) {
        return fallbackId;
      }
    }
  } catch (err) {
    throw new Error(
      `Unable to determine Plex invitedId for ${normalizedEmail}: ${err.message}`
    );
  }

  return null;
}

function getCaseInsensitive(obj, key) {
  if (!obj || typeof obj !== 'object') {
    return undefined;
  }

  const target = String(key || '').toLowerCase();
  for (const entryKey of Object.keys(obj)) {
    if (String(entryKey || '').toLowerCase() === target) {
      return obj[entryKey];
    }
  }

  const attributes = obj.attributes || obj.$;
  if (attributes && typeof attributes === 'object') {
    return getCaseInsensitive(attributes, key);
  }

  return undefined;
}

function extractIdFromCandidate(candidate) {
  if (!candidate || typeof candidate !== 'object') {
    return null;
  }

  for (const key of HOME_USER_ID_KEYS) {
    const value = getCaseInsensitive(candidate, key);
    if (value !== undefined && value !== null) {
      const normalized = String(value).trim();
      if (normalized) {
        return normalized;
      }
    }
  }

  return null;
}

function collectHomeUserCandidates(node, accumulator, seen = new Set()) {
  if (!node || typeof node !== 'object' || seen.has(node)) {
    return;
  }

  seen.add(node);

  if (Array.isArray(node)) {
    node.forEach((entry) => collectHomeUserCandidates(entry, accumulator, seen));
    return;
  }

  const keys = Object.keys(node).map((entry) => String(entry || '').toLowerCase());
  const looksLikeUser = keys.some((entry) =>
    entry.includes('user') || entry.includes('account') || entry.includes('email')
  );

  if (looksLikeUser) {
    accumulator.add(node);
  }

  for (const value of Object.values(node)) {
    if (value && typeof value === 'object') {
      collectHomeUserCandidates(value, accumulator, seen);
    }
  }
}

function parseInvitedIdFromHomeUsersPayload(payload, email) {
  if (!payload) {
    return null;
  }

  const candidateSet = new Set();
  try {
    const data = JSON.parse(payload);
    collectHomeUserCandidates(data, candidateSet);
  } catch (err) {
    // Ignore JSON parsing errors and fall back to regex/XML parsing below.
  }

  const candidates = Array.from(candidateSet);
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') {
      continue;
    }

    const relatedCandidates = [candidate];
    const account = getCaseInsensitive(candidate, 'account');
    if (account && typeof account === 'object') {
      relatedCandidates.push(account);
    }
    const user = getCaseInsensitive(candidate, 'user');
    if (user && typeof user === 'object') {
      relatedCandidates.push(user);
    }

    const matches = relatedCandidates.some((entry) => matchesEmail(entry, email));
    const invitedEmailCandidate = getCaseInsensitive(candidate, 'invitedEmail');
    const invitedEmailMatch =
      invitedEmailCandidate && normalize(invitedEmailCandidate) === normalize(email);

    if (!matches && !invitedEmailMatch) {
      continue;
    }

    for (const entry of relatedCandidates) {
      const id = extractIdFromCandidate(entry);
      if (id) {
        return id;
      }
    }

    const fallbackId = extractIdFromCandidate(candidate);
    if (fallbackId) {
      return fallbackId;
    }
  }

  const jsonRegexes = [
    /"invited(?:Id|_id)"\s*:\s*"([^"]+)"/i,
    /"invited(?:Id|_id)"\s*:\s*([\w:-]+)/i,
  ];

  for (const regex of jsonRegexes) {
    const match = regex.exec(payload);
    if (match && match[1]) {
      const normalized = String(match[1]).trim();
      if (normalized) {
        return normalized;
      }
    }
  }

  const pattern = /<(?:User|HomeUser)\b[^>]*>/gi;
  let match;
  while ((match = pattern.exec(payload))) {
    const tag = match[0];
    const attributes = {};
    tag.replace(/([\w:-]+)="([^"]*)"/g, (_, attribute, value) => {
      attributes[String(attribute || '').toLowerCase()] = value;
      return '';
    });

    const emails = HOME_USER_EMAIL_KEYS.map((key) => attributes[key]).filter(Boolean);
    const emailMatch =
      emails.some((entry) => normalize(entry) === normalize(email)) ||
      normalize(attributes.email) === normalize(email);

    if (!emailMatch) {
      continue;
    }

    for (const key of HOME_USER_ID_KEYS) {
      const value = attributes[key];
      if (value !== undefined && value !== null) {
        const normalized = String(value).trim();
        if (normalized) {
          return normalized;
        }
      }
    }
  }

  return null;
}

async function fetchLibrarySections(plex) {
  let response;
  try {
    response = await fetch(buildUrlFromConfig(LIBRARY_SECTIONS_ENDPOINT, plex), {
      headers: { Accept: 'application/json' },
    });
  } catch (err) {
    throw new Error(`Failed to connect to Plex library API: ${err.message}`);
  }

  if (response.status === 401 || response.status === 403) {
    throw new Error('Plex rejected the provided token.');
  }

  if (!response.ok) {
    const details = await extractErrorMessage(response);
    const statusText = response.statusText || 'Error';
    const suffix = details ? `: ${details}` : '';
    throw new Error(
      `Failed to load Plex library sections: ${response.status} (${statusText})${suffix}`
    );
  }

  const body = await response.text();
  return parseLibrarySectionsPayload(body);
}

async function fetchUsersList(plex) {
  const cacheKey = getCacheKey(plex);
  const preferredPath = cacheKey ? userListPathCache.get(cacheKey) : null;
  const endpoints = preferredPath
    ? [
        preferredPath,
        ...USER_LIST_ENDPOINTS.filter((path) => path !== preferredPath),
      ]
    : USER_LIST_ENDPOINTS;

  const attemptedNotFound = [];

  for (const basePath of endpoints) {
    let response;
    try {
      response = await fetch(buildUrlFromConfig(basePath, plex), {
        headers: {
          Accept: 'application/json',
        },
      });
    } catch (err) {
      throw new Error(`Unable to connect to Plex server: ${err.message}`);
    }

    if (response.status === 401 || response.status === 403) {
      throw new Error('Plex rejected the provided token.');
    }

    if (response.status === 404) {
      if (!attemptedNotFound.includes(basePath)) {
        attemptedNotFound.push(basePath);
      }
      if (preferredPath === basePath && cacheKey) {
        userListPathCache.delete(cacheKey);
      }
      continue;
    }

    if (!response.ok) {
      const details = await extractErrorMessage(response);
      const statusText = response.statusText || 'Error';
      const suffix = details ? `: ${details}` : '';
      throw new Error(
        `Plex returned ${response.status} (${statusText}) for ${basePath}${suffix}`
      );
    }

    const data = await response.json().catch(() => ({}));
    const users = normalizeUserPayload(data);

    if (cacheKey) {
      userListPathCache.set(cacheKey, basePath);
    }

    return { users, basePath };
  }

  if (attemptedNotFound.length > 0) {
    const formattedPaths =
      attemptedNotFound.length === 1
        ? attemptedNotFound[0]
        : `${attemptedNotFound
            .slice(0, -1)
            .join(', ')} and ${attemptedNotFound[attemptedNotFound.length - 1]}`;
    throw new Error(
      `Plex returned 404 (Not Found) for the supported user list endpoints (${formattedPaths}). Confirm the base URL is correct and that the server supports the Plex accounts or home users API.`
    );
  }

  throw new Error('Unable to determine the Plex home users endpoint.');
}

async function listUsers() {
  if (!isConfigured()) {
    throw new Error('Plex integration is not configured');
  }

  const plex = getPlexConfig();

  try {
    const { users } = await fetchUsersList(plex);
    return coerceArray(users).filter((user) => user && typeof user === 'object');
  } catch (err) {
    throw new Error(`Failed to fetch Plex users: ${err.message}`);
  }
}

async function listSharedServerMembers(overrideSettings) {
  const plex = getPlexConfig(overrideSettings);
  ensureBaseConfiguration(plex);

  const headers = buildSharedServerHeaders(plex, {
    Accept: 'application/json',
  });

  let v2Result;
  try {
    v2Result = await fetchSharedServerMembersV2(plex, headers);
  } catch (err) {
    throw new Error(`Failed to fetch Plex shared members: ${err.message}`);
  }

  if (v2Result.notFound) {
    try {
      return await fetchSharedServerMembersLegacy(plex, headers);
    } catch (err) {
      throw new Error(`Failed to fetch Plex shared members: ${err.message}`);
    }
  }

  if (Array.isArray(v2Result.members)) {
    return v2Result.members;
  }

  return [];
}

async function revokeUserByEmail(email) {
  return revokeUser({ email });
}

function normalize(value) {
  if (value == null) {
    return '';
  }
  return String(value).trim().toLowerCase();
}

function matchesAccountId(user, accountId) {
  const normalized = normalize(accountId);
  if (!normalized) {
    return false;
  }
  const candidates = [
    user.id,
    user.uuid,
    user.userID,
    user.machineIdentifier,
    user.account && user.account.id,
  ];
  return candidates.some((candidate) => normalize(candidate) === normalized);
}

function matchesEmail(user, email) {
  const normalized = normalize(email);
  if (!normalized) {
    return false;
  }
  const candidates = [user.email, user.username, user.title, user.account && user.account.email];
  return candidates.some((candidate) => normalize(candidate) === normalized);
}

async function revokeUser({ plexAccountId, email }) {
  if (!isConfigured()) {
    return { skipped: true, reason: 'Plex integration disabled' };
  }

  const plex = getPlexConfig();
  let listResult;
  try {
    listResult = await fetchUsersList(plex);
  } catch (err) {
    throw new Error(`Failed to fetch Plex users: ${err.message}`);
  }
  const users = listResult.users;
  let target = null;

  if (plexAccountId) {
    target = users.find((user) => matchesAccountId(user, plexAccountId));
  }

  if (!target && email) {
    target = users.find((user) => matchesEmail(user, email));
  }

  if (!target) {
    return { success: false, reason: 'User not found on Plex server' };
  }

  const userId = target.id || target.uuid || target.userID;
  if (!userId) {
    return { success: false, reason: 'Unable to determine Plex user id' };
  }

  const response = await fetch(
    buildUrlFromConfig(`${listResult.basePath}/${userId}`, plex),
    {
      method: 'DELETE',
      headers: {
        Accept: 'application/json',
      },
    }
  );

  if (response.status === 404) {
    return { success: false, reason: 'User not found on Plex server' };
  }

  if (!response.ok) {
    const details = await extractErrorMessage(response);
    const statusText = response.statusText || 'Error';
    const suffix = details ? `: ${details}` : '';
    throw new Error(
      `Failed to revoke Plex user: Plex returned ${response.status} (${statusText})${suffix}`
    );
  }

  return { success: true, user: target };
}

async function createInvite(
  { email, friendlyName, librarySectionIds, invitedId } = {},
  overrideSettings
) {
  const plex = getPlexConfig(overrideSettings);
  ensureBaseConfiguration(plex);

  plex.serverIdentifier = await getOrResolveServerIdentifier(plex);
  ensureInviteConfiguration(plex);

  const normalizedEmail = email ? String(email).trim() : '';
  if (!normalizedEmail) {
    throw new Error('Recipient email is required to create Plex invites');
  }

  const descriptor = await resolveServerDescriptor(plex);
  const machineIdentifierCandidates = [];
  for (const candidate of [
    descriptor.device?.clientIdentifier,
    descriptor.device?.machineIdentifier,
    descriptor.machineIdentifier,
    plex.serverIdentifier,
  ]) {
    const normalizedCandidate =
      candidate === undefined || candidate === null ? '' : String(candidate).trim();
    if (!normalizedCandidate) {
      continue;
    }
    if (!machineIdentifierCandidates.includes(normalizedCandidate)) {
      machineIdentifierCandidates.push(normalizedCandidate);
    }
  }

  const machineIdentifier = machineIdentifierCandidates[0];

  if (!machineIdentifier) {
    throw new Error('Unable to determine Plex machine identifier for invites');
  }

  const requestedSections = parseLibrarySectionIds(
    librarySectionIds !== undefined ? librarySectionIds : plex.librarySectionIds
  ).map((id) => String(id));

  const { sectionIds: availableSectionIds, keyToIdMap } = await fetchSectionKeysFromPlexServer(
    plex,
    descriptor
  );

  const normalizedAvailableSectionIds = Array.from(
    new Set(availableSectionIds.map((id) => String(id).trim()))
  ).filter(Boolean);
  const availableSectionIdsSet = new Set(normalizedAvailableSectionIds);

  const translatedRequestedSections = requestedSections
    .map((id) => {
      const normalized = id === undefined || id === null ? '' : String(id).trim();
      if (!normalized) {
        return null;
      }

      const resolved =
        resolveSectionSelectionId(normalized, availableSectionIdsSet, keyToIdMap) || normalized;
      const normalizedResolved = String(resolved).trim();

      return normalizedResolved || null;
    })
    .filter(Boolean);

  const resolvedRequestedSections = Array.from(
    new Set(
      translatedRequestedSections.filter((id) => availableSectionIdsSet.has(id))
    )
  );

  const fallbackSectionIds =
    normalizedAvailableSectionIds.length > 0
      ? normalizedAvailableSectionIds
      : Array.from(
          new Set(
            Object.values(keyToIdMap || {}).map((value) => String(value).trim()).filter(Boolean)
          )
        );

  const hasRequestedSections = requestedSections.length > 0;
  const finalSectionIds = hasRequestedSections
    ? resolvedRequestedSections
    : fallbackSectionIds;

  const availableForMessage =
    normalizedAvailableSectionIds.length > 0
      ? normalizedAvailableSectionIds
      : fallbackSectionIds;

  if (!finalSectionIds.length) {
    throw new Error(
      `None of the requested librarySectionIds exist on the Plex server. Requested=${JSON.stringify(
        requestedSections
      )} Available=${JSON.stringify(availableForMessage)}`
    );
  }

  // Plex expects form-encoded data, NOT JSON!
  const sharedHeaders = buildSharedServerHeaders(plex, {
    'Content-Type': 'application/x-www-form-urlencoded',
  });

  const normalizedFriendlyName = friendlyName ? String(friendlyName).trim() : '';

  let resolvedInvitedId = invitedId === undefined || invitedId === null
    ? ''
    : String(invitedId).trim();
  if (!resolvedInvitedId) {
    resolvedInvitedId = await resolveInvitedIdByEmail(plex, normalizedEmail);
  }

  // Use Plex Web's private API endpoint (the one that actually works)
  const serverId = await resolveServerId(plex);
  const sharedServersUrl = `https://plex.tv/api/v2/shared_servers?X-Plex-Token=${plex.token}`;

  // Build form-encoded body with FLAT fields (not nested JSON)
  const formData = new URLSearchParams();
  formData.append('machineIdentifier', serverId);
  formData.append('invitedEmail', normalizedEmail);

  // Add libraries as array format: libraries[0][library_id], libraries[0][allow_sync], etc.
  finalSectionIds.forEach((libraryId, index) => {
    formData.append(`libraries[${index}][library_id]`, parseInt(libraryId, 10));
    formData.append(`libraries[${index}][allow_sync]`, plex?.allowSync === true || plex?.allowSync === '1' ? '1' : '0');
  });

  formData.append('allow_channels', plex?.allowChannels === true || plex?.allowChannels === '1' ? '1' : '0');
  formData.append('allow_camera_upload', plex?.allowCameraUpload === true || plex?.allowCameraUpload === '1' ? '1' : '0');
  formData.append('allow_tuners', '0');

  // Log the form data for debugging
  logger.info('Creating Plex invite - Form Data:', {
    url: sharedServersUrl,
    body: formData.toString()
  });

  let response;
  try {
    response = await fetch(sharedServersUrl, {
      method: 'POST',
      headers: sharedHeaders,
      body: formData.toString(),
    });
  } catch (err) {
    throw new Error(`Failed to connect to Plex invite API: ${err.message}`);
  }

  if (response.status === 401 || response.status === 403) {
    const details = await extractErrorMessage(response);
    const suffix = details ? ` Details: ${details}` : '';
    throw new Error(`Plex rejected the provided token.${suffix}`);
  }

  if (!response.ok) {
    const bodyText = await response.text().catch(() => '');
    const statusText = response.statusText || 'Error';
    const suffix = bodyText ? `: ${bodyText}` : '';

    // Log the full error for debugging
    logger.error('Plex invite creation failed', {
      status: response.status,
      statusText,
      body: bodyText,
      requestBody: {
        machineIdentifier: requestBody.machineIdentifier,
        invitedEmail: requestBody.invitedEmail,
        libraryCount: requestBody.shared_server.libraries.length,
      },
    });

    // Provide helpful error messages for common scenarios
    if (response.status === 404) {
      throw new Error(
        'Unable to create Plex invite. This typically happens when: (1) the user is the server owner, ' +
        '(2) the email is linked to the server owner account (including email aliases like user+test@gmail.com), ' +
        'or (3) the server configuration is invalid. ' +
        'For testing, you must use a completely separate Plex account with a different email. ' +
        `Technical details: ${response.status} (${statusText})${suffix}`
      );
    }

    throw new Error(
      `Plex invite creation failed with ${response.status} (${statusText})${suffix}`
    );
  }

  if (response.status === 401 || response.status === 403) {
    const details = await extractErrorMessage(response);
    const suffix = details ? `: ${details}` : '';
    throw new Error(`Plex rejected the provided token${suffix}`);
  }

  if (!response.ok) {
    const details = await extractErrorMessage(response);
    const statusText = response.statusText || 'Error';
    const suffix = details ? `: ${details}` : '';
    throw new Error(
      `Plex invite creation failed with ${response.status} (${statusText})${suffix}`
    );
  }

  let data = {};
  try {
    data = await response.json();
  } catch (err) {
    data = {};
  }

  const mapped = mapInviteResponse(data);

  if (!mapped.inviteId && !mapped.inviteUrl) {
    throw new Error('Plex did not return an invite identifier');
  }

  return mapped;
}

async function cancelInvite(inviteId, overrideSettings) {
  if (!inviteId) {
    throw new Error('Invite id is required to cancel Plex invites');
  }

  const plex = getPlexConfig(overrideSettings);
  ensureBaseConfiguration(plex);

  plex.serverIdentifier = await getOrResolveServerIdentifier(plex);
  ensureInviteConfiguration(plex);

  const descriptor = await resolveServerDescriptor(plex);
  if (!descriptor.legacyNumericId) {
    throw new Error(
      'Plex did not return a legacy numeric server id; cancelling invites is not supported via this token.'
    );
  }

  let response;
  try {
    const sharedServerUrl = await buildSharedServerUrl(plex, inviteId);
    response = await fetch(sharedServerUrl, {
      method: 'DELETE',
      headers: buildSharedServerHeaders(plex),
    });
  } catch (err) {
    throw new Error(`Failed to connect to Plex invite API: ${err.message}`);
  }

  if (response.status === 401 || response.status === 403) {
    throw new Error('Plex rejected the provided token.');
  }

  if (response.status === 404 || response.status === 410) {
    return { success: false, reason: 'Invite not found on Plex server' };
  }

  if (!response.ok) {
    const details = await extractErrorMessage(response);
    const statusText = response.statusText || 'Error';
    const suffix = details ? `: ${details}` : '';
    throw new Error(
      `Plex invite cancellation failed with ${response.status} (${statusText})${suffix}`
    );
  }

  return { success: true };
}

async function verifyConnection(overrideSettings) {
  const plex = getPlexConfig(overrideSettings);
  ensureBaseConfiguration(plex);

  plex.serverIdentifier = await getOrResolveServerIdentifier(plex);
  ensureInviteConfiguration(plex);

  const sections = parseLibrarySectionIds(plex.librarySectionIds);

  let inviteEndpointAvailable = true;
  let inviteEndpointVersion = 'legacy';
  let descriptor;

  try {
    descriptor = await resolveServerDescriptor(plex);
  } catch (err) {
    throw new Error(`Failed to verify Plex invite configuration: ${err.message}`);
  }

  if (descriptor.legacyNumericId) {
    inviteEndpointVersion = 'legacy';

    let response;
    try {
      const sharedServerUrl = await buildSharedServerUrl(plex);
      response = await fetch(sharedServerUrl, {
        method: 'GET',
        headers: buildSharedServerHeaders(plex),
      });
    } catch (err) {
      throw new Error(`Failed to connect to Plex invite API: ${err.message}`);
    }

    if (response.status === 401 || response.status === 403) {
      throw new Error('Plex rejected the provided token.');
    }

    if (response.status === 404 || response.status === 410) {
      inviteEndpointAvailable = false;
    } else if (!response.ok) {
      const details = await extractErrorMessage(response);
      const statusText = response.statusText || 'Error';
      const suffix = details ? `: ${details}` : '';
      throw new Error(
        `Failed to verify Plex invite configuration: ${response.status} (${statusText})${suffix}`
      );
    }
  } else {
    inviteEndpointVersion = 'v2';
    inviteEndpointAvailable = true;
  }

  const { sectionIds: availableSectionIds, keyToIdMap } = await fetchSectionKeysFromPlexServer(
    plex,
    descriptor
  );
  const normalizedAvailableSectionIds = Array.from(
    new Set(availableSectionIds.map((id) => String(id).trim()))
  ).filter(Boolean);
  const fallbackAvailableSectionIds =
    normalizedAvailableSectionIds.length > 0
      ? normalizedAvailableSectionIds
      : Array.from(
          new Set(
            Object.values(keyToIdMap || {}).map((value) => String(value).trim()).filter(Boolean)
          )
        );
  const availableSectionIdsSet = new Set(fallbackAvailableSectionIds);

  const migratedConfiguredSections = sections
    .map((id) => {
      const normalized = id === undefined || id === null ? '' : String(id).trim();
      if (!normalized) {
        return null;
      }
      return (
        resolveSectionSelectionId(normalized, availableSectionIdsSet, keyToIdMap) || normalized
      );
    })
    .filter(Boolean);

  const libraries = await fetchLibrarySections(plex);
  if (!libraries.length) {
    throw new Error(
      'No Plex libraries were found. Confirm the token has access to your server.'
    );
  }

  const remappedLibraries = [];
  const seenLibraryIds = new Set();
  libraries.forEach((library) => {
    if (!library || typeof library !== 'object') {
      return;
    }

    const rawId = library.id === undefined || library.id === null ? '' : String(library.id).trim();
    const resolvedId =
      resolveSectionSelectionId(rawId, availableSectionIdsSet, keyToIdMap) || rawId;
    const normalizedId = resolvedId ? String(resolvedId).trim() : '';

    if (!normalizedId) {
      return;
    }

    if (seenLibraryIds.has(normalizedId)) {
      return;
    }

    seenLibraryIds.add(normalizedId);
    remappedLibraries.push({ ...library, id: normalizedId });
  });

  return {
    message: 'Plex invite configuration verified successfully.',
    details: {
      serverIdentifier: plex.serverIdentifier,
      librarySectionIds: migratedConfiguredSections,
      inviteEndpointAvailable,
      inviteEndpointVersion,
    },
    libraries: remappedLibraries,
  };
}

async function authenticateAccount({ email, password } = {}, overrideSettings) {
  const normalizedEmail = email ? String(email).trim() : '';
  if (!normalizedEmail) {
    throw new Error('Email is required to authenticate Plex account');
  }

  const normalizedPassword = password ? String(password) : '';
  if (!normalizedPassword) {
    throw new Error('Password is required to authenticate Plex account');
  }

  const plex = getPlexConfig(overrideSettings);
  const headers = buildPlexClientHeaders(getClientIdentifier(plex), {
    Authorization: `Basic ${Buffer.from(
      `${normalizedEmail}:${normalizedPassword}`,
      'utf8'
    ).toString('base64')}`,
  });
  delete headers['Content-Type'];

  let response;
  try {
    response = await fetch('https://plex.tv/users/sign_in.json', {
      method: 'POST',
      headers,
    });
  } catch (err) {
    throw new Error(`Failed to authenticate Plex account: ${err.message}`);
  }

  if (response.status === 401 || response.status === 403) {
    throw new Error('Plex rejected the provided email or password.');
  }

  if (!response.ok) {
    const bodyText = await response.text().catch(() => '');
    const statusText = response.statusText || 'Error';
    const suffix = bodyText ? `: ${bodyText}` : '';
    throw new Error(
      `Plex authentication failed with ${response.status} (${statusText})${suffix}`
    );
  }

  let data = {};
  try {
    data = await response.json();
  } catch (err) {
    data = {};
  }

  const user = data && typeof data === 'object' ? data.user || data : {};
  const invitedIdCandidate =
    getCaseInsensitive(user, 'invitedId') ||
    getCaseInsensitive(user, 'id') ||
    getCaseInsensitive(user, 'uuid') ||
    getCaseInsensitive(user, 'userID') ||
    null;

  if (!invitedIdCandidate) {
    throw new Error('Plex did not return an account identifier.');
  }

  const resolvedEmail =
    getCaseInsensitive(user, 'email') ||
    getCaseInsensitive(user, 'username') ||
    normalizedEmail;

  const authToken =
    getCaseInsensitive(user, 'authToken') ||
    getCaseInsensitive(data, 'authToken') ||
    getCaseInsensitive(data, 'auth_token') ||
    null;

  return {
    invitedId: String(invitedIdCandidate).trim(),
    email: resolvedEmail ? String(resolvedEmail).trim() : normalizedEmail,
    authToken: authToken ? String(authToken).trim() : null,
  };
}

module.exports = {
  getPlexConfig,
  isConfigured,
  createInvite,
  cancelInvite,
  authenticateAccount,
  listUsers,
  listSharedServerMembers,
  revokeUser,
  revokeUserByEmail,
  verifyConnection,
  getOrResolveServerIdentifier,
};

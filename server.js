const express = require('express');
const path = require('path');
const fs = require('fs').promises;
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3100;
const SUB2API_BASE_URL = (process.env.SUB2API_BASE_URL || 'http://localhost:8080').replace(/\/+$/, '');

const DATA_FILE = path.join(__dirname, 'data', 'extension_settings.json');
const ENCRYPTION_KEY = Buffer.from((process.env.EXT_SECRET || 'sub2api_ext_settings_secret_key_1').padEnd(32, '0')).slice(0, 32);

// Admin credentials for proxying admin-only API calls (e.g. OAuth)
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

// Cached admin token
let adminTokenCache = { token: null, expiresAt: 0 };

app.use(express.json());

// Ensure data file exists
(async function ensureDataFile() {
  const dir = path.dirname(DATA_FILE);
  try { await fs.mkdir(dir, { recursive: true }); } catch (e) {}
  try { await fs.access(DATA_FILE); } catch (e) {
    await fs.writeFile(DATA_FILE, '{}', 'utf8');
  }
})();

function encryptData(text) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}

function decryptData(text) {
  const textParts = text.split(':');
  const iv = Buffer.from(textParts.shift(), 'hex');
  const encryptedText = Buffer.from(textParts.join(':'), 'hex');
  const decipher = crypto.createDecipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
  let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

// Allow iframe embedding and cross-origin access
app.use((req, res, next) => {
  // Remove any restrictive iframe headers
  res.removeHeader('X-Frame-Options');
  // Allow embedding from any origin
  res.setHeader('Content-Security-Policy', "frame-ancestors *");
  // CORS for cross-origin iframe
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// ──────────────────────────────────────────────
// Helper: proxy request to Sub2API
// ──────────────────────────────────────────────

function extractToken(req) {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) return auth.slice(7);
  return null;
}

async function sub2apiRequest(method, apiPath, token, body) {
  const url = `${SUB2API_BASE_URL}${apiPath}`;
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const opts = { method, headers };
  if (body && (method === 'POST' || method === 'PUT')) {
    opts.body = JSON.stringify(body);
  }

  const resp = await fetch(url, opts);
  const data = await resp.json();
  return { status: resp.status, data };
}

/**
 * Get a valid admin token for proxying admin-only API calls.
 * Automatically logs in with ADMIN_EMAIL / ADMIN_PASSWORD and caches the token.
 */
async function getAdminToken() {
  // Return cached token if still valid (with 60s safety margin)
  if (adminTokenCache.token && adminTokenCache.expiresAt > Date.now() + 60_000) {
    return adminTokenCache.token;
  }

  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
    throw new Error('ADMIN_EMAIL and ADMIN_PASSWORD environment variables are required for OAuth proxy');
  }

  const result = await sub2apiRequest('POST', '/api/v1/auth/login', null, {
    email: ADMIN_EMAIL,
    password: ADMIN_PASSWORD,
  });

  // Sub2API response: { code, message, data: { access_token, refresh_token, ... } }
  const token = result.data?.data?.access_token || result.data?.access_token;

  if (result.status !== 200 || !token) {
    throw new Error(`Admin login failed: ${result.data.error || result.data.message || JSON.stringify(result.data)}`);
  }

  // Decode expiration from JWT
  const payload = decodeJwtPayload(token);
  const expiresAt = payload && payload.exp ? payload.exp * 1000 : Date.now() + 3600_000;

  adminTokenCache = { token, expiresAt };
  console.log('Admin token obtained / refreshed successfully');
  return token;
}

/**
 * Verify the incoming request has a valid user JWT.
 * Returns the decoded payload, or null if invalid.
 */
function verifyUserToken(req) {
  const token = extractToken(req);
  if (!token) return null;
  return decodeJwtPayload(token);
}

// ──────────────────────────────────────────────
// API: Verify user identity
// Decode JWT directly to avoid Sub2API admin-only
// /api/v1/auth/me restrictions
// ──────────────────────────────────────────────

function decodeJwtPayload(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    // Check expiration
    if (payload.exp && payload.exp * 1000 < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

app.get('/api/auth/me', async (req, res) => {
  try {
    const token = extractToken(req);
    if (!token) return res.status(401).json({ error: 'No token provided' });

    // First try to decode JWT directly (works for all users)
    const jwtPayload = decodeJwtPayload(token);
    if (jwtPayload) {
      const user = {
        id: jwtPayload.user_id || jwtPayload.sub || jwtPayload.id,
        username: jwtPayload.username || jwtPayload.name || jwtPayload.email || 'user',
        email: jwtPayload.email || '',
        role: jwtPayload.role || 'user',
      };
      if (user.id) return res.json(user);
    }

    // Fallback: proxy to Sub2API (may fail for non-admin)
    const result = await sub2apiRequest('GET', '/api/v1/auth/me', token);
    if (result.status === 200) {
      return res.json(result.data);
    }

    // If Sub2API returns 403 but JWT was valid, use JWT data
    if (result.status === 403 && jwtPayload) {
      return res.json({
        id: jwtPayload.user_id || jwtPayload.sub || jwtPayload.id || 'unknown',
        username: jwtPayload.username || jwtPayload.name || jwtPayload.email || 'user',
        email: jwtPayload.email || '',
        role: jwtPayload.role || 'user',
      });
    }

    res.status(result.status).json(result.data);
  } catch (err) {
    console.error('Auth/me error:', err.message);
    // Last resort: try JWT decode even on network error
    const token = extractToken(req);
    if (token) {
      const jwtPayload = decodeJwtPayload(token);
      if (jwtPayload) {
        return res.json({
          id: jwtPayload.user_id || jwtPayload.sub || jwtPayload.id || 'unknown',
          username: jwtPayload.username || jwtPayload.name || jwtPayload.email || 'user',
          email: jwtPayload.email || '',
          role: jwtPayload.role || 'user',
        });
      }
    }
    res.status(502).json({
      error: `无法连接到 Sub2API 后端 (${SUB2API_BASE_URL})`,
      detail: err.message
    });
  }
});

// ──────────────────────────────────────────────
// API: Login (proxy to /auth/login)
// ──────────────────────────────────────────────

app.post('/api/v1/auth/login', async (req, res) => {
  try {
    const result = await sub2apiRequest('POST', '/api/v1/auth/login', null, req.body);
    res.status(result.status).json(result.data);
  } catch (err) {
    console.error('Login proxy error:', err.message);
    res.status(502).json({
      error: `无法连接到 Sub2API 后端 (${SUB2API_BASE_URL})`,
      detail: err.message
    });
  }
});

// ──────────────────────────────────────────────
// Helper: Resolve user email to group ID
// ──────────────────────────────────────────────

async function resolveUserGroupId(userEmail, adminToken) {
  if (!userEmail) return null;
  const groupsResult = await sub2apiRequest('GET', '/api/v1/admin/groups/all', adminToken);
  if (groupsResult.status !== 200) return null;
  const allGroups = Array.isArray(groupsResult.data)
    ? groupsResult.data
    : (groupsResult.data?.items || groupsResult.data?.data || []);
  const userGroup = allGroups.find(g => g.status === 'active' && g.name === userEmail);
  return userGroup ? userGroup.id : null;
}

// ──────────────────────────────────────────────
// API: List accounts (filtered by user group)
// ──────────────────────────────────────────────

app.get('/api/accounts', async (req, res) => {
  try {
    const token = extractToken(req);
    if (!token) return res.status(401).json({ error: 'No token provided' });

    // Security: always extract user identity from JWT
    const jwtPayload = decodeJwtPayload(token);
    if (!jwtPayload) return res.status(401).json({ error: 'Invalid or expired token' });
    const userId = jwtPayload.user_id || jwtPayload.sub || jwtPayload.id;
    if (!userId) return res.status(401).json({ error: 'Unable to determine user identity from token' });
    const userEmail = jwtPayload.email || '';

    const searchQuery = req.query.search || '';
    const page = parseInt(req.query.page) || 1;
    const pageSize = parseInt(req.query.page_size) || 20;

    const adminToken = await getAdminToken();

    // Find the group matching the user's email
    const userGroupId = await resolveUserGroupId(userEmail, adminToken);
    if (!userGroupId) {
      return res.json({ items: [], total: 0, page, page_size: pageSize, pages: 1 });
    }

    // Fetch accounts filtered by group (server-side filtering + pagination)
    const queryParams = new URLSearchParams({
      page: String(page),
      page_size: String(pageSize),
      group: String(userGroupId),
    });
    if (searchQuery) queryParams.set('search', searchQuery);

    const result = await sub2apiRequest(
      'GET',
      `/api/v1/admin/accounts?${queryParams.toString()}`,
      adminToken
    );

    if (result.status !== 200) {
      return res.status(result.status).json(result.data);
    }

    const responseData = result.data;
    const items = responseData.items || responseData.data?.items || [];
    const total = responseData.total || responseData.data?.total || 0;
    const pages = responseData.pages || responseData.data?.pages || 1;

    res.json({ items, total, page, page_size: pageSize, pages });
  } catch (err) {
    console.error('List accounts error:', err.message);
    res.status(502).json({ error: 'Failed to connect to Sub2API' });
  }
});

// ──────────────────────────────────────────────
// API: Create account
// ──────────────────────────────────────────────

app.post('/api/accounts', async (req, res) => {
  try {
    const token = extractToken(req);
    if (!token) return res.status(401).json({ error: 'No token provided' });

    // Security: always extract identity from JWT, ignore frontend-provided values
    const jwtPayload = decodeJwtPayload(token);
    if (!jwtPayload) return res.status(401).json({ error: 'Invalid or expired token' });
    const username = jwtPayload.name || jwtPayload.username || jwtPayload.email || '';

    // Strip user_id/username from body, keep only account data
    const { user_id: _uid, username: _uname, ...accountData } = req.body;

    // Prefix name with username
    const namePrefix = username ? `${username}-` : '';
    accountData.name = `${namePrefix}${accountData.name || 'unnamed'}`;

    // Use admin token to proxy account creation (admin-only endpoint)
    const adminToken = await getAdminToken();
    const result = await sub2apiRequest('POST', '/api/v1/admin/accounts', adminToken, accountData);
    res.status(result.status).json(result.data);
  } catch (err) {
    console.error('Create account error:', err.message);
    res.status(502).json({ error: 'Failed to connect to Sub2API' });
  }
});

// ──────────────────────────────────────────────
// API: Delete account (verify ownership via group)
// ──────────────────────────────────────────────

app.delete('/api/accounts/:id', async (req, res) => {
  try {
    const token = extractToken(req);
    if (!token) return res.status(401).json({ error: 'No token provided' });

    // Security: extract identity from JWT
    const jwtPayload = decodeJwtPayload(token);
    if (!jwtPayload) return res.status(401).json({ error: 'Invalid or expired token' });
    const userEmail = jwtPayload.email || '';

    const accountId = req.params.id;
    const adminToken = await getAdminToken();

    // Resolve user's group
    const userGroupId = await resolveUserGroupId(userEmail, adminToken);
    if (!userGroupId) {
      return res.status(403).json({ error: '未找到您的分组，无法执行删除' });
    }

    // Verify the account belongs to the user's group
    const getResult = await sub2apiRequest('GET', `/api/v1/admin/accounts/${accountId}`, adminToken);
    if (getResult.status !== 200) {
      return res.status(getResult.status).json(getResult.data);
    }

    const account = getResult.data?.data || getResult.data;
    const accountGroupIds = (account.group_ids || (account.groups || []).map(g => g.id)).map(String);
    if (!accountGroupIds.includes(String(userGroupId))) {
      return res.status(403).json({ error: '您只能删除自己分组下的账号' });
    }

    // Delete from Sub2API
    const result = await sub2apiRequest('DELETE', `/api/v1/admin/accounts/${accountId}`, adminToken);
    res.status(result.status).json(result.data);
  } catch (err) {
    console.error('Delete account error:', err.message);
    res.status(502).json({ error: 'Failed to connect to Sub2API' });
  }
});

// ──────────────────────────────────────────────
// API: Export accounts (batch fetch with credentials for CPA format)
// ──────────────────────────────────────────────

app.post('/api/accounts/export', async (req, res) => {
  try {
    const token = extractToken(req);
    if (!token) return res.status(401).json({ error: 'No token provided' });

    // Security: extract identity from JWT
    const jwtPayload = decodeJwtPayload(token);
    if (!jwtPayload) return res.status(401).json({ error: 'Invalid or expired token' });
    const userEmail = jwtPayload.email || '';

    const { account_ids } = req.body;
    if (!Array.isArray(account_ids) || account_ids.length === 0) {
      return res.status(400).json({ error: 'account_ids is required and must be a non-empty array' });
    }

    const adminToken = await getAdminToken();

    // Resolve user's group for ownership verification
    const userGroupId = await resolveUserGroupId(userEmail, adminToken);
    if (!userGroupId) {
      return res.status(403).json({ error: '未找到您的分组，无法导出' });
    }

    // Fetch each account detail and verify ownership
    const exportAccounts = [];
    for (const id of account_ids) {
      try {
        const getResult = await sub2apiRequest('GET', `/api/v1/admin/accounts/${id}`, adminToken);
        if (getResult.status !== 200) continue;

        const account = getResult.data?.data || getResult.data;
        const accountGroupIds = (account.group_ids || (account.groups || []).map(g => g.id)).map(String);
        // Only export accounts belonging to the user's group
        if (!accountGroupIds.includes(String(userGroupId))) continue;

        exportAccounts.push({
          name: account.name || '',
          platform: account.platform || '',
          type: account.type || '',
          credentials: account.credentials || {},
          concurrency: account.concurrency ?? 3,
          priority: account.priority ?? 50,
        });
      } catch (e) {
        console.error(`Export: failed to fetch account ${id}:`, e.message);
      }
    }

    res.json({ accounts: exportAccounts, total: exportAccounts.length });
  } catch (err) {
    console.error('Export accounts error:', err.message);
    res.status(502).json({ error: 'Failed to connect to Sub2API' });
  }
});

// ──────────────────────────────────────────────
// API: Get Batch Today Stats
// ──────────────────────────────────────────────

app.post('/api/accounts/today-stats/batch', async (req, res) => {
  try {
    const token = extractToken(req);
    if (!token) return res.status(401).json({ error: 'No token provided' });
    const adminToken = await getAdminToken();
    const result = await sub2apiRequest('POST', '/api/v1/admin/accounts/today-stats/batch', adminToken, req.body);
    res.status(result.status).json(result.data);
  } catch (err) {
    console.error('Batch today stats error:', err.message);
    res.status(502).json({ error: 'Failed to connect to Sub2API' });
  }
});

// ──────────────────────────────────────────────
// API: Get Account Usage Info
// ──────────────────────────────────────────────

app.get('/api/accounts/:id/usage', async (req, res) => {
  try {
    const token = extractToken(req);
    if (!token) return res.status(401).json({ error: 'No token provided' });
    const accountId = req.params.id;
    const source = req.query.source;
    const adminToken = await getAdminToken();
    
    const query = source ? `?source=${encodeURIComponent(source)}` : '';
    const result = await sub2apiRequest('GET', `/api/v1/admin/accounts/${accountId}/usage${query}`, adminToken);
    res.status(result.status).json(result.data);
  } catch (err) {
    console.error('Get account usage error:', err.message);
    res.status(502).json({ error: 'Failed to connect to Sub2API' });
  }
});


// ──────────────────────────────────────────────
// API: Get groups list (for account creation form)
// ──────────────────────────────────────────────

app.get('/api/groups', async (req, res) => {
  try {
    const token = extractToken(req);
    if (!token) return res.status(401).json({ error: 'No token provided' });

    // Extract user email from JWT for auto-create check
    const jwtPayload = decodeJwtPayload(token);
    const userEmail = jwtPayload?.email || '';

    // Use admin token since /api/v1/admin/groups/all requires admin
    const adminToken = await getAdminToken();
    const result = await sub2apiRequest('GET', '/api/v1/admin/groups/all', adminToken);
    if (result.status !== 200) {
      return res.status(result.status).json(result.data);
    }

    let allGroups = Array.isArray(result.data)
      ? result.data
      : (result.data?.items || result.data?.data || []);

    // Auto-create group if user's email group doesn't exist
    if (userEmail) {
      const hasGroup = allGroups.some(g => g.status === 'active' && g.name === userEmail);
      if (!hasGroup) {
        console.log(`Auto-creating group for user: ${userEmail}`);
        try {
          const createResult = await sub2apiRequest('POST', '/api/v1/admin/groups', adminToken, {
            name: userEmail,
            description: `Auto-created for ${userEmail}`,
            platform: 'openai',
            status: 'active',
          });
          if (createResult.status === 200 || createResult.status === 201) {
            // Re-fetch to get the complete list including the new group
            const refreshed = await sub2apiRequest('GET', '/api/v1/admin/groups/all', adminToken);
            if (refreshed.status === 200) {
              allGroups = Array.isArray(refreshed.data)
                ? refreshed.data
                : (refreshed.data?.items || refreshed.data?.data || []);
            }
          } else {
            console.warn('Auto-create group failed:', createResult.status, createResult.data);
          }
        } catch (createErr) {
          console.warn('Auto-create group error:', createErr.message);
        }
      }
    }

    res.json(allGroups);
  } catch (err) {
    console.error('List groups error:', err.message);
    res.status(502).json({ error: 'Failed to connect to Sub2API' });
  }
});

app.post('/api/groups', async (req, res) => {
  try {
    const token = extractToken(req);
    if (!token) return res.status(401).json({ error: 'No token provided' });

    // Use admin token since creating groups requires admin
    const adminToken = await getAdminToken();
    const result = await sub2apiRequest('POST', '/api/v1/admin/groups', adminToken, req.body);
    res.status(result.status).json(result.data);
  } catch (err) {
    console.error('Create group error:', err.message);
    res.status(502).json({ error: 'Failed to connect to Sub2API' });
  }
});

// ──────────────────────────────────────────────
// API: OAuth proxy routes
// Proxy OAuth endpoints so non-admin users can
// use the OAuth authorization flow via this page.
// ──────────────────────────────────────────────

// Claude OAuth: generate-auth-url, generate-setup-token-url, exchange-code, exchange-setup-token-code, cookie-auth, setup-token-cookie-auth
const claudeOAuthPaths = [
  'generate-auth-url',
  'generate-setup-token-url',
  'exchange-code',
  'exchange-setup-token-code',
  'cookie-auth',
  'setup-token-cookie-auth',
];
for (const p of claudeOAuthPaths) {
  app.post(`/api/oauth/accounts/${p}`, async (req, res) => {
    try {
      const user = verifyUserToken(req);
      if (!user) return res.status(401).json({ error: 'Not authenticated' });
      const adminToken = await getAdminToken();
      const result = await sub2apiRequest('POST', `/api/v1/admin/accounts/${p}`, adminToken, req.body);
      res.status(result.status).json(result.data);
    } catch (err) {
      console.error(`OAuth accounts/${p} error:`, err.message);
      res.status(502).json({ error: err.message || 'Failed to connect to Sub2API' });
    }
  });
}

// OpenAI OAuth: generate-auth-url, exchange-code, refresh-token
const openaiOAuthPaths = ['generate-auth-url', 'exchange-code', 'refresh-token'];
for (const p of openaiOAuthPaths) {
  app.post(`/api/oauth/openai/${p}`, async (req, res) => {
    try {
      const user = verifyUserToken(req);
      if (!user) return res.status(401).json({ error: 'Not authenticated' });
      const adminToken = await getAdminToken();
      const result = await sub2apiRequest('POST', `/api/v1/admin/openai/${p}`, adminToken, req.body);
      res.status(result.status).json(result.data);
    } catch (err) {
      console.error(`OAuth openai/${p} error:`, err.message);
      res.status(502).json({ error: err.message || 'Failed to connect to Sub2API' });
    }
  });
}

// Gemini OAuth: oauth/auth-url, oauth/exchange-code
app.post('/api/oauth/gemini/auth-url', async (req, res) => {
  try {
    const user = verifyUserToken(req);
    if (!user) return res.status(401).json({ error: 'Not authenticated' });
    const adminToken = await getAdminToken();
    const result = await sub2apiRequest('POST', '/api/v1/admin/gemini/oauth/auth-url', adminToken, req.body);
    res.status(result.status).json(result.data);
  } catch (err) {
    console.error('OAuth gemini/auth-url error:', err.message);
    res.status(502).json({ error: err.message || 'Failed to connect to Sub2API' });
  }
});

app.post('/api/oauth/gemini/exchange-code', async (req, res) => {
  try {
    const user = verifyUserToken(req);
    if (!user) return res.status(401).json({ error: 'Not authenticated' });
    const adminToken = await getAdminToken();
    const result = await sub2apiRequest('POST', '/api/v1/admin/gemini/oauth/exchange-code', adminToken, req.body);
    res.status(result.status).json(result.data);
  } catch (err) {
    console.error('OAuth gemini/exchange-code error:', err.message);
    res.status(502).json({ error: err.message || 'Failed to connect to Sub2API' });
  }
});

// Antigravity OAuth: oauth/auth-url, oauth/exchange-code, oauth/refresh-token
app.post('/api/oauth/antigravity/auth-url', async (req, res) => {
  try {
    const user = verifyUserToken(req);
    if (!user) return res.status(401).json({ error: 'Not authenticated' });
    const adminToken = await getAdminToken();
    const result = await sub2apiRequest('POST', '/api/v1/admin/antigravity/oauth/auth-url', adminToken, req.body);
    res.status(result.status).json(result.data);
  } catch (err) {
    console.error('OAuth antigravity/auth-url error:', err.message);
    res.status(502).json({ error: err.message || 'Failed to connect to Sub2API' });
  }
});

app.post('/api/oauth/antigravity/exchange-code', async (req, res) => {
  try {
    const user = verifyUserToken(req);
    if (!user) return res.status(401).json({ error: 'Not authenticated' });
    const adminToken = await getAdminToken();
    const result = await sub2apiRequest('POST', '/api/v1/admin/antigravity/oauth/exchange-code', adminToken, req.body);
    res.status(result.status).json(result.data);
  } catch (err) {
    console.error('OAuth antigravity/exchange-code error:', err.message);
    res.status(502).json({ error: err.message || 'Failed to connect to Sub2API' });
  }
});

app.post('/api/oauth/antigravity/refresh-token', async (req, res) => {
  try {
    const user = verifyUserToken(req);
    if (!user) return res.status(401).json({ error: 'Not authenticated' });
    const adminToken = await getAdminToken();
    const result = await sub2apiRequest('POST', '/api/v1/admin/antigravity/oauth/refresh-token', adminToken, req.body);
    res.status(result.status).json(result.data);
  } catch (err) {
    console.error('OAuth antigravity/refresh-token error:', err.message);
    res.status(502).json({ error: err.message || 'Failed to connect to Sub2API' });
  }
});

// ──────────────────────────────────────────────
// API: Expose Sub2API base URL
// Allows the frontend / extension to auto-discover the
// actual Sub2API address without manual user configuration.
// ──────────────────────────────────────────────

app.get('/api/sub2api-url', (req, res) => {
  res.json({ url: SUB2API_BASE_URL });
});

// ──────────────────────────────────────────────
// API: Get proxies list (for account creation form)
// ──────────────────────────────────────────────

app.get('/api/proxies', async (req, res) => {
  try {
    const token = extractToken(req);
    if (!token) return res.status(401).json({ error: 'No token provided' });

    const result = await sub2apiRequest('GET', '/api/v1/admin/proxies/all', token);
    res.status(result.status).json(result.data);
  } catch (err) {
    console.error('List proxies error:', err.message);
    res.status(502).json({ error: 'Failed to connect to Sub2API' });
  }
});

// ──────────────────────────────────────────────
// API: Get/Set Extension Settings (Encrypted)
// ──────────────────────────────────────────────

app.get('/api/extension/settings', async (req, res) => {
  try {
    const token = extractToken(req);
    if (!token) return res.status(401).json({ error: 'No token provided' });

    // Decode JWT directly to get userId (avoid admin-only restrictions)
    const jwtPayload = decodeJwtPayload(token);
    const userId = jwtPayload?.sub || jwtPayload?.id || jwtPayload?.user_id;
    if (!userId) return res.status(401).json({ error: 'Unable to parse user identity from token' });

    const fileContent = await fs.readFile(DATA_FILE, 'utf8');
    const allSettings = JSON.parse(fileContent);
    const userSettings = allSettings[userId] || {};

    const defaultSettings = { panelMode: 'sub2api' };
    const mergedSettings = { ...defaultSettings, ...userSettings };

    const encrypted = encryptData(JSON.stringify(mergedSettings));
    res.json({ payload: encrypted });
  } catch (err) {
    console.error('Get extension settings error:', err.message);
    res.status(500).json({ error: 'Internal server error while fetching settings' });
  }
});

app.post('/api/extension/settings', async (req, res) => {
  try {
    const token = extractToken(req);
    if (!token) return res.status(401).json({ error: 'No token provided' });

    // Decode JWT directly to get userId
    const jwtPayload = decodeJwtPayload(token);
    const userId = jwtPayload?.sub || jwtPayload?.id || jwtPayload?.user_id;
    if (!userId) return res.status(401).json({ error: 'Unable to parse user identity from token' });

    const { payload } = req.body;
    if (!payload) return res.status(400).json({ error: 'Missing encrypted payload' });

    let decryptedConfig;
    try {
      decryptedConfig = decryptData(payload);
      JSON.parse(decryptedConfig); // Validate JSON format
    } catch (e) {
      return res.status(400).json({ error: 'Invalid payload encryption or format' });
    }

    const configObj = JSON.parse(decryptedConfig);

    const fileContent = await fs.readFile(DATA_FILE, 'utf8');
    const allSettings = JSON.parse(fileContent);
    allSettings[userId] = configObj;

    await fs.writeFile(DATA_FILE, JSON.stringify(allSettings, null, 2), 'utf8');

    // Auto-create group if sub2apiGroupName is set and doesn't exist yet
    const groupName = (configObj.sub2apiGroupName || '').trim();
    if (groupName) {
      try {
        const adminToken = await getAdminToken();
        const groupsResult = await sub2apiRequest('GET', '/api/v1/admin/groups/all', adminToken);
        if (groupsResult.status === 200) {
          const allGroups = Array.isArray(groupsResult.data)
            ? groupsResult.data
            : (groupsResult.data?.items || groupsResult.data?.data || []);
          const normalized = groupName.toLowerCase();
          const exists = allGroups.some(g => {
            const gName = (g.name || '').trim().toLowerCase();
            return gName === normalized && g.status === 'active';
          });
          if (!exists) {
            console.log(`[Settings Save] Auto-creating group: ${groupName}`);
            const createResult = await sub2apiRequest('POST', '/api/v1/admin/groups', adminToken, {
              name: groupName,
              description: `Auto-created for ${groupName}`,
              platform: 'openai',
              status: 'active',
            });
            if (createResult.status === 200 || createResult.status === 201) {
              console.log(`[Settings Save] Group "${groupName}" created successfully (ID: ${createResult.data?.id})`);
            } else {
              console.warn(`[Settings Save] Auto-create group failed:`, createResult.status, createResult.data);
            }
          }
        }
      } catch (groupErr) {
        console.warn('[Settings Save] Auto-create group error:', groupErr.message);
      }
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Save extension settings error:', err.message);
    res.status(500).json({ error: 'Internal server error while saving settings' });
  }
});

// ──────────────────────────────────────────────
// API: Extension Version Check (with changelog)
// ──────────────────────────────────────────────

const EXTENSION_MANIFEST_PATH = path.join(__dirname, 'epoint-gpt-autoreg-extension', 'manifest.json');

app.get('/api/extension/version', async (req, res) => {
  try {
    const manifestContent = await fs.readFile(EXTENSION_MANIFEST_PATH, 'utf8');
    const manifest = JSON.parse(manifestContent);

    res.json({
      version: manifest.version || '0.0.0',
      downloadUrl: '/epoint-gpt-autoreg-extension.zip',
      name: manifest.name || '',
      changelog: manifest.changelog || '',
    });
  } catch (err) {
    console.error('Extension version check error:', err.message);
    res.status(500).json({ error: 'Failed to read extension version' });
  }
});

// ──────────────────────────────────────────────
// Fallback: Serve SPA
// ──────────────────────────────────────────────

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Sub2API Extra running on port ${PORT}`);
  console.log(`Sub2API backend: ${SUB2API_BASE_URL}`);
});

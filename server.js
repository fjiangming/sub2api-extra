const express = require('express');
const path = require('path');
const fs = require('fs').promises;
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3100;
const SUB2API_BASE_URL = (process.env.SUB2API_BASE_URL || 'http://localhost:8080').replace(/\/+$/, '');

const DATA_FILE = path.join(__dirname, 'data', 'extension_settings.json');
const ENCRYPTION_KEY = Buffer.from((process.env.EXT_SECRET || 'sub2api_ext_settings_secret_key_1').padEnd(32, '0')).slice(0, 32);

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

// ──────────────────────────────────────────────
// API: Verify user identity (proxy to /auth/me)
// ──────────────────────────────────────────────

app.get('/api/auth/me', async (req, res) => {
  try {
    const token = extractToken(req);
    if (!token) return res.status(401).json({ error: 'No token provided' });

    const result = await sub2apiRequest('GET', '/api/v1/auth/me', token);
    res.status(result.status).json(result.data);
  } catch (err) {
    console.error('Auth/me proxy error:', err.message);
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
// API: List accounts (filtered by user ownership)
// ──────────────────────────────────────────────

app.get('/api/accounts', async (req, res) => {
  try {
    const token = extractToken(req);
    if (!token) return res.status(401).json({ error: 'No token provided' });

    const userId = req.query.user_id;
    if (!userId) return res.status(400).json({ error: 'user_id required' });

    const ownerTag = `[added-by:${userId}]`;
    const searchQuery = req.query.search || '';

    // Fetch accounts from Sub2API (large page to get all for filtering)
    // We'll paginate through if needed
    let allMatchedAccounts = [];
    let page = 1;
    const pageSize = 200;
    let totalPages = 1;

    do {
      const queryParams = new URLSearchParams({
        page: String(page),
        page_size: String(pageSize),
      });
      if (searchQuery) queryParams.set('search', searchQuery);

      const result = await sub2apiRequest(
        'GET',
        `/api/v1/admin/accounts?${queryParams.toString()}`,
        token
      );

      if (result.status !== 200) {
        return res.status(result.status).json(result.data);
      }

      const responseData = result.data;
      // Sub2API wraps in { code, data } or returns directly
      const items = responseData.items || responseData.data?.items || [];
      const total = responseData.total || responseData.data?.total || 0;
      const pages = responseData.pages || responseData.data?.pages || 1;
      totalPages = pages;

      // Filter by ownership tag in notes
      const matched = items.filter(acc =>
        acc.notes && acc.notes.includes(ownerTag)
      );
      allMatchedAccounts.push(...matched);
      page++;
    } while (page <= totalPages && page <= 10); // Safety limit: max 10 pages (2000 accounts)

    // Apply client-side search if needed (Sub2API search may be broader)
    let filtered = allMatchedAccounts;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      filtered = allMatchedAccounts.filter(acc =>
        (acc.name && acc.name.toLowerCase().includes(q)) ||
        (acc.notes && acc.notes.toLowerCase().includes(q))
      );
    }

    // Client-side pagination
    const clientPage = parseInt(req.query.page) || 1;
    const clientPageSize = parseInt(req.query.page_size) || 20;
    const start = (clientPage - 1) * clientPageSize;
    const paged = filtered.slice(start, start + clientPageSize);

    res.json({
      items: paged,
      total: filtered.length,
      page: clientPage,
      page_size: clientPageSize,
      pages: Math.ceil(filtered.length / clientPageSize) || 1
    });
  } catch (err) {
    console.error('List accounts error:', err.message);
    res.status(502).json({ error: 'Failed to connect to Sub2API' });
  }
});

// ──────────────────────────────────────────────
// API: Create account (inject ownership tag)
// ──────────────────────────────────────────────

app.post('/api/accounts', async (req, res) => {
  try {
    const token = extractToken(req);
    if (!token) return res.status(401).json({ error: 'No token provided' });

    const { user_id, username, ...accountData } = req.body;
    if (!user_id) return res.status(400).json({ error: 'user_id required' });

    // Prefix name with username
    const namePrefix = username ? `${username}-` : '';
    accountData.name = `${namePrefix}${accountData.name || 'unnamed'}`;

    // Inject ownership tag into notes
    const ownerTag = `[added-by:${user_id}]`;
    accountData.notes = accountData.notes
      ? `${ownerTag} ${accountData.notes}`
      : ownerTag;

    const result = await sub2apiRequest('POST', '/api/v1/admin/accounts', token, accountData);
    res.status(result.status).json(result.data);
  } catch (err) {
    console.error('Create account error:', err.message);
    res.status(502).json({ error: 'Failed to connect to Sub2API' });
  }
});

// ──────────────────────────────────────────────
// API: Delete account (verify ownership first)
// ──────────────────────────────────────────────

app.delete('/api/accounts/:id', async (req, res) => {
  try {
    const token = extractToken(req);
    if (!token) return res.status(401).json({ error: 'No token provided' });

    const userId = req.query.user_id;
    if (!userId) return res.status(400).json({ error: 'user_id required' });

    const accountId = req.params.id;
    const ownerTag = `[added-by:${userId}]`;

    // First verify ownership by fetching the account
    const getResult = await sub2apiRequest('GET', `/api/v1/admin/accounts/${accountId}`, token);
    if (getResult.status !== 200) {
      return res.status(getResult.status).json(getResult.data);
    }

    const account = getResult.data;
    if (!account.notes || !account.notes.includes(ownerTag)) {
      return res.status(403).json({ error: 'You can only delete accounts you added' });
    }

    // Delete from Sub2API
    const result = await sub2apiRequest('DELETE', `/api/v1/admin/accounts/${accountId}`, token);
    res.status(result.status).json(result.data);
  } catch (err) {
    console.error('Delete account error:', err.message);
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

    const result = await sub2apiRequest('GET', '/api/v1/admin/groups/all', token);
    res.status(result.status).json(result.data);
  } catch (err) {
    console.error('List groups error:', err.message);
    res.status(502).json({ error: 'Failed to connect to Sub2API' });
  }
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

    // Verify token and get userId via sub2api auth endpoint
    const authResult = await sub2apiRequest('GET', '/api/v1/auth/me', token);
    if (authResult.status !== 200) {
      return res.status(authResult.status).json(authResult.data);
    }
    const userId = authResult.data.id || authResult.data.data?.id;
    if (!userId) return res.status(401).json({ error: 'Unable to parse user identity' });

    const fileContent = await fs.readFile(DATA_FILE, 'utf8');
    const allSettings = JSON.parse(fileContent);
    const userSettings = allSettings[userId] || {};

    const encrypted = encryptData(JSON.stringify(userSettings));
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

    // Verify token and get userId
    const authResult = await sub2apiRequest('GET', '/api/v1/auth/me', token);
    if (authResult.status !== 200) {
      return res.status(authResult.status).json(authResult.data);
    }
    const userId = authResult.data.id || authResult.data.data?.id;
    if (!userId) return res.status(401).json({ error: 'Unable to parse user identity' });

    const { payload } = req.body;
    if (!payload) return res.status(400).json({ error: 'Missing encrypted payload' });

    let decryptedConfig;
    try {
      decryptedConfig = decryptData(payload);
      JSON.parse(decryptedConfig); // Validate JSON format
    } catch (e) {
      return res.status(400).json({ error: 'Invalid payload encryption or format' });
    }

    const fileContent = await fs.readFile(DATA_FILE, 'utf8');
    const allSettings = JSON.parse(fileContent);
    allSettings[userId] = JSON.parse(decryptedConfig);

    await fs.writeFile(DATA_FILE, JSON.stringify(allSettings, null, 2), 'utf8');
    res.json({ success: true });
  } catch (err) {
    console.error('Save extension settings error:', err.message);
    res.status(500).json({ error: 'Internal server error while saving settings' });
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

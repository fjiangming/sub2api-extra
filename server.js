const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3100;
const SUB2API_BASE_URL = (process.env.SUB2API_BASE_URL || 'http://localhost:8080').replace(/\/+$/, '');

app.use(express.json());

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
// Fallback: Serve SPA
// ──────────────────────────────────────────────

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Sub2API Extra running on port ${PORT}`);
  console.log(`Sub2API backend: ${SUB2API_BASE_URL}`);
});

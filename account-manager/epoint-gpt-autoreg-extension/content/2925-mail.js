// content/2925-mail.js — Content script for 2925 Mail inbox polling (steps 4, 7)

const MAIL_2925_PREFIX = '[MultiPage:mail-2925]';
const isTopFrame = window === window.top;

const {
  build2925MessageFromRowSnapshot = () => null,
  detect2925MainEmailFromPageSnapshot = () => null,
  extractVerificationCode = () => null,
  select2925VerificationMessage = () => null,
} = globalThis.MultiPage2925Mail || {};

console.log(MAIL_2925_PREFIX, 'Content script loaded on', location.href, 'frame:', isTopFrame ? 'top' : 'child');

let seen2925Codes = new Set();

async function loadSeen2925Codes() {
  try {
    const data = await chrome.storage.session.get('seen2925Codes');
    if (data.seen2925Codes && Array.isArray(data.seen2925Codes)) {
      seen2925Codes = new Set(data.seen2925Codes);
      console.log(MAIL_2925_PREFIX, `Loaded ${seen2925Codes.size} previously seen 2925 codes`);
    }
  } catch (err) {
    console.warn(MAIL_2925_PREFIX, 'Session storage unavailable, using in-memory 2925 seen codes:', err?.message || err);
  }
}

loadSeen2925Codes();

async function persistSeen2925Codes() {
  try {
    await chrome.storage.session.set({ seen2925Codes: [...seen2925Codes] });
  } catch (err) {
    console.warn(MAIL_2925_PREFIX, 'Could not persist 2925 seen codes, continuing in-memory only:', err?.message || err);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== 'POLL_EMAIL' && message.type !== 'FETCH_2925_MAIN_EMAIL') {
    return;
  }

  if (!isTopFrame) {
    sendResponse({ ok: false, reason: 'wrong-frame' });
    return;
  }

  resetStopState();
  const handler = message.type === 'FETCH_2925_MAIN_EMAIL'
    ? handleFetch2925MainEmail()
    : handlePoll2925Mail(message.step, message.payload || {});

  handler.then((result) => {
    sendResponse(result);
  }).catch((err) => {
    if (isStopError(err)) {
      log(`Step ${message.step}: Stopped by user.`, 'warn');
      sendResponse({ stopped: true, error: err.message });
      return;
    }

    if (message.step != null) {
      reportError(message.step, err.message);
    }
    sendResponse({ error: err.message });
  });

  return true;
});

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function isVisible(el) {
  if (!el) return false;
  if (el.hidden) return false;
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
    return false;
  }

  return Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
}

function getElementText(el) {
  return normalizeText(
    el?.innerText
    || el?.textContent
    || el?.getAttribute?.('title')
    || el?.getAttribute?.('aria-label')
    || ''
  );
}

async function waitForCondition(predicate, timeout, errorMessage) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeout) {
    throwIfStopped();
    const value = predicate();
    if (value) {
      return value;
    }
    await sleep(150);
  }

  throw new Error(errorMessage);
}

function getInboxRowElements() {
  return Array.from(document.querySelectorAll('tr.read-mail, tr.unread-mail, tr'))
    .filter((row) => isVisible(row) && row.cells && row.cells.length >= 6 && getElementText(row));
}

function extractRowSubject(row) {
  const title = getElementText(row.querySelector('.mail-content-title'));
  const preview = getElementText(row.querySelector('.mail-content-text'));
  return normalizeText(`${title} ${preview}`);
}

function extractRowTimestampText(row) {
  return getElementText(row.querySelector('.date-time-text'));
}

function getRawTextContent(el) {
  return normalizeText(el?.textContent || '');
}

function extractRowSender(row) {
  return getElementText(
    row.querySelector('td.sender .ivu-tooltip-rel')
    || row.querySelector('td.sender')
  );
}

function extractRowSenderDetail(row) {
  return getRawTextContent(row.querySelector('td.sender .ivu-tooltip-inner'));
}

function collectRowSnapshots() {
  return getInboxRowElements().map((row) => ({
    element: row,
    preview: getElementText(row.querySelector('.mail-content-text')),
    rawText: getRawTextContent(row),
    sender: extractRowSender(row),
    senderDetail: extractRowSenderDetail(row),
    subject: extractRowSubject(row),
    timestampText: extractRowTimestampText(row),
  }));
}

function getRefreshControl() {
  return Array.from(document.querySelectorAll('div.tool-common, button, [role="button"], span'))
    .filter(isVisible)
    .find((el) => getElementText(el) === '刷新');
}

function getInboxTab() {
  return Array.from(document.querySelectorAll('li, div, span, a'))
    .filter(isVisible)
    .find((el) => getElementText(el) === '收件箱');
}

function collectVisibleTextsFromSelectors(selectors = []) {
  const seen = new Set();
  const texts = [];

  for (const selector of selectors) {
    for (const element of document.querySelectorAll(selector)) {
      if (!isVisible(element)) {
        continue;
      }

      const text = getElementText(element);
      if (!text || seen.has(text)) {
        continue;
      }

      seen.add(text);
      texts.push(text);
    }
  }

  return texts;
}

function collectPreferredMainEmailTexts() {
  const selectors = [
    'header',
    'aside',
    '.header',
    '.top',
    '.top-bar',
    '.toolbar',
    '.sidebar',
    '.userinfo',
    '.user-info',
    '.account',
    '.account-info',
    '.mail-account',
    '.mail-user',
    '[class*="user"]',
    '[class*="account"]',
    '[class*="email"]',
    '[class*="mail"]',
    '[title*="@2925.com"]',
    '[aria-label*="@2925.com"]',
  ];

  return collectVisibleTextsFromSelectors(selectors)
    .filter((text) => text.includes('@2925.com') || /当前|账号|邮箱/.test(text));
}

function collectFallbackMainEmailTexts() {
  const bodyText = normalizeText(document.body?.innerText || '');
  return bodyText ? [bodyText] : [];
}

function buildMainEmailSnapshot() {
  return {
    fallbackTexts: collectFallbackMainEmailTexts(),
    preferredTexts: collectPreferredMainEmailTexts(),
  };
}

function has2925MailboxShell() {
  if (!location.hash.startsWith('#/mailList')) {
    return false;
  }

  return Boolean(
    getRefreshControl()
    || getInboxTab()
    || document.querySelector('table')
    || collectPreferredMainEmailTexts().length > 0
  );
}

async function ensureMailListPage() {
  if (!location.hash.startsWith('#/mailList')) {
    location.hash = '#/mailList';
    await sleep(700);
  }

  if (location.hash.startsWith('#/mailList') && getInboxRowElements().length > 0) {
    return getInboxRowElements();
  }

  const inboxTab = getInboxTab();
  if (inboxTab) {
    simulateClick(inboxTab);
  }

  return waitForCondition(
    () => {
      const rows = getInboxRowElements();
      if (rows.length > 0) {
        return rows;
      }

      return has2925MailboxShell() ? [] : null;
    },
    10000,
    '未检测到 2925 主邮箱，请先登录 2925 邮箱并打开收件箱页面。'
  );
}

async function refreshInbox() {
  await ensureMailListPage();

  const refreshControl = await waitForCondition(
    () => getRefreshControl(),
    5000,
    '未检测到 2925 主邮箱，请先登录 2925 邮箱并打开收件箱页面。'
  );

  await humanPause(120, 260);
  simulateClick(refreshControl);
  await sleep(1200);
  await ensureMailListPage();
}

function collectMessagesForTarget(targetEmail) {
  return collectRowSnapshots()
    .slice(0, 10)
    .map((snapshot) => {
      const message = build2925MessageFromRowSnapshot(snapshot, {
        referenceDate: new Date(),
        targetEmail,
      });
      message._rowElement = snapshot.element;
      return message;
    })
    .filter((message) => message.matchedEmail || extractVerificationCode(message.combinedText));
}

// ── Deep scan: open email detail to extract verification code ──

function getEmailDetailBodyText() {
  // 2925 邮件详情页的正文容器选择器（按优先级排列）
  // OpenAI 验证邮件 HTML 根元素为 <table id="bodyTable">，正文在 <table class="main"> 中
  const selectors = [
    '#bodyTable',
    'table.main',
    '.readMailMainCont',
    '.mail-detail-body',
    '.mail-body',
    '.mail-detail',
    '.detail-body',
    '.mail-content-body',
    '[class*="readMail"]',
    '[class*="mail-detail"]',
    '[class*="mail-body"]',
    '[class*="detail-content"]',
  ];

  // 优先搜索 iframe 中的正文（2925 邮件正文通常渲染在 iframe 内）
  for (const iframe of document.querySelectorAll('iframe')) {
    try {
      const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
      if (!iframeDoc) continue;

      // 先在 iframe 内尝试精准选择器
      for (const selector of selectors) {
        const el = iframeDoc.querySelector(selector);
        if (el) {
          const text = normalizeText(el.innerText || el.textContent || '');
          if (text && extractVerificationCode(text)) {
            return text;
          }
        }
      }

      // iframe 整体文本兜底
      const fullText = normalizeText(iframeDoc.body?.innerText || iframeDoc.body?.textContent || '');
      if (fullText && extractVerificationCode(fullText)) {
        return fullText;
      }
    } catch (_err) {
      // 跨域 iframe，跳过
    }
  }

  // 在主文档中搜索正文容器
  for (const selector of selectors) {
    for (const el of document.querySelectorAll(selector)) {
      if (!isVisible(el)) continue;
      const text = getElementText(el);
      if (text && extractVerificationCode(text)) {
        return text;
      }
    }
  }

  // 兜底：整个页面文本
  return normalizeText(document.body?.innerText || '');
}

async function tryOpenEmailAndExtractCode(rowElement) {
  simulateClick(rowElement);
  await sleep(2000);

  // 重试提取，等待详情页内容完整加载
  for (let i = 0; i < 6; i++) {
    throwIfStopped();
    const detailText = getEmailDetailBodyText();
    const code = extractVerificationCode(detailText);
    if (code) {
      // 提取到验证码后返回收件箱列表
      await ensureMailListPage();
      return code;
    }
    await sleep(500);
  }

  // 未找到验证码，也要返回收件箱列表
  await ensureMailListPage();
  return null;
}

async function deepScanForVerificationCode(targetEmail, options = {}) {
  const { senderFilters = [], subjectFilters = [], excludeCodes = new Set() } = options;
  const messages = collectMessagesForTarget(targetEmail);

  // 找出匹配目标邮箱但列表视图中无法提取验证码的行
  const candidateRows = [];
  for (const message of messages) {
    if (targetEmail && message.matchedEmail !== targetEmail) continue;
    if (extractVerificationCode(`${message.subject || ''} ${message.combinedText}`)) continue;
    if (!message._rowElement) continue;
    candidateRows.push(message);
  }

  if (candidateRows.length === 0) return null;

  log(`Deep scan: 发现 ${candidateRows.length} 封匹配但列表中无验证码的邮件，尝试打开详情读取`, 'info');

  // 限制最多打开前 3 封，避免耗时过长
  for (const message of candidateRows.slice(0, 3)) {
    throwIfStopped();
    const code = await tryOpenEmailAndExtractCode(message._rowElement);
    if (code && !excludeCodes.has(code)) {
      log(`Deep scan: 从邮件详情中提取到验证码 ${code}`, 'ok');
      return {
        code,
        emailTimestamp: message.emailTimestamp,
        matchedEmail: message.matchedEmail,
        messageId: message.messageId,
        subject: message.subject,
      };
    }
  }

  return null;
}

async function findMatching2925VerificationResult({
  allowExistingMessages = true,
  existingMessageIds = [],
  filterAfterTimestamp = 0,
  senderFilters = [],
  subjectFilters = [],
  targetEmail = '',
  timeoutMs = 2500,
}) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    throwIfStopped();

    const messages = collectMessagesForTarget(targetEmail);
    const result = select2925VerificationMessage(messages, {
      allowExistingMessages,
      existingMessageIds,
      filterAfterTimestamp,
      senderFilters,
      subjectFilters,
      targetEmail,
    });

    if (result?.code) return result;

    await sleep(250);
  }

  return null;
}

async function handleFetch2925MainEmail() {
  await ensureMailListPage();

  let snapshot = buildMainEmailSnapshot();
  let detected = detect2925MainEmailFromPageSnapshot(snapshot);

  if (!detected?.email) {
    log('Fetch 2925 main email: first detection failed, refreshing inbox and retrying...', 'warn');
    await refreshInbox();
    snapshot = buildMainEmailSnapshot();
    detected = detect2925MainEmailFromPageSnapshot(snapshot);
  }

  if (!detected?.email) {
    throw new Error('当前页面未识别到可用的 2925 主邮箱，请确认页面已完全加载后重试。');
  }

  return {
    ok: true,
    detectionMode: detected.detectionMode || (detected.preferred ? 'preferred' : 'fallback'),
    domain: detected.domain,
    email: detected.email,
    localPart: detected.localPart,
  };
}

async function handlePoll2925Mail(step, payload = {}) {
  const FALLBACK_AFTER = 3;
  const {
    filterAfterTimestamp = 0,
    intervalMs = 3000,
    maxAttempts = 20,
    senderFilters = [],
    subjectFilters = [],
    targetEmail = '',
    excludeCodes = [],
  } = payload;
  const excludedCodeSet = new Set((excludeCodes || []).filter(Boolean));

  // 每次新的 POLL_EMAIL 调用时清空 seen2925Codes，
  // 避免跨轮累积导致 OpenAI 重发的相同验证码被永久拦截。
  // 跨轮去重由 background 传入的 excludeCodes 负责。
  seen2925Codes.clear();
  await persistSeen2925Codes();

  if (!targetEmail) {
    throw new Error('未找到当前子邮箱，请先执行 Step 3 生成 2925 子邮箱。');
  }

  await ensureMailListPage();
  log(`Step ${step}: Starting 2925 inbox poll for ${targetEmail}`, 'info');
  const existingMessageIds = new Set(
    collectMessagesForTarget(targetEmail).map((message) => message.messageId).filter(Boolean)
  );

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const allowExistingMessages = attempt > FALLBACK_AFTER;
    log(`Step ${step}: Polling 2925 inbox... attempt ${attempt}/${maxAttempts}`, 'info');
    await refreshInbox();

    const attemptResult = await findMatching2925VerificationResult({
      allowExistingMessages,
      existingMessageIds: [...existingMessageIds],
      filterAfterTimestamp,
      senderFilters,
      subjectFilters,
      targetEmail,
      timeoutMs: 2500,
    });
    let result = attemptResult || null;

    // 列表视图无法提取验证码时，尝试打开邮件详情页深入读取
    if (!result?.code) {
      const deepResult = await deepScanForVerificationCode(targetEmail, {
        senderFilters,
        subjectFilters,
        excludeCodes: excludedCodeSet,
      });
      if (deepResult?.code) {
        result = deepResult;
      }
    }

    if (result?.code) {
      if (excludedCodeSet.has(result.code)) {
        log(`Step ${step}: Skipping excluded 2925 code: ${result.code}`, 'info');
        continue;
      }
      if (seen2925Codes.has(result.code)) {
        log(`Step ${step}: Reusing same 2925 code within poll: ${result.code}`, 'info');
      }
      // 记录本次轮询内已见过的验证码（防止同一次 poll 内重复返回相同行）
      seen2925Codes.add(result.code);
      await persistSeen2925Codes();
      log(
        `Step ${step}: Code found: ${result.code} (recipient: ${result.matchedEmail || 'unknown'})`,
        'ok'
      );
      return { ok: true, ...result };
    }

    if (attempt === FALLBACK_AFTER + 1) {
      log(`Step ${step}: No new matching 2925 emails after ${FALLBACK_AFTER} attempts, falling back to older matching rows`, 'warn');
    }

    if (attempt < maxAttempts) {
      await sleep(intervalMs);
    }
  }

  if (step === 7 && filterAfterTimestamp > 0) {
    throw new Error('2925 收件箱中未找到比上一次更新更新的验证码邮件，请稍后重试。');
  }

  throw new Error('2925 收件箱中暂未找到当前子邮箱的验证码邮件。');
}

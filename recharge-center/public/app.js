'use strict';

const presentationParams = new URLSearchParams(window.location.search);
const requestedTheme = presentationParams.get('theme');
const storedTheme = (() => {
  try {
    return window.localStorage.getItem('recharge-center-theme');
  } catch {
    return null;
  }
})();
const initialTheme = ['light', 'dark'].includes(requestedTheme)
  ? requestedTheme
  : (['light', 'dark'].includes(storedTheme) ? storedTheme : (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
const embeddedMode = presentationParams.get('ui_mode') === 'embedded' && window.self !== window.top;

document.documentElement.classList.toggle('dark', initialTheme === 'dark');
document.documentElement.classList.toggle('embedded', embeddedMode);

const $ = (id) => document.getElementById(id);
const state = {
  bootstrapping: true,
  config: null,
  checkout: null,
  session: null,
  loginChallenge: null,
  orders: [],
  activeOrder: null,
  qrBlobUrl: null,
  pollTimer: null,
  countdownTimer: null,
  selectedAmount: null,
  customAmountText: '',
  adminPage: 1,
  adminPageSize: 20,
  adminTotal: 0,
  adminOrders: [],
  settledOrder: null,
  theme: initialTheme,
  embedded: embeddedMode,
  confirmResolver: null
};

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function icon(name) {
  return `<i data-lucide="${escapeHtml(name)}"></i>`;
}

function refreshIcons() {
  window.lucide?.createIcons({ attrs: { 'aria-hidden': 'true' } });
}

function toast(message, kind = '') {
  const node = document.createElement('div');
  const normalizedKind = ['success', 'error', 'warning'].includes(kind) ? kind : 'info';
  node.className = `toast toast-${normalizedKind}`;
  node.setAttribute('role', normalizedKind === 'error' ? 'alert' : 'status');
  const iconNode = document.createElement('i');
  iconNode.setAttribute('data-lucide', ({
    success: 'circle-check',
    error: 'circle-alert',
    warning: 'triangle-alert',
    info: 'info'
  })[normalizedKind]);
  const textNode = document.createElement('span');
  textNode.textContent = String(message || '');
  node.append(iconNode, textNode);
  $('toast-region').appendChild(node);
  refreshIcons();
  setTimeout(() => {
    node.classList.add('toast-leaving');
    setTimeout(() => node.remove(), 180);
  }, 4300);
}

function setError(id, message = '') {
  const node = $(id);
  node.textContent = message;
  node.hidden = !message;
}

function setButtonLoading(button, loading, loadingLabel = '处理中') {
  if (!button) return;
  const label = button.querySelector('[data-button-label]') || button.querySelector('span');
  if (loading) {
    if (label && !button.dataset.originalLabel) button.dataset.originalLabel = label.textContent;
    if (label) label.textContent = loadingLabel;
    button.classList.add('is-loading');
    button.disabled = true;
  } else {
    if (label && button.dataset.originalLabel) label.textContent = button.dataset.originalLabel;
    delete button.dataset.originalLabel;
    button.classList.remove('is-loading');
    button.disabled = false;
  }
}

function updateModalLock() {
  document.body.classList.toggle('modal-open', Boolean(document.querySelector('dialog[open]')));
}

function openModal(dialog) {
  if (!dialog?.open) dialog?.showModal();
  updateModalLock();
}

function closeModal(dialog) {
  if (dialog?.open) dialog.close();
  updateModalLock();
}

function resolveConfirmation(result) {
  const resolver = state.confirmResolver;
  state.confirmResolver = null;
  closeModal($('confirm-dialog'));
  resolver?.(result);
}

function askConfirmation(message, options = {}) {
  if (state.confirmResolver) state.confirmResolver(false);
  $('confirm-title').textContent = options.title || '确认操作';
  $('confirm-message').textContent = message;
  const accept = $('confirm-accept');
  accept.textContent = options.confirmLabel || '确认';
  accept.className = `button ${options.danger ? 'danger' : 'primary'}`;
  openModal($('confirm-dialog'));
  return new Promise((resolve) => {
    state.confirmResolver = resolve;
  });
}

function applyTheme(theme, persist = false) {
  state.theme = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.classList.toggle('dark', state.theme === 'dark');
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = state.theme === 'dark' ? '#020617' : '#f9fafb';
  const label = document.querySelector('.theme-label');
  if (label) label.textContent = state.theme === 'dark' ? '浅色模式' : '深色模式';
  if (persist) {
    try {
      window.localStorage.setItem('recharge-center-theme', state.theme);
    } catch {}
  }
}

async function api(path, options = {}) {
  const headers = { Accept: 'application/json', ...(options.headers || {}) };
  if (options.body != null && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  if (options.mutation && state.session?.csrfToken) headers['X-CSRF-Token'] = state.session.csrfToken;
  const response = await fetch(path, { ...options, headers, credentials: 'same-origin' });
  const contentType = response.headers.get('content-type') || '';
  const payload = contentType.includes('application/json') ? await response.json() : null;
  if (!response.ok) {
    if (response.status === 401 && !path.startsWith('/api/auth/login')) {
      clearSession();
      if (!state.bootstrapping) showLogin();
    }
    const error = new Error(payload?.error?.message || `请求失败 (${response.status})`);
    error.status = response.status;
    error.code = payload?.error?.code;
    error.details = payload?.error?.details;
    throw error;
  }
  return payload;
}

function clearSession() {
  state.session = null;
  state.checkout = null;
  state.activeOrder = null;
  state.settledOrder = null;
  state.selectedAmount = null;
  state.customAmountText = '';
  clearInterval(state.pollTimer);
  clearInterval(state.countdownTimer);
  if (state.qrBlobUrl) URL.revokeObjectURL(state.qrBlobUrl);
  state.qrBlobUrl = null;
}

function showLoading() {
  state.bootstrapping = true;
  document.body.classList.add('login-screen');
  $('loading-view').hidden = false;
  $('loading-view').setAttribute('aria-busy', 'true');
  $('loading-spinner').hidden = false;
  $('loading-message').textContent = '加载中...';
  $('loading-retry').hidden = true;
  setError('loading-error');
  $('login-view').hidden = true;
  $('app-view').hidden = true;
  $('account-menu').hidden = true;
}

function finishLoading() {
  state.bootstrapping = false;
  $('loading-view').setAttribute('aria-busy', 'false');
  $('loading-view').hidden = true;
}

function showLoadingError(error) {
  state.bootstrapping = false;
  $('loading-view').setAttribute('aria-busy', 'false');
  $('loading-spinner').hidden = true;
  $('loading-message').textContent = '暂时无法打开充值中心';
  setError('loading-error', ['TimeoutError', 'AbortError'].includes(error.name)
    ? '加载超时，请稍后重试'
    : error.code ? error.message : '暂时无法加载，请稍后重试');
  $('loading-retry').hidden = false;
}

function showLogin() {
  finishLoading();
  document.body.classList.add('login-screen');
  $('login-view').hidden = false;
  $('app-view').hidden = true;
  $('account-menu').hidden = true;
}

function isOfficialMode() {
  return state.config?.paymentMode === 'sub2api_official';
}

function isAutomaticMode() {
  return state.config?.automaticConfirmation === true;
}

function isPersonalAutoMode() {
  return state.config?.paymentMode === 'personal_transfer_auto';
}

function isAccountLogStaticMode() {
  return state.config?.paymentMode === 'personal_accountlog_static';
}

function isManualAdmin() {
  return !isOfficialMode() && state.session?.user?.role === 'admin';
}

function renderLoginMode() {
  const passwordLoginEnabled = state.config?.passwordLoginEnabled !== false;
  $('login-form').hidden = !passwordLoginEnabled;
  $('sso-only-state').hidden = passwordLoginEnabled;
  if (!passwordLoginEnabled) {
    $('two-factor-form').hidden = true;
    $('sub2api-login-link').href = state.config?.sub2apiUrl || '/';
  }
}

function showApp() {
  finishLoading();
  document.body.classList.remove('login-screen');
  $('login-view').hidden = true;
  $('app-view').hidden = false;
  $('account-menu').hidden = false;
  const user = state.session.user;
  const displayName = user.username || user.emailMasked;
  $('account-name').textContent = displayName;
  $('account-avatar').textContent = displayName.trim().slice(0, 1).toUpperCase() || 'U';
  $('account-role').textContent = user.role === 'admin' ? '管理员' : '用户';
  $('recharge-account').textContent = displayName;
  $('recharge-balance').textContent = formatMoney(user.balance);
  document.body.classList.toggle('official-mode', isOfficialMode());
  const admin = isManualAdmin();
  $('admin-nav').hidden = !admin;
  $('admin-tab').hidden = !admin;
  $('workspace-tabs').hidden = !admin;
  $('security-mode-label').textContent = isOfficialMode()
    ? '自动验签入账'
    : isPersonalAutoMode()
      ? '自动备注匹配'
      : isAccountLogStaticMode() ? '账务流水匹配' : '人工账单核验';
  $('security-mode').title = isOfficialMode()
    ? '支付宝官方订单查询与签名回调双路径确认'
    : isPersonalAutoMode()
      ? '仅在交易详情、金额、备注、收款账户、状态和付款时间全部匹配时自动入账'
      : isAccountLogStaticMode()
        ? '仅在支付宝官方账务响应验签、收入方向、唯一金额、三分钟时间窗和流水去重全部通过时自动入账'
        : '付款到账后由管理员独立核验支付宝账单';
  $('history-description').textContent = isAutomaticMode()
    ? '最近的支付宝自动充值订单'
    : '最近的个人支付宝充值订单';
  switchView('recharge');
}

function statusLabel(status) {
  return ({
    awaiting_payment: '待付款', payment_reported: '待核验', fulfilling: '入账中',
    needs_attention: '需人工恢复', completed: '已完成', rejected: '已拒绝',
    expired: '已过期', cancelled: '已取消', failed: '支付失败',
    refund_requested: '退款审核中', refunding: '退款中', refunded: '已退款', refund_failed: '退款异常'
  })[status] || status;
}

function formatDate(value) {
  if (!value) return '-';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '-' : new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
  }).format(date);
}

function formatDateTime(value) {
  if (!value) return '-';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '-' : new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).format(date);
}

function formatMoney(value) {
  const amount = Number(value || 0);
  return Number.isFinite(amount) ? amount.toFixed(2) : '0.00';
}

function renderAmountOptions() {
  const amounts = state.checkout?.quickAmounts || state.config?.quickAmounts || state.config?.allowedAmounts || [];
  $('amount-options').innerHTML = amounts.map((amount) => `
    <button class="amount-option ${amount === state.selectedAmount ? 'selected' : ''}" type="button"
      role="radio" aria-checked="${amount === state.selectedAmount}" data-amount="${amount}">${amount}</button>
  `).join('');
  updateCreditPreview();
}

function amountLimits() {
  return {
    min: Number(state.checkout?.minAmount ?? state.config?.minAmount ?? 0),
    max: Number(state.checkout?.maxAmount ?? state.config?.maxAmount ?? 0)
  };
}

function amountValidationMessage(value) {
  if (!Number.isFinite(value) || value <= 0) return '';
  const { min, max } = amountLimits();
  if (min > 0 && value < min) return `充值金额不能低于 ¥${formatMoney(min)}`;
  if (max > 0 && value > max) return `充值金额不能高于 ¥${formatMoney(max)}`;
  return '';
}

function updateCreditPreview() {
  const value = Number(state.selectedAmount || 0);
  const error = amountValidationMessage(value);
  const { min, max } = amountLimits();
  $('credit-preview').textContent = `¥${formatMoney(value)}`;
  $('order-summary-card').hidden = value <= 0;
  $('custom-amount').placeholder = min > 0 && max > 0 ? `${min} - ${max}` : '请输入充值金额';
  setError('amount-error', error);
  const button = $('create-order-form').querySelector('button[type="submit"]');
  button.disabled = value <= 0 || Boolean(error) || !state.checkout;
  const label = $('create-order-form').querySelector('[data-button-label]');
  if (label) label.textContent = `确认支付 ¥${formatMoney(value)}`;
}

async function loadCheckout() {
  state.checkout = await api('/api/checkout');
  const { min, max } = amountLimits();
  if (state.selectedAmount != null && ((min > 0 && state.selectedAmount < min) || (max > 0 && state.selectedAmount > max))) {
    state.selectedAmount = null;
    state.customAmountText = '';
    $('custom-amount').value = '';
  }
  renderAmountOptions();
}

function activeOrderFromList() {
  const priorities = ['needs_attention', 'fulfilling', 'payment_reported', 'awaiting_payment'];
  return [...state.orders]
    .filter((order) => priorities.includes(order.status))
    .sort((a, b) => priorities.indexOf(a.status) - priorities.indexOf(b.status))[0] || null;
}

function renderHistory() {
  $('history-count').textContent = `${state.orders.length} 笔`;
  $('order-history').innerHTML = state.orders.length ? state.orders.map((order) => `
    <tr>
      <td><code>${escapeHtml(order.orderNo)}</code></td>
      <td>¥${escapeHtml(formatMoney(order.payableAmount))}</td>
      <td>¥${escapeHtml(formatMoney(order.creditAmount))}</td>
      <td><span class="status-badge ${escapeHtml(order.status)}">${escapeHtml(statusLabel(order.status))}</span></td>
      <td>${escapeHtml(formatDate(order.createdAt))}</td>
    </tr>
  `).join('') : '<tr><td class="empty-row" colspan="5">暂无充值订单</td></tr>';
}

async function loadQr(order) {
  if (state.qrBlobUrl) URL.revokeObjectURL(state.qrBlobUrl);
  state.qrBlobUrl = null;
  $('payment-qr').hidden = true;
  $('alipay-mark').hidden = true;
  $('qr-loading').innerHTML = icon('loader-circle');
  $('qr-loading').hidden = false;
  if (!order.qrAvailable && isOfficialMode()) {
    $('qr-loading').innerHTML = `${icon('image-off')}<span>动态二维码已失效，请取消后重新创建</span>`;
    refreshIcons();
    return;
  }
  if (!order.qrAvailable && isPersonalAutoMode()) {
    $('qr-loading').innerHTML = `${icon('loader-circle')}<span>正在生成本单收钱码</span>`;
    refreshIcons();
    return;
  }
  try {
    const response = await fetch(`/api/orders/${encodeURIComponent(order.id)}/qr`, { credentials: 'same-origin' });
    if (response.status === 425) {
      $('qr-loading').innerHTML = `${icon('loader-circle')}<span>正在生成本单收钱码</span>`;
      refreshIcons();
      return;
    }
    if (!response.ok) throw new Error('收款码读取失败');
    const blob = await response.blob();
    state.qrBlobUrl = URL.createObjectURL(blob);
    $('payment-qr').src = state.qrBlobUrl;
    $('payment-qr').hidden = false;
    $('alipay-mark').hidden = false;
  } catch (error) {
    $('qr-loading').innerHTML = `${icon('image-off')}<span>收款码不可用</span>`;
    toast(error.message, 'error');
    refreshIcons();
  } finally {
    if (state.qrBlobUrl) $('qr-loading').hidden = true;
  }
}

function startCountdown(order) {
  clearInterval(state.countdownTimer);
  const render = () => {
    if (order.status !== 'awaiting_payment') {
      $('countdown').textContent = '--:--';
      return;
    }
    const remaining = Date.parse(order.expiresAt) - Date.now();
    if (remaining <= 0) {
      $('countdown').textContent = '00:00';
      clearInterval(state.countdownTimer);
      setTimeout(() => loadOrders().catch(() => {}), 1000);
      return;
    }
    const minutes = Math.floor(remaining / 60000);
    const seconds = Math.floor((remaining % 60000) / 1000);
    $('countdown').textContent = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  };
  render();
  state.countdownTimer = setInterval(render, 1000);
}

function renderPaymentNotice(order) {
  const prefilled = isOfficialMode() || isPersonalAutoMode();
  $('payment-notice-amount-intro').textContent = prefilled ? '确认金额 ' : '手动填写 ';
  $('payment-notice-amount').textContent = formatMoney(order.payableAmount);
  $('payment-notice-amount-suffix').textContent = isPersonalAutoMode()
    ? '（应付金额），保留自动备注。'
    : isOfficialMode() ? '（应付金额），以支付宝订单为准。' : '（应付金额），保留全部小数。';
  const minutes = (Date.parse(order.expiresAt) - Date.parse(order.createdAt)) / 60000;
  $('payment-notice-expiry').textContent = Number.isInteger(minutes) && minutes > 0
    ? `订单${minutes}分钟内有效，确认或刷新不会延长。`
    : '请在页面倒计时结束前完成付款，确认或刷新不会延长。';
  $('payment-notice-confirmation').textContent = isAutomaticMode()
    ? '付款后等待自动确认，请勿重复付款。'
    : '付款后在下方提交交易号，等待管理员核验，请勿重复付款。';
  $('payment-notice-adjustment').hidden = !isPersonalAutoMode() && !isAccountLogStaticMode();
}

async function renderActiveOrder(order, forceQr = false) {
  const previousId = state.activeOrder?.id;
  const previousStatus = state.activeOrder?.status;
  state.activeOrder = order;
  document.body.classList.toggle('payment-phase-active', Boolean(order));
  $('create-order-panel').hidden = Boolean(order);
  $('active-order-panel').hidden = !order;
  if (!order) {
    if (state.qrBlobUrl) URL.revokeObjectURL(state.qrBlobUrl);
    state.qrBlobUrl = null;
    clearInterval(state.countdownTimer);
    return;
  }
  $('active-order-no').textContent = order.orderNo;
  $('active-requested').textContent = formatMoney(order.requestedAmount || order.payableAmount);
  $('active-requested-row').hidden = !order.amountAdjusted;
  $('amount-adjustment-note').hidden = !order.amountAdjusted;
  $('active-payable').textContent = formatMoney(order.payableAmount);
  renderPaymentNotice(order);
  $('active-credit').textContent = `¥${formatMoney(order.creditAmount)}`;
  $('active-status').textContent = statusLabel(order.status);
  $('active-status').className = `status-badge ${order.status}`;
  const awaiting = order.status === 'awaiting_payment';
  const reported = order.status === 'payment_reported';
  const processing = ['fulfilling', 'needs_attention'].includes(order.status);
  const completed = order.status === 'completed';
  const cancelled = order.status === 'cancelled';
  const expired = ['expired', 'failed'].includes(order.status);
  $('payment-body').hidden = !awaiting;
  $('countdown-card').hidden = !awaiting;
  $('report-payment-block').hidden = isAutomaticMode() || !awaiting;
  $('reported-state').hidden = isOfficialMode() || !reported;
  $('processing-state').hidden = !processing;
  $('completed-state').hidden = !completed;
  $('cancelled-state').hidden = !cancelled;
  $('expired-state').hidden = !expired;
  if (processing) {
    $('processing-state-text').textContent = order.status === 'fulfilling'
      ? '付款已核验，额度正在写入 Sub2API，请勿重复付款。'
      : '付款已核验，但入账结果需要管理员恢复处理，请勿重复付款。';
  }
  if (reported) {
    $('reported-state-title').textContent = isAutomaticMode() ? '订单转入人工处理' : '等待到账核验';
    $('reported-state-text').textContent = isAutomaticMode()
      ? '自动匹配未通过完整校验，系统未放款。管理员将依据支付宝原始账单处理。'
      : '付款信息已提交。管理员将从支付宝账单独立核对，请勿再次付款。';
  }
  if (completed) {
    $('completed-state-text').textContent = '';
    $('completed-state-text').hidden = isOfficialMode();
    $('completed-order-id').textContent = `#${order.id}`;
    $('completed-order-no').textContent = order.orderNo;
    $('completed-credit').textContent = `¥${formatMoney(order.creditAmount)}`;
    $('completed-payable').textContent = `¥${formatMoney(order.payableAmount)}`;
  }
  $('cancel-order').hidden = !awaiting;
  $('cancel-order').parentElement.hidden = !awaiting;
  $('download-qr').hidden = !awaiting || (isAutomaticMode() && !order.qrAvailable);
  $('open-pay-url').hidden = !awaiting || !order.payUrl;
  $('qr-frame').hidden = awaiting && isOfficialMode() && !order.qrAvailable && Boolean(order.payUrl);
  $('scan-hint').textContent = isOfficialMode()
    ? (order.qrAvailable
        ? '请使用手机打开支付宝，扫描二维码完成支付'
        : order.payUrl
          ? '支付页面已在新窗口打开，请完成支付后返回此页面'
          : '该订单的支付凭据已失效，请取消后重新创建。')
    : isPersonalAutoMode()
      ? (order.qrAvailable
          ? '打开支付宝扫一扫，确认金额和自动备注均未被修改后完成付款。'
          : '正在通过受控设备生成本单支付宝收钱码。')
      : isAccountLogStaticMode()
        ? '打开支付宝扫一扫，在付款页准确输入本单应付金额；请在倒计时结束前完成付款。'
      : '打开支付宝扫一扫，完成后在下方填写账单中的交易号。';
  $('countdown-hint').textContent = isAutomaticMode() ? '等待到账自动确认...' : '订单过期后请勿继续付款';
  startCountdown(order);
  if (awaiting && order.qrAvailable && (forceQr || previousId !== order.id || previousStatus !== order.status || !state.qrBlobUrl)) {
    await loadQr(order);
  } else if (awaiting && !order.qrAvailable && !order.payUrl) {
    await loadQr(order);
  } else if (awaiting && !order.qrAvailable && state.qrBlobUrl) {
    URL.revokeObjectURL(state.qrBlobUrl);
    state.qrBlobUrl = null;
    $('payment-qr').removeAttribute('src');
    $('payment-qr').hidden = true;
    $('alipay-mark').hidden = true;
  } else if (!awaiting && state.qrBlobUrl) {
    URL.revokeObjectURL(state.qrBlobUrl);
    state.qrBlobUrl = null;
    $('payment-qr').removeAttribute('src');
    $('payment-qr').hidden = true;
    $('alipay-mark').hidden = true;
  }
}

async function loadOrders(options = {}) {
  const previousOrder = state.activeOrder;
  const data = await api('/api/orders');
  state.orders = data.items || [];
  const activeOrder = activeOrderFromList();
  if (activeOrder) {
    state.settledOrder = null;
  } else if (previousOrder && ['awaiting_payment', 'payment_reported', 'fulfilling', 'needs_attention'].includes(previousOrder.status)) {
    const updatedOrder = state.orders.find((order) => order.id === previousOrder.id);
    if (updatedOrder?.status === 'completed') {
      state.settledOrder = updatedOrder;
      await refreshCurrentUser(updatedOrder).catch(() => {});
      toast('充值已完成，额度已到账', 'success');
    } else if (['cancelled', 'expired', 'failed'].includes(updatedOrder?.status)) {
      state.settledOrder = updatedOrder;
    } else if (updatedOrder?.status === 'rejected') {
      toast('该订单未通过到账核验，请查看充值记录', 'error');
    } else if (updatedOrder?.status === 'expired') {
      toast('订单已过期，请勿继续付款', 'warning');
    }
  }
  renderHistory();
  await renderActiveOrder(activeOrder || state.settledOrder, options.forceQr);
  refreshIcons();
}

async function refreshCurrentUser(completedOrder) {
  if (isOfficialMode()) {
    state.session = await api('/api/auth/refresh', { method: 'POST', mutation: true, body: '{}' });
  } else {
    const currentBalance = Number(state.session?.user?.balance);
    const creditedAmount = Number(completedOrder?.creditAmount);
    if (Number.isFinite(currentBalance) && Number.isFinite(creditedAmount)) {
      state.session.user.balance = currentBalance + creditedAmount;
    }
  }
  $('recharge-balance').textContent = formatMoney(state.session?.user?.balance);
}

async function handleLogin(event) {
  event.preventDefault();
  setError('login-error');
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  setButtonLoading(button, true, '登录中');
  try {
    const data = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: form.elements.email.value, password: form.elements.password.value })
    });
    form.elements.password.value = '';
    if (data.requires2fa) {
      state.loginChallenge = data.challengeId;
      $('two-factor-account').textContent = data.emailMasked;
      form.hidden = true;
      $('two-factor-form').hidden = false;
      $('two-factor-form').elements.totpCode.focus();
      return;
    }
    acceptSession(data);
  } catch (error) {
    setError('login-error', error.message);
  } finally {
    setButtonLoading(button, false);
  }
}

async function handleTwoFactor(event) {
  event.preventDefault();
  setError('two-factor-error');
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  setButtonLoading(button, true, '验证中');
  try {
    const data = await api('/api/auth/login/2fa', {
      method: 'POST',
      body: JSON.stringify({ challengeId: state.loginChallenge, totpCode: form.elements.totpCode.value })
    });
    acceptSession(data);
  } catch (error) {
    setError('two-factor-error', error.message);
  } finally {
    setButtonLoading(button, false);
  }
}

function acceptSession(data) {
  state.session = data;
  showApp();
  initializeAuthenticatedView();
}

async function initializeAuthenticatedView() {
  try {
    await loadCheckout();
  } catch (error) {
    setError('create-order-error', error.message);
    toast(error.message, 'error');
  }
  try {
    await loadOrders({ forceQr: true });
    if (isManualAdmin()) await loadAdminSummary();
  } catch (error) {
    toast(error.message, 'error');
  }
  startPolling();
}

async function handleLogout() {
  try {
    await api('/api/auth/logout', { method: 'POST', mutation: true, body: '{}' });
  } catch {}
  clearSession();
  showLogin();
}

async function createOrder(event) {
  event.preventDefault();
  setError('create-order-error');
  const validationError = amountValidationMessage(Number(state.selectedAmount || 0));
  if (!state.checkout || !state.selectedAmount || validationError) {
    setError('create-order-error', validationError || '请输入有效的充值金额');
    return;
  }
  const button = event.currentTarget.querySelector('button[type="submit"]');
  setButtonLoading(button, true, '创建中');
  try {
    await api('/api/orders', {
      method: 'POST', mutation: true, body: JSON.stringify({ amount: state.selectedAmount })
    });
    await loadOrders({ forceQr: true });
  } catch (error) {
    setError('create-order-error', error.message);
  } finally {
    setButtonLoading(button, false);
    updateCreditPreview();
  }
}

async function reportPayment(event) {
  event.preventDefault();
  setError('report-payment-error');
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  setButtonLoading(button, true, '提交中');
  try {
    await api(`/api/orders/${encodeURIComponent(state.activeOrder.id)}/report-payment`, {
      method: 'POST', mutation: true, body: JSON.stringify({ tradeNo: form.elements.tradeNo.value })
    });
    form.reset();
    await loadOrders();
    toast('付款信息已提交，请等待账单核验', 'success');
  } catch (error) {
    setError('report-payment-error', error.message);
  } finally {
    form.elements.tradeNo.value = '';
    setButtonLoading(button, false);
  }
}

async function cancelOrder() {
  if (!state.activeOrder) return;
  const confirmed = await askConfirmation(isAutomaticMode()
    ? '取消后该订单将停止自动放款。若已经完成付款，请不要取消，并等待到账确认。'
    : '取消后当前收款金额将立即失效。若已经完成付款，请不要取消，请提交支付宝交易号。', {
    title: '取消付款订单',
    confirmLabel: '确认取消',
    danger: true
  });
  if (!confirmed) return;
  const button = $('cancel-order');
  setButtonLoading(button, true, '取消中');
  try {
    await api(`/api/orders/${encodeURIComponent(state.activeOrder.id)}/cancel`, {
      method: 'POST', mutation: true, body: '{}'
    });
    await loadOrders();
    toast('订单已取消', 'info');
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    setButtonLoading(button, false);
  }
}

async function copyText(value, message) {
  try {
    await navigator.clipboard.writeText(String(value));
    toast(message, 'success');
  } catch {
    toast('复制失败，请手动选择', 'error');
  }
}

function downloadQr() {
  if (!state.qrBlobUrl || !state.activeOrder) return;
  const link = document.createElement('a');
  link.href = state.qrBlobUrl;
  link.download = `alipay-${state.activeOrder.orderNo}.png`;
  link.click();
}

function openPayUrl() {
  const url = state.activeOrder?.payUrl;
  if (!url) return;
  const link = document.createElement('a');
  link.href = url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function switchView(view) {
  if (view === 'admin' && !isManualAdmin()) view = 'recharge';
  document.querySelectorAll('.nav-item').forEach((node) => node.classList.toggle('active', node.dataset.view === view));
  $('recharge-view').hidden = view !== 'recharge';
  $('admin-view').hidden = view !== 'admin';
  $('header-page-title').textContent = view === 'admin' ? '到账审核' : '充值中心';
  $('header-page-description').textContent = view === 'admin'
    ? '核验支付宝账单并执行额度入账'
    : '通过支付宝为当前账户充值';
  document.body.classList.remove('mobile-sidebar-open');
  $('mobile-sidebar-backdrop').hidden = true;
  if (view === 'admin') loadAdminOrders().catch((error) => toast(error.message, 'error'));
}

async function loadAdminSummary() {
  const stats = await api('/api/admin/stats');
  const pending = stats.payment_reported?.count || 0;
  $('review-count').hidden = pending === 0;
  $('review-count').textContent = String(pending);
  $('admin-metrics').innerHTML = [
    ['pending', '待核验', pending],
    ['attention', '需恢复', stats.needs_attention?.count || 0],
    ['completed', '累计完成', stats.completed?.count || 0]
  ].map(([kind, label, value]) => `<div class="metric ${kind}"><span>${label}</span><strong>${value}</strong></div>`).join('');
}

async function loadAdminOrders() {
  const status = $('admin-status-filter').value;
  const query = new URLSearchParams({ status, page: String(state.adminPage), pageSize: String(state.adminPageSize) });
  const data = await api(`/api/admin/orders?${query}`);
  state.adminOrders = data.items || [];
  state.adminTotal = data.total || 0;
  const pages = Math.max(1, Math.ceil(state.adminTotal / state.adminPageSize));
  $('admin-page').textContent = `${state.adminPage} / ${pages}`;
  $('admin-previous').disabled = state.adminPage <= 1;
  $('admin-next').disabled = state.adminPage >= pages;
  $('admin-orders').innerHTML = state.adminOrders.length ? state.adminOrders.map((order) => {
    let actions = '';
    if (order.status === 'payment_reported') {
      actions = `<button class="button primary compact" type="button" data-admin-action="review" data-id="${escapeHtml(order.id)}">${icon('badge-check')}<span>核验</span></button>
        <button class="button danger-quiet compact" type="button" data-admin-action="reject" data-id="${escapeHtml(order.id)}">${icon('circle-x')}<span>拒绝</span></button>`;
    } else if (order.status === 'needs_attention') {
      actions = `<button class="button primary compact" type="button" data-admin-action="retry" data-id="${escapeHtml(order.id)}">${icon('rotate-ccw')}<span>恢复入账</span></button>`;
    } else {
      actions = `<button class="button secondary compact" type="button" data-admin-action="details" data-id="${escapeHtml(order.id)}">${icon('list')}<span>详情</span></button>`;
    }
    return `<tr>
      <td><code>${escapeHtml(order.orderNo)}</code></td>
      <td>${escapeHtml(order.userEmailMasked)}<br><small>ID ${escapeHtml(order.userId)}</small></td>
      <td>¥${escapeHtml(formatMoney(order.payableAmount))}</td>
      <td>${escapeHtml(order.tradeLast6 || '-')}</td>
      <td><span class="status-badge ${escapeHtml(order.status)}">${escapeHtml(statusLabel(order.status))}</span></td>
      <td>${escapeHtml(formatDate(order.paymentReportedAt || order.createdAt))}</td>
      <td><div class="table-actions">${actions}</div></td>
    </tr>`;
  }).join('') : '<tr><td class="empty-row" colspan="7">当前筛选下没有订单</td></tr>';
  await loadAdminSummary();
  refreshIcons();
}

function renderReviewDetails(data) {
  const order = data.order;
  $('review-order-no').textContent = order.orderNo;
  $('review-facts').innerHTML = [
    ['用户', `${order.userEmailMasked} · ID ${order.userId}`],
    ['应付金额', `¥${formatMoney(order.payableAmount)}`],
    ['入账额度', `¥${formatMoney(order.creditAmount)}`],
    ['支付凭证尾号', order.tradeLast6 || '-'],
    ['有效付款时段', `${formatDateTime(order.createdAt)} 至 ${formatDateTime(order.expiresAt)}`],
    ['付款提交', formatDate(order.paymentReportedAt)],
    ['当前状态', statusLabel(order.status)]
  ].map(([label, value]) => `<div class="fact"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join('');
  $('review-events').innerHTML = `<h3>审计轨迹</h3>${(data.events || []).map((event) => `
    <div class="audit-event"><span>${escapeHtml(formatDate(event.occurredAt))}</span><strong>${escapeHtml(event.eventType)}</strong></div>
  `).join('') || '<div class="audit-event"><span>-</span><strong>暂无事件</strong></div>'}`;
  const form = $('review-confirm-form');
  form.elements.orderId.value = order.id;
  form.elements.paidAmount.value = formatMoney(order.payableAmount);
  form.elements.paidAt.value = '';
  form.elements.tradeNo.value = '';
  form.elements.acknowledge.checked = false;
  form.hidden = order.status !== 'payment_reported';
  setError('review-error');
  refreshIcons();
}

async function openReview(orderId, detailsOnly = false) {
  const data = await api(`/api/admin/orders/${encodeURIComponent(orderId)}`);
  renderReviewDetails(data);
  if (detailsOnly) $('review-confirm-form').hidden = true;
  openModal($('review-dialog'));
}

async function handleAdminAction(event) {
  const button = event.target.closest('[data-admin-action]');
  if (!button) return;
  const { adminAction: action, id } = button.dataset;
  if (action === 'review') return openReview(id);
  if (action === 'details') return openReview(id, true);
  if (action === 'reject') {
    const order = state.adminOrders.find((item) => item.id === id);
    $('reject-form').elements.orderId.value = id;
    $('reject-order-no').textContent = order?.orderNo || '';
    setError('reject-error');
    openModal($('reject-dialog'));
    return;
  }
  if (action === 'retry') {
    const confirmed = await askConfirmation('系统将复用该订单的原兑换码发起幂等恢复。请先确认没有对该用户执行过手工加款。', {
      title: '恢复额度入账',
      confirmLabel: '确认恢复'
    });
    if (!confirmed) return;
    setButtonLoading(button, true, '恢复中');
    try {
      await api(`/api/admin/orders/${encodeURIComponent(id)}/retry`, { method: 'POST', mutation: true, body: '{}' });
      toast('入账已恢复并完成', 'success');
      await Promise.all([loadAdminOrders(), loadOrders()]);
    } catch (error) {
      toast(error.message, 'error');
      await loadAdminOrders();
    } finally {
      setButtonLoading(button, false);
    }
  }
}

async function confirmReview(event) {
  event.preventDefault();
  setError('review-error');
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  setButtonLoading(button, true, '入账中');
  try {
    const paidAt = new Date(form.elements.paidAt.value);
    if (Number.isNaN(paidAt.getTime())) throw new Error('请输入支付宝账单中的有效付款时间');
    await api(`/api/admin/orders/${encodeURIComponent(form.elements.orderId.value)}/confirm`, {
      method: 'POST', mutation: true, body: JSON.stringify({
        paidAmount: form.elements.paidAmount.value,
        paidAt: paidAt.toISOString(),
        tradeNo: form.elements.tradeNo.value,
        acknowledge: form.elements.acknowledge.checked
      })
    });
    form.elements.tradeNo.value = '';
    closeModal($('review-dialog'));
    toast('到账核验通过，额度已入账', 'success');
    await Promise.all([loadAdminOrders(), loadOrders()]);
  } catch (error) {
    form.elements.tradeNo.value = '';
    setError('review-error', error.message);
    await loadAdminSummary().catch(() => {});
  } finally {
    setButtonLoading(button, false);
  }
}

async function rejectOrder(event) {
  event.preventDefault();
  setError('reject-error');
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  setButtonLoading(button, true, '处理中');
  try {
    await api(`/api/admin/orders/${encodeURIComponent(form.elements.orderId.value)}/reject`, {
      method: 'POST', mutation: true, body: JSON.stringify({ reason: form.elements.reason.value })
    });
    closeModal($('reject-dialog'));
    toast('订单已拒绝', 'info');
    await Promise.all([loadAdminOrders(), loadOrders()]);
  } catch (error) {
    setError('reject-error', error.message);
  } finally {
    setButtonLoading(button, false);
  }
}

function startPolling() {
  clearInterval(state.pollTimer);
  state.pollTimer = setInterval(() => {
    if (document.hidden || !state.session) return;
    loadOrders().catch(() => {});
    if (isManualAdmin() && !$('admin-view').hidden) loadAdminOrders().catch(() => {});
  }, isAutomaticMode() ? 3000 : 10000);
}

function bindEvents() {
  $('loading-retry').addEventListener('click', bootstrap);
  $('login-form').addEventListener('submit', handleLogin);
  $('two-factor-form').addEventListener('submit', handleTwoFactor);
  $('two-factor-cancel').addEventListener('click', () => {
    state.loginChallenge = null;
    $('two-factor-form').reset();
    $('two-factor-form').hidden = true;
    $('login-form').hidden = false;
  });
  $('logout-button').addEventListener('click', handleLogout);
  $('create-order-form').addEventListener('submit', createOrder);
  $('amount-options').addEventListener('click', (event) => {
    const button = event.target.closest('[data-amount]');
    if (!button) return;
    state.selectedAmount = Number(button.dataset.amount);
    state.customAmountText = String(state.selectedAmount);
    $('custom-amount').value = state.customAmountText;
    renderAmountOptions();
  });
  $('custom-amount').addEventListener('input', (event) => {
    const input = event.currentTarget;
    const value = input.value;
    if (!/^\d*(?:\.\d{0,2})?$/.test(value)) {
      input.value = state.customAmountText;
      return;
    }
    state.customAmountText = value;
    const amount = value === '' ? null : Number.parseFloat(value);
    state.selectedAmount = Number.isFinite(amount) && amount > 0 ? amount : null;
    renderAmountOptions();
  });
  $('report-payment-form').addEventListener('submit', reportPayment);
  $('cancel-order').addEventListener('click', cancelOrder);
  $('download-qr').addEventListener('click', downloadQr);
  $('open-pay-url').addEventListener('click', openPayUrl);
  $('copy-order-no').addEventListener('click', () => copyText(state.activeOrder?.orderNo, '订单号已复制'));
  $('copy-payable').addEventListener('click', () => copyText(formatMoney(state.activeOrder?.payableAmount), '应付金额已复制'));
  $('refresh-orders').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    setButtonLoading(button, true);
    try {
      await loadOrders({ forceQr: true });
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      setButtonLoading(button, false);
    }
  });
  document.querySelectorAll('.nav-item').forEach((button) => button.addEventListener('click', () => switchView(button.dataset.view)));
  $('admin-status-filter').addEventListener('change', () => { state.adminPage = 1; loadAdminOrders().catch((error) => toast(error.message, 'error')); });
  $('refresh-admin').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    setButtonLoading(button, true);
    try {
      await loadAdminOrders();
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      setButtonLoading(button, false);
    }
  });
  $('admin-orders').addEventListener('click', (event) => handleAdminAction(event).catch((error) => toast(error.message, 'error')));
  $('admin-previous').addEventListener('click', () => { state.adminPage -= 1; loadAdminOrders().catch(() => {}); });
  $('admin-next').addEventListener('click', () => { state.adminPage += 1; loadAdminOrders().catch(() => {}); });
  $('review-confirm-form').addEventListener('submit', confirmReview);
  $('reject-form').addEventListener('submit', rejectOrder);
  document.querySelectorAll('#completed-done, [data-result-done]').forEach((button) => button.addEventListener('click', () => {
    state.settledOrder = null;
    renderActiveOrder(null);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }));
  document.querySelectorAll('[data-close-dialog]').forEach((button) => {
    button.addEventListener('click', () => closeModal(button.closest('dialog')));
  });
  document.querySelectorAll('.modal-dialog').forEach((dialog) => {
    dialog.addEventListener('close', updateModalLock);
  });
  $('confirm-accept').addEventListener('click', () => resolveConfirmation(true));
  document.querySelectorAll('[data-confirm-cancel]').forEach((button) => {
    button.addEventListener('click', () => resolveConfirmation(false));
  });
  $('confirm-dialog').addEventListener('cancel', (event) => {
    event.preventDefault();
    resolveConfirmation(false);
  });
  $('theme-toggle').addEventListener('click', () => {
    applyTheme(state.theme === 'dark' ? 'light' : 'dark', true);
    refreshIcons();
  });
  $('sidebar-collapse').addEventListener('click', () => {
    document.body.classList.toggle('sidebar-collapsed');
    try {
      window.localStorage.setItem('recharge-center-sidebar-collapsed', document.body.classList.contains('sidebar-collapsed') ? '1' : '0');
    } catch {}
  });
  $('mobile-menu-toggle').addEventListener('click', () => {
    document.body.classList.add('mobile-sidebar-open');
    $('mobile-sidebar-backdrop').hidden = false;
  });
  $('mobile-sidebar-backdrop').addEventListener('click', () => {
    document.body.classList.remove('mobile-sidebar-open');
    $('mobile-sidebar-backdrop').hidden = true;
  });
  window.addEventListener('beforeunload', () => {
    if (state.qrBlobUrl) URL.revokeObjectURL(state.qrBlobUrl);
  });
}

async function bootstrap() {
  showLoading();
  applyTheme(state.theme);
  if (!state.embedded) {
    try {
      document.body.classList.toggle('sidebar-collapsed', window.localStorage.getItem('recharge-center-sidebar-collapsed') === '1');
    } catch {}
  }
  refreshIcons();
  try {
    state.config = await api('/api/config', { signal: AbortSignal.timeout(15000) });
    renderAmountOptions();
    renderLoginMode();
  } catch (error) {
    showLoadingError(error);
    return;
  }
  try {
    state.session = await api('/api/auth/me', { signal: AbortSignal.timeout(15000) });
  } catch (error) {
    if (error.status === 401 || error.status === 403) showLogin();
    else showLoadingError(error);
    refreshIcons();
    return;
  }
  showApp();
  await initializeAuthenticatedView();
  refreshIcons();
}

bindEvents();
bootstrap();

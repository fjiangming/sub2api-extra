(function (root) {
  'use strict';

  function create({ api, escapeHtml: esc, icon, refreshIcons, toast, setPageMeta, isActive }) {
    const $ = (id) => document.getElementById(id);
    const form = $('um-form');
    let items = [], users = [], selected = null, editing = null, pending = null;
    let page = 1, total = 0, deliveryEnabled = false, busy = false;
    let listSequence = 0, searchSequence = 0, previewSequence = 0, searchTimer = null;
    let requestKey = '', markdownPromise = null;
    const dateTime = (value) => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '';
    const error = (id, message = '') => { $(id).textContent = message; $(id).hidden = !message; };
    const userLabel = (user) => `${user.email || user.username || '用户'} · ID ${user.id}`;
    const inputTime = (value) => {
      if (!value) return '';
      const date = new Date(value);
      return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    };
    const status = (item) => item.status === 'draft' ? ['草稿', 'neutral']
      : item.status === 'archived' ? ['已撤回', 'neutral']
      : item.endsAt && Date.parse(item.endsAt) <= Date.now() ? ['已过期', 'neutral']
      : item.startsAt && Date.parse(item.startsAt) > Date.now() ? ['待生效', 'warning'] : ['已发布', 'success'];
    const action = (name, label, id, danger = false) => `<button type="button" class="table-icon-button${danger ? ' danger-text' : ''}" data-action="${name}" data-id="${id}" title="${label}" aria-label="${label}">${icon(name === 'preview' ? 'eye' : name === 'edit' ? 'pencil' : name === 'archive' ? 'archive' : 'trash-2')}</button>`;

    async function markdown(node, content) {
      const sequence = ++previewSequence;
      node.textContent = '正在生成预览…';
      try {
        markdownPromise ||= import('/vendor/marked.js');
        const { marked } = await markdownPromise;
        const html = marked.parse(content || '', { gfm: true, breaks: true });
        if (sequence !== previewSequence) return;
        node.innerHTML = root.DOMPurify.sanitize(html, {
          FORBID_TAGS: ['style', 'form', 'iframe', 'button'], FORBID_ATTR: ['style', 'id', 'name']
        });
        node.querySelectorAll('a').forEach((link) => { link.target = '_blank'; link.rel = 'noopener noreferrer'; });
      } catch {
        markdownPromise = null;
        if (sequence === previewSequence) node.textContent = '预览暂时不可用';
      }
    }

    function renderList() {
      $('um-list').innerHTML = items.map((item) => {
        const [label, tone] = status(item);
        return `<tr><td><strong>${esc(item.title)}</strong><small>${item.startsAt ? esc(dateTime(item.startsAt)) : '立即生效'}${item.endsAt ? ` 至 ${esc(dateTime(item.endsAt))}` : ''}</small></td>
          <td><strong>${esc(item.recipient.email || item.recipient.username || '用户')}</strong><small>${esc(item.recipient.username)} · ID ${item.userId}</small></td>
          <td><span class="badge ${tone}">${label}</span></td><td>${item.notifyMode === 'popup' ? '强制弹窗' : '仅消息列表'}</td>
          <td>${item.readAt ? `<span class="badge success">已读</span><small>${esc(dateTime(item.readAt))}</small>` : `<span class="badge neutral">${item.status === 'draft' ? '未发送' : '未读'}</span>`}</td>
          <td>${esc(dateTime(item.createdAt))}</td><td class="table-actions">${action('preview', '查看消息', item.id)}${action('edit', '编辑消息', item.id)}${item.status === 'active' ? action('archive', '撤回消息', item.id) : ''}${action('delete', '删除消息', item.id, true)}</td></tr>`;
      }).join('') || '<tr><td colspan="7" class="empty-state">暂无消息</td></tr>';
      $('um-pagination').textContent = `共 ${total} 条 · 第 ${page} / ${Math.max(1, Math.ceil(total / 20))} 页`;
      $('um-prev').disabled = page <= 1;
      $('um-next').disabled = page * 20 >= total;
      refreshIcons();
    }

    async function load() {
      const sequence = ++listSequence;
      error('um-error');
      setPageMeta('正在读取消息');
      try {
        const filter = $('um-filter').elements;
        const query = new URLSearchParams({ search: filter.search.value.trim(), status: filter.status.value, page: String(page) });
        const [settings, result] = await Promise.all([api('/api/user-messages/status'), api(`/api/user-messages?${query}`)]);
        if (sequence !== listSequence || !isActive()) return;
        deliveryEnabled = settings.deliveryEnabled;
        $('um-delivery-notice').hidden = deliveryEnabled;
        $('um-send').disabled = !deliveryEnabled;
        items = result.items;
        total = result.total;
        if (!items.length && page > 1) { page = Math.max(1, Math.ceil(total / 20)); return load(); }
        renderList();
        setPageMeta(`${total} 条消息`);
      } catch (cause) {
        if (sequence !== listSequence || !isActive()) return;
        items = [];
        $('um-list').innerHTML = '<tr><td colspan="7" class="empty-state">消息加载失败</td></tr>';
        error('um-error', cause.message);
        throw cause;
      }
    }

    function showRecipient() {
      const node = $('um-recipient');
      node.hidden = !selected;
      node.innerHTML = selected ? `<strong>${esc(selected.email || selected.username || '用户')}</strong><span>${esc(selected.username)} · ID ${selected.id}</span>${!editing ? `<button id="um-change-recipient" class="icon-button" type="button" title="更换收件人" aria-label="更换收件人">${icon('user-round-pen')}</button>` : ''}` : '';
      $('um-recipient-search').hidden = Boolean(selected);
      $('um-recipient-search').disabled = Boolean(editing);
      $('um-recipients').innerHTML = '';
      $('um-recipient-status').textContent = '';
      refreshIcons();
    }

    function mode(value) {
      $('um-modes').querySelectorAll('button').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.mode === value)));
      $('um-content').hidden = value !== 'edit';
      $('um-toolbar').hidden = value !== 'edit';
      $('um-preview').hidden = value !== 'preview';
      if (value === 'preview') markdown($('um-preview'), form.elements.content.value);
    }

    function openEditor(item = null) {
      editing = item;
      selected = item?.recipient || null;
      users = [];
      requestKey = root.crypto.randomUUID();
      form.reset();
      $('um-editor-title').textContent = item ? '编辑消息' : '新建消息';
      form.elements.title.value = item?.title || '';
      form.elements.content.value = item?.content || '';
      form.elements.popup.checked = item?.notifyMode === 'popup';
      form.elements.startsAt.value = inputTime(item?.startsAt);
      form.elements.endsAt.value = inputTime(item?.endsAt);
      $('um-save').hidden = Boolean(item && item.status !== 'draft');
      $('um-send').querySelector('span').textContent = item?.status === 'active' ? '更新消息' : '发送消息';
      $('um-send').disabled = !deliveryEnabled;
      $('um-save-status').textContent = deliveryEnabled ? '' : '投递未启用';
      error('um-form-error');
      showRecipient();
      mode('edit');
      $('um-editor').showModal();
      (selected ? form.elements.title : $('um-recipient-search')).focus();
    }

    async function searchRecipients() {
      const search = $('um-recipient-search').value.trim();
      const sequence = ++searchSequence;
      users = [];
      $('um-recipients').innerHTML = '';
      $('um-recipient-status').textContent = search ? '正在搜索…' : '';
      if (!search) return;
      try {
        const data = await api(`/api/user-messages/users?${new URLSearchParams({ search })}`);
        if (sequence !== searchSequence || !$('um-editor').open || selected) return;
        users = data.items;
        $('um-recipient-status').textContent = users.length ? '' : '未找到匹配用户';
        $('um-recipients').innerHTML = users.map((user) => `<button class="um-user-result" type="button" data-user-id="${user.id}"><strong>${esc(user.email || user.username)}</strong><span>${esc(user.username)} · ID ${user.id}</span></button>`).join('');
      } catch (cause) {
        if (sequence === searchSequence) $('um-recipient-status').textContent = cause.message;
      }
    }

    function readInput(targetStatus) {
      if (!selected) throw new Error('请选择一位收件人');
      const value = {
        userId: selected.id, title: form.elements.title.value.trim(), content: form.elements.content.value.trim(),
        status: targetStatus, notifyMode: form.elements.popup.checked ? 'popup' : 'silent',
        startsAt: form.elements.startsAt.value ? new Date(form.elements.startsAt.value).toISOString() : null,
        endsAt: form.elements.endsAt.value ? new Date(form.elements.endsAt.value).toISOString() : null
      };
      if (!value.title || !value.content) throw new Error('请输入消息标题和正文');
      if (value.startsAt && value.endsAt && value.startsAt >= value.endsAt) throw new Error('结束时间必须晚于开始时间');
      if (targetStatus === 'active' && value.endsAt && Date.parse(value.endsAt) <= Date.now()) throw new Error('结束时间必须晚于当前时间');
      return value;
    }

    function setBusy(value) {
      busy = value;
      form.querySelectorAll('button, input, textarea').forEach((control) => { control.disabled = value; });
      if (!value) { $('um-send').disabled = !deliveryEnabled; $('um-recipient-search').disabled = Boolean(editing); }
      $('um-editor-close').disabled = value;
      $('um-confirm-submit').disabled = value;
      $('um-confirm-cancel').disabled = value;
      $('um-confirm-close').disabled = value;
    }

    async function save(value) {
      if (busy) return;
      setBusy(true);
      error('um-form-error');
      error('um-confirm-error');
      try {
        await api(editing ? `/api/user-messages/${editing.id}` : '/api/user-messages', {
          method: editing ? 'PUT' : 'POST', headers: { 'idempotency-key': requestKey }, body: JSON.stringify(value)
        });
        $('um-confirm').close();
        $('um-editor').close();
        toast(value.status === 'draft' ? '草稿已保存' : value.startsAt && Date.parse(value.startsAt) > Date.now() ? '消息已安排发送' : '消息已发布');
      } catch (cause) {
        error($('um-confirm').open ? 'um-confirm-error' : 'um-form-error', cause.message);
        return;
      } finally {
        setBusy(false);
      }
      try { await load(); } catch { toast('消息已保存，列表刷新失败，请手动刷新', 'error'); }
    }

    function confirmAction(title, description, label, operation, item = null) {
      pending = operation;
      $('um-confirm-title').textContent = title;
      $('um-confirm-description').textContent = description;
      $('um-confirm-subject').textContent = item?.title || '';
      $('um-confirm-content').textContent = '';
      $('um-confirm-submit').hidden = !operation;
      $('um-confirm-submit').querySelector('span').textContent = label;
      $('um-confirm-cancel').textContent = operation ? '取消' : '关闭';
      error('um-confirm-error');
      $('um-confirm').showModal();
      if (item) markdown($('um-confirm-content'), item.content);
    }

    async function mutate(item, kind) {
      if (busy) return;
      setBusy(true);
      error('um-confirm-error');
      try {
        await api(`/api/user-messages/${item.id}${kind === 'archive' ? '/archive' : ''}`, { method: kind === 'archive' ? 'POST' : 'DELETE' });
        $('um-confirm').close();
        toast(kind === 'archive' ? '消息已撤回' : '消息已删除');
      } catch (cause) {
        error('um-confirm-error', cause.message);
        return;
      } finally { setBusy(false); }
      try { await load(); } catch { toast('操作已完成，列表刷新失败，请手动刷新', 'error'); }
    }

    $('um-filter').addEventListener('submit', (event) => { event.preventDefault(); page = 1; load().catch((cause) => toast(cause.message, 'error')); });
    $('um-new').addEventListener('click', () => openEditor());
    $('um-prev').addEventListener('click', () => { page--; load().catch((cause) => toast(cause.message, 'error')); });
    $('um-next').addEventListener('click', () => { page++; load().catch((cause) => toast(cause.message, 'error')); });
    $('um-editor-close').addEventListener('click', () => { if (!busy) $('um-editor').close(); });
    for (const id of ['um-confirm-close', 'um-confirm-cancel']) $(id).addEventListener('click', () => { if (!busy) $('um-confirm').close(); });
    for (const id of ['um-editor', 'um-confirm']) $(id).addEventListener('cancel', (event) => { if (busy) event.preventDefault(); });
    $('um-editor').addEventListener('close', () => { searchSequence++; previewSequence++; clearTimeout(searchTimer); });
    $('um-recipient-search').addEventListener('input', () => {
      searchSequence++;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(searchRecipients, 300);
    });
    $('um-recipient-search').addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); clearTimeout(searchTimer); searchRecipients(); } });
    $('um-recipients').addEventListener('click', (event) => {
      const button = event.target.closest('[data-user-id]');
      if (!button) return;
      selected = users.find((user) => user.id === Number(button.dataset.userId));
      searchSequence++;
      showRecipient();
    });
    $('um-recipient').addEventListener('click', (event) => {
      if (!event.target.closest('#um-change-recipient')) return;
      selected = null;
      $('um-recipient-search').value = '';
      showRecipient();
      $('um-recipient-search').focus();
    });
    $('um-modes').addEventListener('click', (event) => { const button = event.target.closest('[data-mode]'); if (button) mode(button.dataset.mode); });
    $('um-toolbar').addEventListener('click', (event) => {
      const button = event.target.closest('[data-format]');
      if (!button) return;
      const input = $('um-content'), start = input.selectionStart, end = input.selectionEnd;
      const selection = input.value.slice(start, end) || '文字';
      const formats = { bold: ['**', '**'], italic: ['*', '*'], heading: ['\n## ', '\n'], list: ['\n- ', '\n'], quote: ['\n> ', '\n'], link: ['[', '](https://)'], code: ['\n```\n', '\n```\n'] };
      const [prefix, suffix] = formats[button.dataset.format];
      input.setRangeText(`${prefix}${selection}${suffix}`, start, end, 'select');
      input.focus();
    });
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (busy) return;
      error('um-form-error');
      try {
        const value = readInput(event.submitter?.value || (editing?.status === 'active' ? 'active' : 'draft'));
        if (value.status === 'draft') { save(value); return; }
        confirmAction(editing?.status === 'active' ? '确认更新消息' : '确认发送消息',
          `收件人：${userLabel(selected)}${value.notifyMode === 'popup' ? ' · 强制弹窗' : ''}${value.startsAt ? ` · ${dateTime(value.startsAt)} 生效` : ' · 立即生效'}`,
          editing?.status === 'active' ? '确认更新' : '确认发送', () => save(value), value);
      } catch (cause) { error('um-form-error', cause.message); }
    });
    $('um-confirm-submit').addEventListener('click', () => { if (!busy) pending?.(); });
    $('um-list').addEventListener('click', (event) => {
      const button = event.target.closest('[data-action]');
      if (!button) return;
      const item = items.find((item) => item.id === Number(button.dataset.id));
      if (!item) return;
      if (button.dataset.action === 'edit') { openEditor(item); return; }
      if (button.dataset.action === 'preview') {
        confirmAction('消息详情', `${userLabel(item.recipient)} · ${item.readAt ? `已读于 ${dateTime(item.readAt)}` : '未读'}`, '', null, item);
        return;
      }
      const archive = button.dataset.action === 'archive';
      confirmAction(archive ? '撤回消息' : '删除消息', `${userLabel(item.recipient)} · ${archive ? '撤回后不再展示此消息。' : '删除后消息与阅读记录无法恢复。'}`,
        archive ? '确认撤回' : '确认删除', () => mutate(item, button.dataset.action), item);
    });

    function leave() {
      listSequence++;
      searchSequence++;
      previewSequence++;
      clearTimeout(searchTimer);
      $('um-editor').close();
      $('um-confirm').close();
    }

    function reset() {
      leave();
      items = []; users = []; selected = null; editing = null; pending = null;
      page = 1; total = 0; deliveryEnabled = false;
      form.reset();
      $('um-list').innerHTML = '';
      $('um-preview').textContent = '';
      $('um-confirm-content').textContent = '';
      $('um-recipient').textContent = '';
      $('um-recipients').textContent = '';
    }

    return { load, leave, reset };
  }

  root.UserMessagesUi = { create };
})(window);

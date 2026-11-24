'use strict';

(() => {
  const prizes = [50,100,200,300,500,1000,2000,5000];
  const labels = new Map([[50,'¥0.5'],[100,'¥1'],[200,'¥2'],[300,'¥3'],[500,'¥5'],[1000,'¥10'],[2000,'¥20'],[5000,'¥50']]);
  let ctx = null; let profiles = []; let grantsPage = 1; let loaded = false;
  const $ = id => document.getElementById(id);
  const esc = value => ctx.escapeHtml(value);
  const money = cents => '¥' + (cents / 100).toLocaleString('zh-CN',{ minimumFractionDigits: 2,maximumFractionDigits: 2 });
  const setError = message => { $('compensation-error').textContent = message || ''; $('compensation-error').hidden = !message; };
  const feedback = (id,message,error = false) => { const target = $(id); target.textContent = message || ''; target.className = `feedback${error ? ' error' : ''}`; };
  const localDate = value => value ? ctx.time(value) : '永久';
  const profileWeights = profile => new Map((profile?.weights || []).map(item => [item.amountMinor,item.weight]));

  function profileInputs() {
    return prizes.map(amountMinor => ({ amountMinor, weight: Math.round((Number(document.querySelector(`[data-profile-amount="${amountMinor}"]`)?.value) || 0) * 100) }));
  }
  function updateTotal() {
    const total = profileInputs().reduce((sum,item) => sum + item.weight,0);
    const label = $('comp-profile-total');
    const percent = total / 100;
    label.textContent = `总概率 ${percent.toLocaleString('zh-CN',{ maximumFractionDigits: 2 })}%`;
    label.className = Math.abs(total - 10000) < .01 ? 'total-good' : 'total-bad';
  }
  function renderProfileForm(profile) {
    const weights = profileWeights(profile);
    $('comp-profile-id').value = profile?.id || '';
    $('comp-profile-name').value = profile?.name || '';
    $('comp-profile-status').value = profile?.status || 'enabled';
    $('comp-profile-rows').innerHTML = prizes.map(amount => `<tr><td><strong>${labels.get(amount)}</strong></td><td><div class="percent-input"><input type="number" min="0" max="100" step="0.01" value="${(weights.get(amount) || 0) / 100}" data-profile-amount="${amount}"><span>%</span></div></td><td class="muted">不适用</td><td>补偿奖项</td></tr>`).join('');
    document.querySelectorAll('[data-profile-amount]').forEach(input => input.oninput = updateTotal);
    updateTotal();
  }
  function renderProfiles() {
    const enabled = profiles.filter(profile => profile.status === 'enabled');
    const select = $('comp-profile-select');
    select.innerHTML = enabled.length ? enabled.map(profile => `<option value="${esc(profile.id)}">${esc(profile.name)} · v${profile.version}</option>`).join('') : '<option value="">暂无启用方案</option>';
    select.disabled = !enabled.length;
    $('comp-profile-list').innerHTML = profiles.length ? profiles.map(profile => `<tr><td>${esc(profile.name)}<span class="row-sub">${esc(profile.id)}</span></td><td><span class="${profile.status === 'enabled' ? 'paid' : 'muted'}">${profile.status === 'enabled' ? '启用' : '停用'}</span></td><td>v${profile.version}</td><td>${esc(localDate(profile.updatedAt))}</td><td><button class="icon-button" type="button" data-edit-profile="${esc(profile.id)}" title="编辑方案" aria-label="编辑方案"><i data-lucide="pencil"></i></button></td></tr>`).join('') : '<tr><td class="empty" colspan="5">暂无概率方案</td></tr>';
    document.querySelectorAll('[data-edit-profile]').forEach(button => button.onclick = () => renderProfileForm(profiles.find(profile => profile.id === button.dataset.editProfile)));
    ctx.icons();
  }
  function renderSummary(summary) {
    $('comp-grant-count').textContent = summary.grantCount.toLocaleString('zh-CN');
    $('comp-active-count').textContent = summary.activeGrantCount.toLocaleString('zh-CN');
    $('comp-used-count').textContent = summary.usedChances.toLocaleString('zh-CN');
    $('comp-paid-total').textContent = money(summary.paidMinor);
    $('compensation-unsettled').innerHTML = `<span class="pending">补偿奖励待入账 ${summary.pendingCount} 笔</span><span class="failed">补偿奖励入账异常 ${summary.failedCount} 笔</span><span class="muted">已覆盖用户 ${summary.recipients.toLocaleString('zh-CN')} 人</span>`;
  }
  function renderGrants(data) {
    $('comp-grant-rows').innerHTML = data.rows.length ? data.rows.map(row => {
      const audience = row.audience === 'all' ? '所有用户' : `${row.selectedUsers} 个指定用户`;
      const used = `${row.usedCount.toLocaleString('zh-CN')} 次`;
      const status = row.status === 'active' ? '<span class="paid">启用中</span>' : '<span class="muted">已停用</span>';
      const action = row.status === 'active' ? `<button class="icon-button" type="button" data-disable-grant="${esc(row.id)}" title="停用发放" aria-label="停用发放"><i data-lucide="pause-circle"></i></button>` : '<span class="muted">-</span>';
      return `<tr><td>${audience}<span class="row-sub">#${esc(row.id.slice(0,8))}</span></td><td>${row.chanceCount.toLocaleString('zh-CN')} 次 / 人</td><td>${esc(row.profileName)}</td><td>${esc(localDate(row.startsAt))}<span class="row-sub">至 ${esc(localDate(row.expiresAt))}</span></td><td>${used}</td><td>${esc(row.reason)}</td><td>${status}</td><td>${action}</td></tr>`;
    }).join('') : '<tr><td class="empty" colspan="8">暂无补偿发放记录</td></tr>';
    const pages = Math.max(1,Math.ceil(data.total / data.pageSize));
    $('comp-grant-page').textContent = `${data.total} 条 · ${data.page} / ${pages}`;
    $('comp-grant-prev').disabled = data.page <= 1; $('comp-grant-next').disabled = data.page >= pages;
    document.querySelectorAll('[data-disable-grant]').forEach(button => button.onclick = async () => {
      if (!window.confirm('停用后，未使用的补偿机会将不能继续抽奖，确定停用吗？')) return;
      button.disabled = true;
      try { await ctx.api(`admin/compensation/grants/${button.dataset.disableGrant}/disable`,{ method: 'POST',body: '{}' }); await load(); }
      catch (error) { setError(error.message); button.disabled = false; }
    });
    ctx.icons();
  }
  function renderAudit(rows) {
    const names = { grant_created: '创建发放', grant_disabled: '停用发放', profile_created: '创建方案', profile_updated: '更新方案' };
    $('comp-audit-rows').innerHTML = rows.length ? rows.map(row => {
      let detail = row.detail;
      try { detail = JSON.stringify(JSON.parse(row.detail)); } catch {}
      return `<tr><td>${esc(localDate(row.createdAt))}</td><td>#${esc(row.actorId)}</td><td>${esc(names[row.action] || row.action)}</td><td>${esc(row.grantId || row.profileId || '-')}</td><td class="audit-json">${esc(detail)}</td></tr>`;
    }).join('') : '<tr><td class="empty" colspan="5">暂无操作记录</td></tr>';
  }
  async function load() {
    if (!ctx) return;
    setError('');
    try {
      const results = await Promise.all([ctx.api('admin/compensation/summary'),ctx.api('admin/compensation/profiles'),ctx.api(`admin/compensation/grants?page=${grantsPage}`),ctx.api('admin/compensation/audit')]);
      renderSummary(results[0]); profiles = results[1].profiles; renderProfiles(); renderGrants(results[2]); renderAudit(results[3].rows); loaded = true;
      if (!$('comp-profile-id').value) renderProfileForm(profiles.find(profile => profile.status === 'enabled') || profiles[0]);
      if (profiles.find(profile => profile.status === 'enabled')) $('comp-profile-select').value = profiles.find(profile => profile.status === 'enabled').id;
      ctx.icons();
    } catch (error) { setError(error.message || '补偿管理加载失败'); }
  }
  function bind() {
    document.querySelectorAll('input[name="comp-audience"]').forEach(input => input.onchange = () => {
      const selected = document.querySelector('input[name="comp-audience"]:checked')?.value === 'selected';
      $('comp-user-field').hidden = !selected;
      document.querySelectorAll('input[name="comp-audience"]').forEach(item => item.closest('.choice-card')?.classList.toggle('selected',item.checked));
    });
    $('compensation-grant-form').onsubmit = async event => {
      event.preventDefault(); feedback('comp-grant-feedback','');
      const audience = document.querySelector('input[name="comp-audience"]:checked')?.value || 'all';
      const userIds = [...new Set($('comp-user-ids').value.split(/[\s,，]+/).map(value => value.trim()).filter(Boolean))];
      if (audience === 'selected' && !userIds.length) { feedback('comp-grant-feedback','请填写至少一个用户 ID。',true); return; }
      const startsAt = $('comp-starts-at').value ? new Date($('comp-starts-at').value).toISOString() : new Date().toISOString();
      const expiresAt = $('comp-expires-at').value ? new Date($('comp-expires-at').value).toISOString() : null;
      const payload = { audience,userIds,chanceCount: Number($('comp-chance-count').value),profileId: $('comp-profile-select').value,startsAt,expiresAt,reason: $('comp-reason').value.trim() };
      try { await ctx.api('admin/compensation/grants',{ method: 'POST',body: JSON.stringify(payload) }); feedback('comp-grant-feedback',`已生成${audience === 'all' ? '全体用户' : `${userIds.length} 个指定用户`}的发放记录，补偿机会将在有效期内使用。`); $('compensation-grant-form').reset(); $('comp-user-field').hidden = true; document.querySelector('input[name="comp-audience"][value="all"]').checked = true; document.querySelector('input[name="comp-audience"][value="all"]').closest('.choice-card').classList.add('selected'); setDefaultStart(); await load(); }
      catch (error) { feedback('comp-grant-feedback',error.message,true); }
    };
    $('comp-reset-grant').onclick = () => setTimeout(() => { $('comp-user-field').hidden = true; document.querySelector('input[name="comp-audience"][value="all"]').checked = true; document.querySelectorAll('input[name="comp-audience"]').forEach(item => item.closest('.choice-card')?.classList.toggle('selected',item.checked)); setDefaultStart(); },0);
    $('comp-profile-form').onsubmit = async event => {
      event.preventDefault(); feedback('comp-profile-feedback',''); const weights = profileInputs();
      if (weights.some(item => !Number.isInteger(item.weight) || item.weight < 0) || weights.reduce((sum,item) => sum + item.weight,0) !== 10000) { feedback('comp-profile-feedback','总概率必须等于 100%。',true); return; }
      const payload = { name: $('comp-profile-name').value.trim(),status: $('comp-profile-status').value,weights };
      try { const id = $('comp-profile-id').value; await ctx.api(id ? `admin/compensation/profiles/${id}` : 'admin/compensation/profiles',{ method: 'POST',body: JSON.stringify(payload) }); feedback('comp-profile-feedback','概率方案已保存，后续发放会锁定本次方案快照。'); await load(); }
      catch (error) { feedback('comp-profile-feedback',error.message,true); }
    };
    $('new-comp-profile').onclick = () => renderProfileForm(null);
    $('refresh-compensation').onclick = load;
    $('comp-grant-prev').onclick = () => { grantsPage--; load(); };
    $('comp-grant-next').onclick = () => { grantsPage++; load(); };
  }
  function setDefaultStart() {
    const date = new Date(Date.now() - new Date().getTimezoneOffset() * 60000);
    $('comp-starts-at').value = date.toISOString().slice(0,16);
  }
  window.initCompensationAdmin = options => { ctx = options; bind(); setDefaultStart(); window.refreshCompensationAdmin = load; load(); };
})();

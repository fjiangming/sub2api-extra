'use strict';

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const icons = () => window.lucide?.createIcons({ attrs: { 'aria-hidden': 'true' } });

function setMode(mode) {
  $$('.mode-button').forEach(button => {
    const active = button.dataset.mode === mode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  });
  $('#admin-mode').hidden = mode !== 'admin';
  $('#user-mode').hidden = mode !== 'user';
}

function syncAudience() {
  const selected = $('input[name="audience"]:checked')?.value === 'selected';
  $('#selected-users').classList.toggle('visible', selected);
  $$('.choice-card').forEach(card => card.classList.toggle('selected', card.querySelector('input')?.checked));
}

function addUser(value) {
  const normalized = value.trim();
  if (!normalized) return;
  const chip = document.createElement('span');
  chip.className = 'user-chip';
  chip.dataset.user = normalized;
  chip.innerHTML = `<span>${normalized.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character])}</span><button type="button" title="移除用户" aria-label="移除用户"><i data-lucide="x"></i></button>`;
  chip.querySelector('button').onclick = () => chip.remove();
  $('#user-chips').append(chip);
  $('#user-search').value = '';
  icons();
}

function updateProbabilityTotal() {
  const total = $$('.probability-input').reduce((sum, input) => sum + (Number(input.value) || 0), 0);
  const rounded = Math.round(total * 10) / 10;
  const output = $('#probability-total');
  const valid = Math.abs(rounded - 100) < .01;
  output.textContent = `总概率 ${rounded.toLocaleString('zh-CN',{ maximumFractionDigits: 1 })}%`;
  output.className = valid ? 'total-good' : 'total-bad';
}

function bind() {
  $$('.mode-button').forEach(button => button.onclick = () => setMode(button.dataset.mode));
  $$('input[name="audience"]').forEach(input => input.onchange = syncAudience);
  $('#user-search').onkeydown = event => {
    if (event.key === 'Enter') { event.preventDefault(); addUser(event.currentTarget.value); }
  };
  $('#add-user').onclick = () => addUser($('#user-search').value);
  $$('.probability-input').forEach(input => input.oninput = updateProbabilityTotal);
  $('#grant-form').onsubmit = event => {
    event.preventDefault();
    const audience = $('input[name="audience"]:checked')?.value === 'selected' ? '指定用户' : '所有用户';
    const selected = $$('.user-chip').map(chip => chip.dataset.user);
    if (audience === '指定用户' && !selected.length) {
      $('#grant-feedback').className = 'feedback error';
      $('#grant-feedback').textContent = '请先添加至少一个指定用户。';
      return;
    }
    const count = Number($('#grant-count').value) || 0;
    $('#grant-feedback').className = 'feedback';
    $('#grant-feedback').textContent = `已生成预览：${audience}${selected.length ? `（${selected.join('、')}）` : ''}，每人增加 ${count} 次额外抽奖机会；不会写入真实数据。`;
    $('#summary-issued').textContent = (1280 + count * (selected.length || 386)).toLocaleString('zh-CN');
  };
  $('#reset-grant').onclick = () => setTimeout(() => { syncAudience(); $('#grant-feedback').textContent = ''; }, 0);
  $('#save-profile').onclick = () => {
    const feedback = $('#profile-feedback');
    if (Math.abs($$('.probability-input').reduce((sum,input) => sum + (Number(input.value) || 0),0) - 100) >= .01) {
      feedback.className = 'feedback error'; feedback.textContent = '总概率必须等于 100%，当前方案不会保存。'; return;
    }
    feedback.className = 'feedback'; feedback.textContent = `已生成“${$('#profile-name').value.trim() || '未命名方案'}”的保存预览，不会写入真实数据。`;
  };
  $('#profile-enabled').onchange = event => {
    const enabled = event.currentTarget.value === 'enabled';
    $('#profile-status').innerHTML = `<i data-lucide="${enabled ? 'radio' : 'pause-circle'}"></i>${enabled ? '启用中' : '已停用'}`;
    $('#profile-status').style.color = enabled ? 'var(--accent)' : 'var(--muted)';
    icons();
  };
  $('#refresh-records').onclick = event => {
    const button = event.currentTarget;
    button.disabled = true;
    setTimeout(() => { button.disabled = false; }, 450);
  };
  syncAudience(); updateProbabilityTotal(); icons();
}

document.addEventListener('DOMContentLoaded', bind);

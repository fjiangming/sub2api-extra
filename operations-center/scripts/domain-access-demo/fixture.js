'use strict';

(() => {
  const now = Date.parse('2026-11-13T15:00:00+08:00');
  const day = 86400000;
  const today = Date.parse('2026-11-13T00:00:00+08:00');
  const oldDomain = 'epoint2api.fjmooo.cn';
  const newDomain = 'yunhop.cc';
  const names = ['林远', '周宁', '陈予', '许澈', '苏禾', '沈一', '陆川', '顾言', '程夏', '江临', '方知', '宋亦', '叶明', '许清', '温序', '李南', '程悦', '林知', '徐安', '余可', '孟时', '季明', '何予', '唐简'];
  const handles = ['linyuan', 'zhouning', 'chenyu', 'xuche', 'suhe', 'shenyi', 'luchuan', 'guyan', 'chengxia', 'jianglin', 'fangzhi', 'songyi', 'yeming', 'xuqing', 'wenxu', 'linan', 'chengyue', 'linzhi', 'xuan', 'yuke', 'mengshi', 'jiming', 'heyu', 'tangjian'];
  const keyNames = ['开发机 · Codex', '生产应用', '个人客户端', '自动化任务', '测试环境', '团队工具'];
  const paths = ['/v1/responses', '/v1/chat/completions', '/v1/messages', '/v1beta/models/gemini-pro:streamGenerateContent'];
  const users = names.map((name, i) => ({ id: 1001 + i, name, email: `${handles[i]}@example.com`,
    keys: [{ id: 4001 + i * 2, name: keyNames[i % keyNames.length] }, ...(i % 3 === 0 ? [{ id: 4002 + i * 2, name: '备用客户端' }] : [])] }));
  const events = [];
  let sequence = 0;
  function add(user, domain, daysAgo, index, count, association = 'confirmed') {
    sequence++;
    const minute = 8 * 60 + (index * 41 + (user?.id || sequence) * 7) % (daysAgo ? 13 * 60 : 6 * 60 + 50);
    const at = today - daysAgo * day + minute * 60000 + (sequence % 59) * 1000;
    const key = user?.keys[index % user.keys.length];
    const http = association === 'anonymous' ? 401 : sequence % 37 === 0 ? 502 : 200;
    events.push({ id: `demo-root-${String(sequence).padStart(6, '0')}`, at, domain, userId: user?.id || null,
      keyId: key?.id || null, association, path: paths[sequence % paths.length], method: 'POST', status: http,
      flow: http !== 200 ? 'HTTP 错误' : sequence % 29 === 0 ? '流内错误' : sequence % 17 === 0 ? '结束未知' : '完整结束',
      ip: `203.0.113.${10 + sequence % 200}`, agent: ['Codex CLI', 'Claude Code', 'OpenAI SDK', 'Gemini CLI'][sequence % 4],
      attempts: sequence % 9 === 0 ? 2 : 1 });
  }
  for (const [i, user] of users.entries()) {
    const lastOld = i < 12 ? (i % 4 === 3 ? 1 : 0) : i < 20 ? 8 + i % 4 : 18 + i % 4;
    for (let d = 29 - i % 5; d >= lastOld; d--) {
      const count = 3 + (i * 7 + d * 3) % 13;
      for (let j = 0; j < count; j++) add(user, oldDomain, d, j, count);
    }
    if (i < 20 && (i >= 12 || i % 3 === 0)) {
      const firstNew = i >= 12 ? lastOld - 1 : 4;
      for (let d = firstNew; d >= 0; d--) {
        const count = 4 + (i + d * 2) % 15;
        for (let j = 0; j < count; j++) add(user, newDomain, d, j, count);
      }
    }
    if (i < 8) for (let d = 6; d >= i % 3; d--) for (let j = 0; j < 3; j++) add(user, 'aihub.fo2.us.ci', d, j, 3);
  }
  for (let d = 29; d >= 0; d--) for (let j = 0; j < 7; j++) add(null, oldDomain, d, j, 7, ['anonymous', 'pending', 'anonymous', 'ambiguous', 'anonymous', 'pending', 'anonymous'][j]);
  events.sort((a, b) => b.at - a.at || a.id.localeCompare(b.id));
  const history = [
    { id: 'history-01', at: '2026-10-14 18:24:16', source: 'Nginx 错误日志', path: '/v1/responses', domain: oldDomain, evidence: 'Host 已确认', owner: null, state: '身份未知', reason: '明确记录旧域名，但没有可验证的用户关联号。' },
    { id: 'history-02', at: '2026-10-14 16:32:04', source: 'Nginx 访问日志', path: '/api/v1/auth/me', domain: oldDomain, evidence: '仅 Referer', owner: null, state: '域名未确认', reason: '旧域名来自来源页面字段，不能证明本次请求的入口域名。' },
    { id: 'history-03', at: '2026-10-13 20:41:32', source: 'Nginx 访问日志', path: '/v1/chat/completions', domain: oldDomain, evidence: '仅 Referer', owner: null, state: '域名未确认', reason: '共享日志未保留 Host；相近时间和 IP 不足以认领用户。' },
    { id: 'history-04', at: '2026-10-12 10:17:48', source: 'Nginx 错误日志', path: '/v1/models', domain: oldDomain, evidence: 'Host 已确认', owner: null, state: '身份未知', reason: '连接上游失败，无法据此确认 API Key 所属用户。' },
    { id: 'history-05', at: '2026-10-10 09:11:02', source: '订单来源', path: '/api/v1/payment/orders', domain: oldDomain, evidence: '订单来源域名', owner: '管理员 · ID 1', state: '管理员记录', reason: '可确认管理员曾使用该入口创建订单，不能证明当前 API 客户端配置。' }
  ];
  window.DomainDemoFixture = Object.freeze({ now, today, day, oldDomain, newDomain, users, events, history,
    collectionStart: '2026-10-15 00:00:00', version: 1 });
})();

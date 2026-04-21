/**
 * Sub2API Group Filter Patch (方案 B)
 *
 * 通过 Nginx sub_filter 注入到 Sub2API 前端页面，
 * 拦截 /api/v1/groups/available 的 fetch 响应，
 * 对 platform 为 "openai" 的分组进行过滤：
 *   - 仅保留 name 等于当前登录用户邮箱的分组
 *
 * 完全独立于 Sub2API 源码，零侵入。
 */
(function () {
  'use strict';

  // 避免重复注入
  if (window.__GROUP_FILTER_PATCHED__) return;
  window.__GROUP_FILTER_PATCHED__ = true;

  /**
   * 从 localStorage 读取当前登录用户的邮箱
   */
  function getCurrentUserEmail() {
    try {
      const raw = localStorage.getItem('auth_user');
      if (!raw) return null;
      const user = JSON.parse(raw);
      return user.email || null;
    } catch {
      return null;
    }
  }

  /**
   * 过滤分组列表：openai 平台只保留与用户邮箱同名的分组
   */
  function filterGroups(groups, userEmail) {
    if (!Array.isArray(groups) || !userEmail) return groups;
    return groups.filter(function (g) {
      if (g.platform === 'openai') {
        return g.name === userEmail;
      }
      return true;
    });
  }

  // ── Monkey-patch window.fetch ──

  var originalFetch = window.fetch;

  window.fetch = function () {
    var args = arguments;
    var url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';

    // 仅拦截分组可用列表接口
    if (url.indexOf('/api/v1/groups/available') === -1) {
      return originalFetch.apply(this, args);
    }

    return originalFetch.apply(this, args).then(function (response) {
      // 只处理成功响应
      if (!response.ok) return response;

      // 克隆响应以读取 body
      return response.clone().text().then(function (bodyText) {
        try {
          var json = JSON.parse(bodyText);
          var userEmail = getCurrentUserEmail();

          // Sub2API 标准响应格式: { code, message, data: [...] }
          if (json && json.data && Array.isArray(json.data)) {
            json.data = filterGroups(json.data, userEmail);
          }
          // 兼容直接返回数组的情况
          else if (Array.isArray(json)) {
            json = filterGroups(json, userEmail);
          }

          return new Response(JSON.stringify(json), {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          });
        } catch {
          // JSON 解析失败，返回原始响应
          return response;
        }
      });
    });
  };

  console.log('[GroupFilter] OpenAI 分组过滤补丁已加载');
})();

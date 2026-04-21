/**
 * Sub2API Group Filter Patch (方案 B)
 *
 * 通过 Nginx sub_filter 注入到 Sub2API 前端页面，
 * 拦截 /api/v1/groups/available 的响应，
 * 对 platform 为 "openai" 的分组进行过滤：
 *   - 仅保留 name 等于当前登录用户邮箱的分组
 *
 * 同时拦截 fetch 和 XMLHttpRequest (axios)。
 * 完全独立于 Sub2API 源码，零侵入。
 */
(function () {
  'use strict';

  // 避免重复注入
  if (window.__GROUP_FILTER_PATCHED__) return;
  window.__GROUP_FILTER_PATCHED__ = true;

  var TARGET_PATH = '/api/v1/groups/available';

  /**
   * 从 localStorage 读取当前登录用户的邮箱
   */
  function getCurrentUserEmail() {
    try {
      var raw = localStorage.getItem('auth_user');
      if (!raw) return null;
      var user = JSON.parse(raw);
      return user.email || null;
    } catch (e) {
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

  /**
   * 尝试过滤 JSON 响应体（兼容 { code, data: [...] } 和直接数组两种格式）
   * 返回过滤后的 JSON 字符串，如果无需处理则返回 null
   */
  function filterResponseBody(bodyText) {
    try {
      var json = JSON.parse(bodyText);
      var userEmail = getCurrentUserEmail();
      if (!userEmail) return null;

      var modified = false;

      // Sub2API 标准响应格式: { code, message, data: [...] }
      if (json && json.data && Array.isArray(json.data)) {
        var filtered = filterGroups(json.data, userEmail);
        if (filtered.length !== json.data.length) {
          json.data = filtered;
          modified = true;
        }
      }
      // 兼容直接返回数组
      else if (Array.isArray(json)) {
        var filtered2 = filterGroups(json, userEmail);
        if (filtered2.length !== json.length) {
          json = filtered2;
          modified = true;
        }
      }

      return modified ? JSON.stringify(json) : null;
    } catch (e) {
      return null;
    }
  }

  // ── 1. Monkey-patch XMLHttpRequest (axios 使用) ──

  var XHROpen = XMLHttpRequest.prototype.open;
  var XHRSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function () {
    // 记录请求 URL
    this._groupFilterUrl = arguments[1] || '';
    return XHROpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function () {
    var xhr = this;
    var url = xhr._groupFilterUrl || '';

    if (url.indexOf(TARGET_PATH) !== -1) {
      // 拦截 onreadystatechange
      var originalOnReady = xhr.onreadystatechange;
      var patched = false;

      xhr.addEventListener('readystatechange', function () {
        if (xhr.readyState === 4 && !patched) {
          patched = true;
          try {
            var filtered = filterResponseBody(xhr.responseText);
            if (filtered !== null) {
              // 重写 response 和 responseText
              Object.defineProperty(xhr, 'responseText', { get: function () { return filtered; } });
              Object.defineProperty(xhr, 'response', { get: function () { return filtered; } });
            }
          } catch (e) {
            // 静默失败
          }
        }
      });
    }

    return XHRSend.apply(this, arguments);
  };

  // ── 2. Monkey-patch fetch (以防未来使用) ──

  var originalFetch = window.fetch;

  window.fetch = function () {
    var args = arguments;
    var url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';

    if (url.indexOf(TARGET_PATH) === -1) {
      return originalFetch.apply(this, args);
    }

    return originalFetch.apply(this, args).then(function (response) {
      if (!response.ok) return response;

      return response.clone().text().then(function (bodyText) {
        var filtered = filterResponseBody(bodyText);
        if (filtered !== null) {
          return new Response(filtered, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          });
        }
        return response;
      });
    });
  };

  console.log('[GroupFilter] OpenAI 分组过滤补丁已加载');
})();

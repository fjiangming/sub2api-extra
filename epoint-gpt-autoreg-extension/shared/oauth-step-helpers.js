(function attachOAuthStepHelpers(globalScope) {
  function normalizeInlineText(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
  }

  function parseUrl(input) {
    if (!input || typeof input !== 'string') {
      return null;
    }

    try {
      return new URL(input);
    } catch {
      return null;
    }
  }

  function isLoopbackCallbackUrl(url) {
    const parsed = parseUrl(url);
    if (!parsed) {
      return false;
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }

    return parsed.hostname === 'localhost'
      || parsed.hostname === '127.0.0.1'
      || parsed.hostname === '::1'
      || parsed.hostname === '[::1]';
  }

  function findLoopbackCallbackUrl(candidates = []) {
    for (const candidate of candidates) {
      if (isLoopbackCallbackUrl(candidate)) {
        return candidate;
      }
    }

    return null;
  }

  function findMatchingText(candidates = [], pattern) {
    for (const candidate of candidates) {
      const normalized = normalizeInlineText(candidate);
      if (normalized && pattern.test(normalized)) {
        return normalized;
      }
    }

    return '';
  }

  function findStep9SuccessText(candidates = []) {
    return findMatchingText(
      candidates,
      /认证成功|authentication\s+successful|authenticated\s+successfully|success(?:!|$|\b)/i,
    );
  }

  function findStep9TimeoutText(candidates = []) {
    return findMatchingText(candidates, /认证失败:\s*Timeout waiting for OAuth callback/i);
  }

  function shouldUseStep8ContinueButton(state = {}) {
    return Boolean(state.hasContinueButton)
      && !Boolean(state.isVerificationPage)
      && !Boolean(state.isAddPhonePage);
  }

  const api = {
    findLoopbackCallbackUrl,
    findStep9SuccessText,
    findStep9TimeoutText,
    isLoopbackCallbackUrl,
    normalizeInlineText,
    shouldUseStep8ContinueButton,
  };

  globalScope.MultiPageOAuthStepHelpers = api;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);

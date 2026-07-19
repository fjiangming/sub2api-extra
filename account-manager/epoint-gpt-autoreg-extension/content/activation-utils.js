(function activationUtilsModule(root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
    return;
  }

  root.MultiPageActivationUtils = factory();
})(typeof self !== 'undefined' ? self : globalThis, function createActivationUtils() {
  function normalizeTagName(tagName) {
    return String(tagName || '').trim().toLowerCase();
  }

  function normalizeType(type) {
    return String(type || '').trim().toLowerCase();
  }

  function normalizePathname(pathname) {
    return String(pathname || '').trim().toLowerCase();
  }

  function getActivationStrategy(target = {}) {
    const tagName = normalizeTagName(target.tagName);
    const type = normalizeType(target.type);
    const pathname = normalizePathname(target.pathname);
    const hasForm = Boolean(target.hasForm);
    const isEmailVerificationRoute = /\/email-verification(?:[/?#]|$)/i.test(pathname);
    const isSubmitButton = hasForm
      && (
        (tagName === 'button' && (!type || type === 'submit'))
        || (tagName === 'input' && type === 'submit')
      );

    if (isSubmitButton && isEmailVerificationRoute) {
      return { method: 'requestSubmit' };
    }

    return { method: 'click' };
  }

  function isRecoverableStep9AuthFailure(statusText) {
    const text = String(statusText || '').trim();
    if (!/认证失败:\s*/i.test(text)) {
      return false;
    }

    return /timeout waiting for oauth callback|status code 5\d{2}|bad gateway|gateway timeout|temporarily unavailable/i.test(text);
  }

  return {
    getActivationStrategy,
    isRecoverableStep9AuthFailure,
  };
});

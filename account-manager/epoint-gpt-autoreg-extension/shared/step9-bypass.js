(function attachStep9BypassHelpers(globalScope) {
  function shouldBypassStep9(state = {}) {
    return Boolean(state.skipStep9Enabled ?? state.skipStep9Requested);
  }

  const api = {
    shouldBypassStep9,
  };

  globalScope.MultiPageStep9Bypass = api;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);

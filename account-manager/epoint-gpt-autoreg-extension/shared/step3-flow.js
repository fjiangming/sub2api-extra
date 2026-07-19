(function attachStep3FlowHelpers(globalScope) {
  function derivePasswordFromEmail(email) {
    const localPart = String(email || '').split('@')[0] || '';
    return localPart || 'Aa123456!';
  }

  function buildStep3ExecutionPlan(state = {}) {
    const email = String(state.email || '').trim();
    const customPassword = String(state.customPassword || '');
    return {
      email,
      password: customPassword || derivePasswordFromEmail(email),
      shouldActivateSignupTab: true,
    };
  }

  const api = {
    buildStep3ExecutionPlan,
    derivePasswordFromEmail,
  };

  globalScope.MultiPageStep3Flow = api;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);

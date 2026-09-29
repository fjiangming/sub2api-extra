'use strict';

const CostAnalysisUi = (() => {
  const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

  function entryEditorCurrency(entry) {
    return String(entry?.currency || 'CNY').trim().toUpperCase() || 'CNY';
  }

  function focusLedgerEntryFilter(elements, entry) {
    const currency = String(entry?.currency || '').trim().toUpperCase();
    const date = String(entry?.date || '').trim();
    const currentCurrency = String(elements.currency.value || '').trim().toUpperCase();
    const start = String(elements.start.value || '');
    const end = String(elements.end.value || '');
    const currencyChanged = Boolean(currency && currency !== currentCurrency);
    const dateChanged = Boolean(
      DATE_PATTERN.test(date) && (!start || !end || date < start || date > end)
    );

    if (currencyChanged) elements.currency.value = currency;
    if (dateChanged) {
      elements.start.value = date;
      elements.end.value = date;
    }

    return { currency, date, currencyChanged, dateChanged };
  }

  return {
    entryEditorCurrency,
    focusLedgerEntryFilter,
    expenseEditorCurrency: entryEditorCurrency,
    focusExpenseFilter: focusLedgerEntryFilter
  };
})();

if (typeof window !== 'undefined') window.CostAnalysisUi = CostAnalysisUi;
if (typeof module !== 'undefined' && module.exports) module.exports = CostAnalysisUi;

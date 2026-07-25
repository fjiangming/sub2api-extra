function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function resolvePagination({
  page,
  pageSize,
  total,
  defaultPageSize = 25,
  maxPageSize = 100
} = {}) {
  const safeTotal = Math.max(0, Math.floor(Number(total) || 0));
  const safePageSize = Math.min(
    maxPageSize,
    positiveInteger(pageSize, defaultPageSize)
  );
  const totalPages = Math.max(1, Math.ceil(safeTotal / safePageSize));
  const safePage = Math.min(totalPages, positiveInteger(page, 1));

  return {
    limit: safePageSize,
    offset: (safePage - 1) * safePageSize,
    pagination: {
      page: safePage,
      pageSize: safePageSize,
      total: safeTotal,
      totalPages,
      hasPrevious: safePage > 1,
      hasNext: safePage < totalPages
    }
  };
}

module.exports = {
  resolvePagination
};

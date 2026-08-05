function availableGroupSql(alias = 'g') {
  return `LOWER(TRIM(COALESCE(${alias}.status, ''))) IN ('active', 'enabled')
    AND LOWER(CAST(COALESCE(json_extract(${alias}.metadata_json, '$.derivedFromKey'), 0) AS TEXT)) NOT IN ('1', 'true')
    AND LOWER(CAST(COALESCE(json_extract(${alias}.metadata_json, '$.selectable'), 1) AS TEXT)) NOT IN ('0', 'false')`;
}

function availablePriceGroupSql(priceAlias = 'mp') {
  const explicitRef = `NULLIF(TRIM(CAST(json_extract(${priceAlias}.raw_json, '$.groupRemoteId') AS TEXT)), '')`;
  const groupRef = `NULLIF(TRIM(CAST(${priceAlias}.group_ref AS TEXT)), '')`;
  const exactMatch = `price_group.connection_id = ${priceAlias}.connection_id
    AND CAST(price_group.remote_id AS TEXT) = ${explicitRef}`;
  const legacyMatch = `price_group.connection_id = ${priceAlias}.connection_id
    AND (
      CAST(price_group.remote_id AS TEXT) = ${groupRef}
      OR CAST(price_group.id AS TEXT) = ${groupRef}
      OR (
        INSTR(${groupRef}, '@') > 0
        AND CAST(price_group.remote_id AS TEXT) = SUBSTR(${groupRef}, 1, INSTR(${groupRef}, '@') - 1)
      )
    )`;

  return `CASE
    WHEN ${explicitRef} IS NOT NULL THEN EXISTS (
      SELECT 1 FROM remote_groups price_group
      WHERE ${exactMatch} AND ${availableGroupSql('price_group')}
    )
    WHEN ${groupRef} IS NULL THEN 1
    WHEN EXISTS (SELECT 1 FROM remote_groups price_group WHERE ${legacyMatch}) THEN EXISTS (
      SELECT 1 FROM remote_groups price_group
      WHERE ${legacyMatch} AND ${availableGroupSql('price_group')}
    )
    ELSE 1
  END`;
}

module.exports = { availableGroupSql, availablePriceGroupSql };

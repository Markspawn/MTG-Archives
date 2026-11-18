// Hash rows inside PostgreSQL, then hash their sorted fixed-size digests. This
// preserves exact bag-of-rows conservation without loading a large shared
// fixture's entire JSON history into the browser runner or one Node process.
function rowFingerprintSql(table) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) throw Error("Unexpected table");
  return `WITH fingerprint_rows AS MATERIALIZED (
    SELECT encode(sha256(convert_to(row_to_json(t)::text,'UTF8')),'hex') AS digest FROM "${table}" t
  ) SELECT count(*)::int AS count,
    encode(sha256(convert_to(COALESCE(string_agg(digest,'' ORDER BY digest COLLATE "C"),''),'UTF8')),'hex') AS hash
    FROM fingerprint_rows`;
}
module.exports = {rowFingerprintSql};

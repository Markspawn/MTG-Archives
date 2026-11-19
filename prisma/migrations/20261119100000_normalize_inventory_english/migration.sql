BEGIN;

-- Keep lot IDs, quantities, timestamps, and audit snapshots intact.
CREATE FUNCTION normalize_inventory_english_rows() RETURNS integer
LANGUAGE sql AS $$
  WITH repaired AS (
    UPDATE "InventoryItem"
       SET "language" = 'EN'
     WHERE "language" <> 'EN' AND upper(btrim("language")) = 'EN'
     RETURNING 1
  )
  SELECT count(*)::integer FROM repaired;
$$;

CREATE FUNCTION normalize_inventory_english_write() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF upper(btrim(NEW."language")) = 'EN' THEN
    NEW."language" := 'EN';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER inventory_english_language_normalization
BEFORE INSERT OR UPDATE OF "language" ON "InventoryItem"
FOR EACH ROW EXECUTE FUNCTION normalize_inventory_english_write();

SELECT normalize_inventory_english_rows();

COMMIT;

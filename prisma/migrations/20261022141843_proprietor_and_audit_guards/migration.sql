-- Emails are compared case-insensitively everywhere, so store them normalized.
ALTER TABLE "User"
  ADD CONSTRAINT "User_email_lowercase" CHECK ("email" = lower(btrim("email")));

-- Proprietor badge: exactly one holder, ever (BUILD_PLAN.md section 4.6a).

ALTER TABLE "Proprietor"
  ADD CONSTRAINT "Proprietor_singleton" CHECK ("id" = 1);

CREATE FUNCTION proprietor_insert_guard() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "User" WHERE "id" = NEW."userId" AND "role" = 'OWNER') THEN
    RAISE EXCEPTION 'Proprietor can only be assigned to the platform owner (role OWNER)'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER proprietor_insert_guard
  BEFORE INSERT ON "Proprietor"
  FOR EACH ROW EXECUTE FUNCTION proprietor_insert_guard();

CREATE FUNCTION proprietor_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Proprietor assignment is permanent and cannot be changed or removed'
    USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER proprietor_no_update_delete
  BEFORE UPDATE OR DELETE ON "Proprietor"
  FOR EACH ROW EXECUTE FUNCTION proprietor_immutable();

CREATE TRIGGER proprietor_no_truncate
  BEFORE TRUNCATE ON "Proprietor"
  FOR EACH STATEMENT EXECUTE FUNCTION proprietor_immutable();

CREATE FUNCTION proprietor_role_lock() RETURNS trigger AS $$
BEGIN
  IF NEW."role" <> 'OWNER' AND EXISTS (SELECT 1 FROM "Proprietor" WHERE "userId" = OLD."id") THEN
    RAISE EXCEPTION 'The Proprietor must keep the OWNER role'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER proprietor_role_lock
  BEFORE UPDATE OF "role" ON "User"
  FOR EACH ROW EXECUTE FUNCTION proprietor_role_lock();

-- Audit log: append-only.

CREATE FUNCTION audit_event_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'AuditEvent is append-only'
    USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_event_no_update_delete
  BEFORE UPDATE OR DELETE ON "AuditEvent"
  FOR EACH ROW EXECUTE FUNCTION audit_event_append_only();

CREATE TRIGGER audit_event_no_truncate
  BEFORE TRUNCATE ON "AuditEvent"
  FOR EACH STATEMENT EXECUTE FUNCTION audit_event_append_only();

-- A save changes one person's collection immediately. Public popularity counts
-- refresh with the 60-second cache TTL, just like downloads, rather than evicting
-- every catalog response on each save or removal.
CREATE TABLE worker_collection_revision (
  user_id INTEGER PRIMARY KEY REFERENCES auth_user(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL
);

DROP TRIGGER cache_hub_bookmark_insert;
DROP TRIGGER cache_hub_bookmark_update;
DROP TRIGGER cache_hub_bookmark_delete;

CREATE TRIGGER cache_hub_bookmark_insert AFTER INSERT ON hub_bookmark BEGIN
  INSERT INTO worker_collection_revision(user_id, revision) VALUES (NEW.user_id, 1)
    ON CONFLICT(user_id) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER cache_hub_bookmark_delete AFTER DELETE ON hub_bookmark BEGIN
  INSERT INTO worker_collection_revision(user_id, revision)
    SELECT id, 1 FROM auth_user WHERE id=OLD.user_id
    ON CONFLICT(user_id) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER cache_hub_bookmark_update AFTER UPDATE ON hub_bookmark BEGIN
  INSERT INTO worker_collection_revision(user_id, revision)
    SELECT id, 1 FROM auth_user WHERE id IN (OLD.user_id, NEW.user_id)
    ON CONFLICT(user_id) DO UPDATE SET revision=revision+1;
END;

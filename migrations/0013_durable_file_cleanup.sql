-- Queue every storage deletion in the transaction which removes its reference.
-- NULL bucket is reserved for deletion entries imported from the Python app.
ALTER TABLE hub_filedeletion ADD COLUMN bucket TEXT CHECK(bucket IN ('files','images','quarantine'));
ALTER TABLE hub_filedeletion ADD COLUMN not_before INTEGER NOT NULL DEFAULT 0;
ALTER TABLE hub_filedeletion ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
CREATE INDEX hub_filedeletion_due ON hub_filedeletion(not_before,attempts,id);

CREATE TRIGGER release_storage_cleanup AFTER DELETE ON hub_release BEGIN
 INSERT INTO hub_filedeletion(name,created_at,bucket) SELECT OLD.file,strftime('%Y-%m-%dT%H:%M:%fZ','now'),'files' WHERE OLD.file<>''
 ON CONFLICT(name) DO UPDATE SET bucket=excluded.bucket;
END;
CREATE TRIGGER screenshot_storage_cleanup AFTER DELETE ON hub_screenshot BEGIN
 INSERT INTO hub_filedeletion(name,created_at,bucket)
 SELECT OLD.image,strftime('%Y-%m-%dT%H:%M:%fZ','now'),CASE WHEN length(OLD.image)=58 AND substr(OLD.image,37,1)='-' AND substr(OLD.image,-5)='.webp' THEN 'images' ELSE 'files' END WHERE OLD.image<>''
 ON CONFLICT(name) DO UPDATE SET bucket=excluded.bucket;
END;
CREATE TRIGGER upload_storage_cleanup BEFORE DELETE ON worker_job BEGIN
 INSERT INTO hub_filedeletion(name,created_at,bucket,not_before)
 VALUES (OLD.object_key,strftime('%Y-%m-%dT%H:%M:%fZ','now'),'quarantine',OLD.lease_until)
 ON CONFLICT(name) DO UPDATE SET bucket=excluded.bucket,not_before=MAX(not_before,excluded.not_before);
 INSERT INTO hub_filedeletion(name,created_at,bucket,not_before)
 SELECT OLD.output_key,strftime('%Y-%m-%dT%H:%M:%fZ','now'),CASE WHEN substr(OLD.output_key,1,9)='releases/' THEN 'files' ELSE 'images' END,OLD.lease_until
 WHERE OLD.output_key IS NOT NULL
 AND NOT EXISTS(SELECT 1 FROM hub_release WHERE file=OLD.output_key)
 AND NOT EXISTS(SELECT 1 FROM hub_screenshot WHERE image=OLD.output_key)
 ON CONFLICT(name) DO UPDATE SET bucket=excluded.bucket,not_before=MAX(not_before,excluded.not_before);
END;

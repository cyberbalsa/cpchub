CREATE TRIGGER upload_guard BEFORE INSERT ON hub_uploadjob WHEN NEW.status='pending' BEGIN
 SELECT CASE WHEN (SELECT COUNT(*) FROM hub_uploadjob WHERE status='pending')>=64 THEN RAISE(ABORT,'queue_full') END;
 SELECT CASE WHEN (SELECT COUNT(*) FROM hub_uploadjob WHERE status='pending' AND submitted_by_id=NEW.submitted_by_id)>=32 THEN RAISE(ABORT,'user_queue_full') END;
 SELECT CASE WHEN NEW.kind='release' AND (SELECT COUNT(*) FROM hub_uploadevent WHERE user_id=NEW.submitted_by_id AND created_at>strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 hour'))>=16 AND NOT EXISTS(SELECT 1 FROM auth_user u WHERE u.id=NEW.submitted_by_id AND (u.is_superuser=1 OR EXISTS(SELECT 1 FROM auth_user_groups ug JOIN auth_group g ON ug.group_id=g.id WHERE ug.user_id=u.id AND g.name IN ('Admin','Moderator','Reviewer')))) THEN RAISE(ABORT,'upload_quota') END;
 SELECT CASE WHEN NEW.kind='screenshot' AND ((SELECT COUNT(*) FROM hub_screenshot WHERE item_id=NEW.item_id)+(SELECT COUNT(*) FROM hub_uploadjob WHERE item_id=NEW.item_id AND kind='screenshot' AND status='pending'))>=8 THEN RAISE(ABORT,'screenshot_limit') END;
 SELECT CASE WHEN NEW.kind='release' AND (EXISTS(SELECT 1 FROM hub_release WHERE item_id=NEW.item_id AND version=json_extract(NEW.metadata,'$.version')) OR EXISTS(SELECT 1 FROM hub_uploadjob WHERE item_id=NEW.item_id AND kind='release' AND status='pending' AND json_extract(metadata,'$.version')=json_extract(NEW.metadata,'$.version'))) THEN RAISE(ABORT,'duplicate_version') END;
END;
CREATE TRIGGER upload_event AFTER INSERT ON hub_uploadjob WHEN NEW.kind='release' BEGIN
 INSERT INTO hub_uploadevent(user_id,created_at) VALUES (NEW.submitted_by_id,NEW.created_at);
END;

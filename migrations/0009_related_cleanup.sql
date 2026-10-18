-- Preserve source-model cascade behavior for nullable ownership links.
CREATE TRIGGER user_owned_records_cleanup BEFORE DELETE ON auth_user BEGIN
 DELETE FROM oauth2_provider_application WHERE user_id=OLD.id;
 DELETE FROM oauth2_provider_accesstoken WHERE user_id=OLD.id;
 DELETE FROM oauth2_provider_idtoken WHERE user_id=OLD.id;
 DELETE FROM oauth2_provider_devicegrant WHERE user_id=OLD.id;
 DELETE FROM hub_sitemapentry WHERE author_id=OLD.id;
END;
CREATE TRIGGER oauth_application_cleanup BEFORE DELETE ON oauth2_provider_application BEGIN
 DELETE FROM worker_token WHERE client_id=OLD.client_id;
 DELETE FROM worker_oauth_code WHERE client_id=OLD.client_id;
 DELETE FROM hub_apikey WHERE application_id=OLD.id;
 DELETE FROM oauth2_provider_accesstoken WHERE application_id=OLD.id;
 DELETE FROM oauth2_provider_idtoken WHERE application_id=OLD.id;
END;
CREATE TRIGGER id_token_cleanup BEFORE DELETE ON oauth2_provider_idtoken BEGIN
 DELETE FROM oauth2_provider_accesstoken WHERE id_token_id=OLD.id;
END;
CREATE TRIGGER sitemap_item_cleanup BEFORE DELETE ON hub_item BEGIN
 DELETE FROM hub_sitemapentry WHERE item_id=OLD.id;
END;

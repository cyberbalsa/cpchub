-- Match Django CASCADE semantics for nullable release download markers.
CREATE TABLE "hub_downloadip_replacement" ("id" integer NOT NULL PRIMARY KEY AUTOINCREMENT, "network" varchar(43) NOT NULL, "expires_at" datetime NOT NULL, "item_id" char(32) NOT NULL REFERENCES "hub_item" ("id") ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED, "release_id" char(32) NULL REFERENCES "hub_release" ("id") ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED);
INSERT INTO "hub_downloadip_replacement" SELECT * FROM "hub_downloadip";
DROP TABLE "hub_downloadip";
ALTER TABLE "hub_downloadip_replacement" RENAME TO "hub_downloadip";
CREATE UNIQUE INDEX "unique_item_download_ip" ON "hub_downloadip" ("item_id", "network") WHERE "release_id" IS NULL;
CREATE UNIQUE INDEX "unique_release_download_ip" ON "hub_downloadip" ("release_id", "network") WHERE "release_id" IS NOT NULL;
CREATE INDEX "hub_downloadip_expires_at_cba22c4e" ON "hub_downloadip" ("expires_at");
CREATE INDEX "hub_downloadip_item_id_f2edf0ab" ON "hub_downloadip" ("item_id");
CREATE INDEX "hub_downloadip_release_id_15ed07f1" ON "hub_downloadip" ("release_id");
CREATE TABLE "hub_downloaduser_replacement" ("id" integer NOT NULL PRIMARY KEY AUTOINCREMENT, "item_id" char(32) NOT NULL REFERENCES "hub_item" ("id") ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED, "release_id" char(32) NULL REFERENCES "hub_release" ("id") ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED, "user_id" integer NOT NULL REFERENCES "auth_user" ("id") ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED);
INSERT INTO "hub_downloaduser_replacement" SELECT * FROM "hub_downloaduser";
DROP TABLE "hub_downloaduser";
ALTER TABLE "hub_downloaduser_replacement" RENAME TO "hub_downloaduser";
CREATE UNIQUE INDEX "unique_item_download_user" ON "hub_downloaduser" ("item_id", "user_id") WHERE "release_id" IS NULL;
CREATE UNIQUE INDEX "unique_release_download_user" ON "hub_downloaduser" ("release_id", "user_id") WHERE "release_id" IS NOT NULL;
CREATE INDEX "hub_downloaduser_item_id_e950f6a5" ON "hub_downloaduser" ("item_id");
CREATE INDEX "hub_downloaduser_release_id_aeb3842d" ON "hub_downloaduser" ("release_id");
CREATE INDEX "hub_downloaduser_user_id_c3806b0e" ON "hub_downloaduser" ("user_id");

-- Curated categories stay public even when no creations use them yet.
-- Researched 2026-10-18 against Steam app 3031880 and the local install:
-- assets/scripts/entities/simulation/_catalogue.lua, assets/lang/en.csv,
-- assets/blueprints/{small,medium,large}_parking_garages, scenario_editor,
-- assets/scenarios/{City,Florida,Egypt,tutorial_1}.cpcs, and saved creations
-- (including Parking Letters.cpbp and Tron.cpcs).
-- https://store.steampowered.com/app/3031880/Car_Park_Capital/
-- https://steamcommunity.com/app/3031880/ (developer's launch and roadmap posts)
-- Scenario labels describe editor options/objectives and player-defined difficulty;
-- themes also cover custom builds. Planned mechanics are not seeded as categories.
ALTER TABLE hub_tag ADD COLUMN category_group TEXT NOT NULL DEFAULT ''
  CHECK (category_group IN ('', 'blueprints', 'scenarios', 'themes'));

CREATE TRIGGER cache_hub_tag_insert AFTER INSERT ON hub_tag BEGIN UPDATE worker_cache_revision SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER cache_hub_tag_update AFTER UPDATE ON hub_tag BEGIN UPDATE worker_cache_revision SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER cache_hub_tag_delete AFTER DELETE ON hub_tag BEGIN UPDATE worker_cache_revision SET revision=revision+1 WHERE id=1; END;

-- Preserve existing tag IDs and their creation associations.
INSERT INTO hub_tag (name, category_group) VALUES
  ('parking', 'blueprints'),
  ('parking garages', 'blueprints'),
  ('small garages', 'blueprints'),
  ('medium garages', 'blueprints'),
  ('large garages', 'blueprints'),
  ('traffic', 'blueprints'),
  ('drive-thrus', 'blueprints'),
  ('gas stations', 'blueprints'),
  ('housing', 'blueprints'),
  ('offices', 'blueprints'),
  ('skyscrapers', 'blueprints'),
  ('city blocks', 'blueprints'),
  ('car factories', 'blueprints'),
  ('oil industry', 'blueprints'),
  ('farms', 'blueprints'),
  ('junkyards', 'blueprints'),
  ('public transport', 'blueprints'),
  ('emergency services', 'blueprints'),
  ('propaganda', 'blueprints'),
  ('landscaping', 'blueprints'),
  ('decorations', 'blueprints'),
  ('signs and lettering', 'blueprints'),
  ('beginner friendly', 'scenarios'),
  ('challenging', 'scenarios'),
  ('timed challenge', 'scenarios'),
  ('no deadline', 'scenarios'),
  ('limited funds', 'scenarios'),
  ('profit goals', 'scenarios'),
  ('parking goals', 'scenarios'),
  ('car sales goals', 'scenarios'),
  ('car dependency', 'scenarios'),
  ('suburban expansion', 'scenarios'),
  ('transit removal', 'scenarios'),
  ('city', 'scenarios'),
  ('islands', 'scenarios'),
  ('desert', 'scenarios'),
  ('boat cars', 'scenarios'),
  ('blank map', 'scenarios'),
  ('baldtown', 'themes'),
  ('florida', 'themes'),
  ('egypt', 'themes'),
  ('brick', 'themes'),
  ('concrete', 'themes'),
  ('steel', 'themes'),
  ('castle', 'themes'),
  ('bubble', 'themes'),
  ('futuristic', 'themes'),
  ('recreation', 'themes')
ON CONFLICT(name) DO UPDATE SET category_group=excluded.category_group;

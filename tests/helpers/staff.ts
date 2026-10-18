import { fixture } from "./app";
import { uuid, now } from "../../src/env";

export async function staffFixture() {
  const f = await fixture();
  function role(role: "" | "Admin" | "Moderator" | "Reviewer", id = 1) {
    f.sqlite.prepare("DELETE FROM auth_user_groups WHERE user_id=?").run(id);
    f.sqlite
      .prepare("UPDATE auth_user SET is_superuser=? WHERE id=?")
      .run(role === "Admin" ? 1 : 0, id);
    if (role)
      f.sqlite
        .prepare(
          "INSERT INTO auth_user_groups(user_id,group_id) SELECT ?,id FROM auth_group WHERE name=?",
        )
        .run(id, role);
  }
  role("Admin");
  const item = f.insert("hub_item", {
    id: uuid(),
    author_id: 2,
    content_type_id: 1,
    title: "Test creation",
    summary: "Summary",
    description: "Description",
    status: "published",
    content_revision: 2,
    updated_at: now(),
  });
  const release = f.insert("hub_release", {
    id: uuid(),
    item_id: item.id,
    version: "1",
    file: "releases/file.cpbp",
    file_stats: "{}",
  });
  const screenshot = f.insert("hub_screenshot", {
    id: uuid(),
    item_id: item.id,
    image: "screenshots/test.webp",
  });
  return { ...f, role, item, release, screenshot };
}

import base64
import hashlib
import io
import json
import tempfile
import zipfile
from datetime import timedelta
from urllib.parse import parse_qs, urlencode, urlparse

from django.contrib.auth import get_user_model
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import TestCase, override_settings
from django.utils import timezone
from oauth2_provider.models import Application, AccessToken, RefreshToken
from PIL import Image
from rest_framework.test import APIClient

from hub.models import APIKey, ContentType, Item, Release, Revision, Screenshot


def package(name="test.json", data=b'{"hello":"parking"}'):
    return SimpleUploadedFile(name, data, content_type="application/octet-stream")


def screenshot(name="shot.png", color=(0, 128, 128)):
    output = io.BytesIO()
    Image.new("RGB", (30, 20), color).save(output, "PNG")
    return SimpleUploadedFile(name, output.getvalue(), content_type="image/png")


@override_settings(DEBUG=True, SECURE_SSL_REDIRECT=False, STORAGES={
    "default": {"BACKEND": "django.core.files.storage.FileSystemStorage"},
    "staticfiles": {"BACKEND": "whitenoise.storage.CompressedManifestStaticFilesStorage"},
})
class HubTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.author = get_user_model().objects.create_user("author", "author@example.com", "Test-Only-Password!1")
        cls.other = get_user_model().objects.create_user("other", "other@example.com", "Test-Only-Password!2")
        cls.category = ContentType.objects.get(slug="blueprints")
        cls.item = Item.objects.create(author=cls.author, content_type=cls.category, title="Test lot", summary="Test summary", description="A test lot")
        for index in range(2):
            Screenshot.objects.create(item=cls.item, image=f"screenshots/fixture-{index}.webp")

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.media = override_settings(MEDIA_ROOT=self.directory.name)
        self.media.enable()
        self.addCleanup(self.directory.cleanup)
        self.addCleanup(self.media.disable)
        self.api = APIClient()
        self.url = f"/api/v1/items/{self.item.pk}/"

    def login(self, user=None):
        self.api.force_login(user or self.author)
        self.client.force_login(user or self.author)

    def release(self, version="1.0.0", name="test.json", data=b'{"hello":"parking"}'):
        return self.api.post(self.url+"releases/", {"version": version, "file": package(name,data)}, format="multipart")

    def test_catalog_and_account_pages_render(self):
        for url in ["/", "/?type=blueprints", "/?q=parking", "/developers/", "/accounts/login/", "/api/docs/", self.item.get_absolute_url()]:
            with self.subTest(url=url):
                self.assertEqual(self.client.get(url).status_code, 200)
        result = self.client.get("/", HTTP_HX_REQUEST="true")
        self.assertContains(result, 'id="results"')
        self.assertNotContains(result,"<!doctype")

    def test_anonymous_cannot_publish_or_get_profile(self):
        self.assertEqual(self.api.post("/api/v1/items/", {"title":"Bad"}).status_code,401)
        self.assertEqual(self.api.get("/api/v1/me/").status_code,401)

    def test_catalog_filters_and_history_render_without_overview(self):
        self.login()
        Item.objects.bulk_create([
            Item(author=self.author, content_type=self.category, title=f"Lot {index}")
            for index in range(12)
        ])
        for url in ["/", "/?q=&type=&sort=updated", "/?page=1", "/?type=blueprints",
                    "/?q=parking", "/?view=mine", "/?view=saved", "/?page=2"]:
            for partial in [False, True]:
                with self.subTest(url=url, partial=partial):
                    response = self.client.get(url, **({"HTTP_HX_REQUEST": "true"} if partial else {}))
                    self.assertEqual(response.status_code, 200)
                    self.assertContains(response, 'id="results"', count=1)
                    self.assertContains(response, '<!doctype', count=0 if partial else 1)
                    self.assertNotContains(response, 'id="community-overview"')
                    self.assertNotContains(response, 'id="community-map"')
                    self.assertNotContains(response, 'hx-swap-oob="outerHTML"')
        response = self.client.get("/?q=parking", HTTP_HX_REQUEST="true", HTTP_HX_HISTORY_RESTORE_REQUEST="true")
        self.assertContains(response, "<!doctype")
        self.assertNotContains(response, 'id="community-map"')
        self.assertNotContains(response, 'hx-swap-oob="outerHTML"')

    def test_header_totals_include_all_published_versions_and_exclude_private_files(self):
        for version, size in [("1", 512), ("2", 1536)]:
            Release.objects.create(item=self.item, version=version, file=f"releases/{version}.json", original_filename="test.json", sha256="a" * 64, size=size)
        for title, status, demo in [("Draft", "draft", False), ("Demo", "published", True)]:
            item = Item.objects.create(author=self.author, content_type=self.category, title=title, summary=title, description=title, status=status, is_demo=demo)
            Release.objects.create(item=item, version="1", file="releases/hidden.json", original_filename="hidden.json", sha256="b" * 64, size=999999)
        for url in ["/", "/?type=scenarios", "/accounts/login/"]:
            response = self.client.get(url)
            self.assertEqual(response.context["site_totals"], {"uploads": 1, "total_bytes": 2048})
            self.assertContains(response, "1 upload</span>")
            self.assertContains(response, "2.0\u00a0KB</span>")
            self.assertContains(response, 'href="https://github.com/cyberbalsa/cpchub">Source code</a>')

    @override_settings(DEBUG=False)
    def test_production_catalog_and_detail_use_collected_artwork(self):
        from django.contrib.staticfiles.storage import staticfiles_storage
        self.item.screenshots.all().delete()
        expected = staticfiles_storage.url("art/lot-0.svg")
        for url in ["/", "/?type=blueprints", self.item.get_absolute_url()]:
            with self.subTest(url=url):
                self.assertContains(self.client.get(url), expected)
        self.assertContains(self.client.get("/", HTTP_HX_REQUEST="true"), expected)

    def test_only_author_can_edit_or_release(self):
        self.login(self.other)
        self.assertEqual(self.api.patch(self.url, {"title": "Stolen"}).status_code,403)
        self.assertEqual(self.release().status_code,403)
        self.assertEqual(self.client.get(f"/items/{self.item.pk}/edit/").status_code,404)
        self.login()
        self.assertEqual(self.api.patch(self.url, {"title":"Updated"}).status_code,200)
        self.item.refresh_from_db()
        self.assertEqual(self.item.title,"Updated")
        self.assertEqual(Revision.objects.get(item=self.item).snapshot["title"],"Updated")

    def test_drafts_and_their_downloads_are_private(self):
        self.login()
        release=self.release().json()
        self.item.status="draft"
        self.item.save()
        self.api.logout()
        self.assertEqual(self.api.get(self.url).status_code,404)
        self.assertEqual(self.api.get(release["download_url"]).status_code,404)
        self.login(self.other)
        self.assertEqual(self.api.get(self.url).status_code,404)
        self.login()
        self.assertEqual(self.api.get(self.url).status_code,200)

    def test_immutable_releases_hashes_and_old_downloads(self):
        self.login()
        first=self.release()
        self.assertEqual(first.status_code,201,first.data)
        self.assertEqual(first.data["sha256"],hashlib.sha256(b'{"hello":"parking"}').hexdigest())
        self.assertEqual(self.release().status_code,400)
        self.assertEqual(self.release("2.0.0",data=b'{"v":2}').status_code,201)
        result=self.api.get(first.data["download_url"])
        self.assertEqual(result.status_code,200)
        self.assertEqual(b"".join(result.streaming_content),b'{"hello":"parking"}')
        self.assertIn("attachment",result["Content-Disposition"])
        self.item.refresh_from_db()
        self.assertEqual(self.item.downloads,1)
        self.assertEqual(self.item.releases.count(),2)
        self.assertEqual(self.api.patch(self.url+"releases/",{"version":"oops"}).status_code,405)

    def test_native_files_and_future_mod_types(self):
        self.login()
        self.assertEqual(self.release(name="raw.cpbp",data=b"native-blueprint-binary").status_code,201)
        self.assertEqual(self.release("2",name="raw.cpcs",data=b"scenario").status_code,400)
        self.item.content_type=ContentType.objects.get(slug="scenarios")
        self.item.save()
        self.assertEqual(self.release("2",name="raw.cpcs",data=b"scenario").status_code,201)
        future=ContentType.objects.create(name="Future format",slug="future",allowed_extensions=[".future",".zip"],uploads_enabled=True)
        self.item.content_type=future
        self.item.save()
        self.assertEqual(self.release("3",name="file.future",data=b"raw-new-format").status_code,201)

    def test_rejects_unsafe_zips_bad_json_empty_and_wrong_extension(self):
        self.login()
        for filename,data in [("a.json",b"invalid"),("a.exe",b"binary"),("a.json",b""),("a.zip",b"not a zip")]:
            with self.subTest(filename=filename,data=data): self.assertEqual(self.release(name=filename,data=data).status_code,400)
        archive=io.BytesIO()
        with zipfile.ZipFile(archive,"w") as zipped: zipped.writestr("../../evil.json","{}")
        self.assertEqual(self.release(name="bad.zip",data=archive.getvalue()).status_code,400)
        archive=io.BytesIO()
        with zipfile.ZipFile(archive,"w") as zipped:
            zipped.writestr("pack/first.cpbp",b"native-file")
            zipped.writestr("pack/readme.txt","Mod pack")
        self.assertEqual(self.release(name="pack.zip",data=archive.getvalue()).status_code,201)

    def test_screenshots_are_reencoded_and_author_owned(self):
        self.login()
        output=io.BytesIO()
        Image.new("RGB",(30,20),(0,128,128)).save(output,"PNG")
        result=self.api.post(self.url+"screenshots/",{"image":package("shot.png",output.getvalue()),"caption":"My lot"},format="multipart")
        self.assertEqual(result.status_code,201,result.data)
        image=self.api.get(result.data["image_url"])
        self.assertEqual(image["Content-Type"],"image/webp")
        self.assertIn("no-store",image["Cache-Control"])
        self.assertTrue(b"".join(image.streaming_content).startswith(b"RIFF"))
        self.assertEqual(self.api.post(self.url+"screenshots/",{"image":package("bad.svg",b"<svg/>")},format="multipart").status_code,400)
        self.login(self.other)
        target=self.url+f'screenshots/{result.data["id"]}/'
        self.assertEqual(self.api.delete(target).status_code,403)
        self.login()
        self.assertEqual(self.api.delete(target).status_code,204)

    def test_screenshot_limit(self):
        self.login()
        self.item.screenshots.all().delete()
        out=io.BytesIO()
        Image.new("RGB",(3,3)).save(out,"PNG")
        for index in range(9):
            result=self.api.post(self.url+"screenshots/",{"image":package("shot.png",out.getvalue())},format="multipart")
            self.assertEqual(result.status_code,201 if index<8 else 400)

    def test_key_hash_scopes_expiry_and_revocation(self):
        self.login()
        result=self.api.post("/api/v1/keys/",{"name":"Reader","scopes":["read"]},format="json")
        self.assertEqual(result.status_code,201,result.data)
        raw=result.data["key"]
        key=APIKey.objects.get(pk=result.data["id"])
        self.assertIsNone(key.expires_at)
        self.assertIsNone(result.data["expires_at"])
        self.assertNotEqual(key.digest,raw)
        self.assertEqual(key.digest,hashlib.sha256(raw.encode()).hexdigest())
        self.assertNotIn(raw,str(self.api.get("/api/v1/keys/").data))
        self.api.logout()
        self.api.credentials(HTTP_AUTHORIZATION="ApiKey "+raw)
        self.assertEqual(self.api.get("/api/v1/me/").status_code,200)
        self.assertEqual(self.api.patch(self.url,{"title":"No write"}).status_code,403)
        self.assertEqual(self.api.post("/api/v1/keys/",{"name":"Nested"}).status_code,403)
        key.revoked_at=timezone.now(); key.save()
        self.assertEqual(self.api.get("/api/v1/me/").status_code,401)
        key.revoked_at=None; key.expires_at=timezone.now()-timedelta(seconds=1); key.save()
        self.assertEqual(self.api.get("/api/v1/me/").status_code,401)

    def test_optional_key_expiry_and_web_default(self):
        self.login()
        response = self.api.post("/api/v1/keys/", {"name": "No expiry", "days": None}, format="json")
        self.assertEqual(response.status_code, 201, response.data)
        self.assertIsNone(response.data["expires_at"])
        response = self.api.post("/api/v1/keys/", {"name": "Temporary", "days": 7}, format="json")
        self.assertEqual(response.status_code, 201, response.data)
        expires = APIKey.objects.get(pk=response.data["id"]).expires_at
        self.assertAlmostEqual((expires - timezone.now()).total_seconds(), 7 * 86400, delta=5)
        for days in [0, -1, 91, "never"]:
            self.assertEqual(self.api.post("/api/v1/keys/", {"name": "Invalid", "days": days}, format="json").status_code, 400)
        response = self.client.post("/account/keys/", {"name": "Web default", "scopes": ["read"]})
        self.assertEqual(response.status_code, 200)
        self.assertIsNone(APIKey.objects.get(name="Web default").expires_at)
        self.assertContains(response, "<td>Never</td>")
        self.client.post("/account/keys/", {"name": "Web expiry", "scopes": ["read"], "days": "30"})
        self.assertIsNotNone(APIKey.objects.get(name="Web expiry").expires_at)

    def test_non_expiring_keys_count_toward_active_key_limit(self):
        self.login()
        for index in range(20):
            APIKey.issue(user=self.author, name=f"Key {index}", scopes=["read"])
        self.assertEqual(self.api.post("/api/v1/keys/", {"name": "Over limit"}).status_code, 400)
        response = self.client.post("/account/keys/", {"name": "Over limit", "scopes": ["read"]})
        self.assertContains(response, "You have 20 active keys.")
        self.assertEqual(self.author.api_keys.count(), 20)
        self.author.api_keys.filter(name="Key 0").update(revoked_at=timezone.now())
        self.assertEqual(self.api.post("/api/v1/keys/", {"name": "Replacement"}).status_code, 201)
        self.author.api_keys.filter(name="Key 1").update(expires_at=timezone.now() - timedelta(seconds=1))
        self.assertEqual(self.api.post("/api/v1/keys/", {"name": "Another replacement"}).status_code, 201)
        self.assertEqual(self.author.api_keys.active().count(), 20)

    def test_oauth_key_scope_cannot_escalate_and_managers_are_isolated(self):
        app=Application.objects.create(name="Test Manager",user=self.author,client_type="public",authorization_grant_type="authorization-code",redirect_uris="http://127.0.0.1:8765/callback")
        token=AccessToken.objects.create(user=self.author,application=app,token="test-token",scope="read keys:write",expires=timezone.now()+timedelta(minutes=10))
        self.api.credentials(HTTP_AUTHORIZATION="Bearer test-token")
        denied=self.api.post("/api/v1/keys/",{"name":"Bad","scopes":["write"]},format="json")
        self.assertEqual(denied.status_code,403,denied.data)
        result=self.api.post("/api/v1/keys/",{"name":"Good","scopes":["read"]},format="json")
        self.assertEqual(result.status_code,201,result.data)
        own_key=APIKey.objects.get(pk=result.data["id"])
        self.assertIsNone(own_key.expires_at)
        self.assertEqual(own_key.application_id,app.pk)
        other,_=APIKey.issue(user=self.author,name="Personal",scopes=["read"])
        self.assertEqual(self.api.delete(f"/api/v1/keys/{other.pk}/").status_code,404)
        self.assertEqual(self.api.delete(f"/api/v1/keys/{own_key.pk}/").status_code,204)

    def test_pkce_browser_flow_tokens_and_key_mint(self):
        self.login()
        app=Application.objects.create(name="Native Manager",user=self.author,client_type="public",authorization_grant_type="authorization-code",redirect_uris="http://127.0.0.1:8765/callback",skip_authorization=False)
        verifier="a"*64
        challenge=base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
        params={"client_id":app.client_id,"redirect_uri":app.redirect_uris,"response_type":"code","scope":"read write keys:write","state":"test-state","code_challenge":challenge,"code_challenge_method":"S256"}
        consent=self.client.get("/o/authorize/",params)
        self.assertEqual(consent.status_code,200)
        self.assertContains(consent,"Native Manager")
        result=self.client.post("/o/authorize/",{**params,"allow":"Authorize"})
        self.assertEqual(result.status_code,302)
        callback=parse_qs(urlparse(result["Location"]).query)
        self.assertEqual(callback["state"],["test-state"])
        exchange={"client_id":app.client_id,"redirect_uri":app.redirect_uris,"grant_type":"authorization_code","code":callback["code"][0],"code_verifier":verifier}
        tokens=self.client.post("/o/token/",urlencode(exchange),content_type="application/x-www-form-urlencoded")
        self.assertEqual(tokens.status_code,200,tokens.content)
        data=tokens.json()
        self.assertEqual(data["expires_in"],900)
        self.assertFalse(AccessToken.objects.filter(token=data["access_token"]).exists())
        self.api.logout()
        self.api.credentials(HTTP_AUTHORIZATION="Bearer "+data["access_token"])
        self.assertEqual(self.api.get("/api/v1/me/").status_code,200)
        self.assertEqual(self.api.post("/api/v1/keys/",{"name":"Connected manager","scopes":["read","write"]},format="json").status_code,201)
        self.assertEqual(self.client.post("/o/token/",urlencode(exchange),content_type="application/x-www-form-urlencoded").status_code,400)
        refreshed=self.client.post("/o/token/",urlencode({"client_id":app.client_id,"grant_type":"refresh_token","refresh_token":data["refresh_token"]}),content_type="application/x-www-form-urlencoded")
        self.assertEqual(refreshed.status_code,200,refreshed.content)
        self.assertNotEqual(refreshed.json()["refresh_token"],data["refresh_token"])

    def test_oauth_requires_s256_and_rejects_password_grant(self):
        self.login()
        app=Application.objects.create(name="Manager",user=self.author,client_type="public",authorization_grant_type="authorization-code",redirect_uris="http://127.0.0.1:8765/callback")
        params={"client_id":app.client_id,"redirect_uri":app.redirect_uris,"response_type":"code","scope":"read","state":"state"}
        missing=self.client.get("/o/authorize/",params)
        self.assertTrue(missing.status_code==400 or "error=" in missing.get("Location",""))
        plain=self.client.get("/o/authorize/",{**params,"code_challenge":"a"*64,"code_challenge_method":"plain"})
        self.assertTrue(plain.status_code==400 or "error=" in plain.get("Location",""))
        password=self.client.post("/o/token/",urlencode({"grant_type":"password","client_id":app.client_id,"username":"author","password":"Test-Only-Password!1"}),content_type="application/x-www-form-urlencoded")
        self.assertEqual(password.status_code,400)

    def test_key_and_author_pages_render(self):
        self.login()
        for url in ["/account/keys/", "/upload/", f"/items/{self.item.pk}/edit/", "/?view=mine", "/?view=saved", "/accounts/logout/", "/accounts/3rdparty/"]:
            with self.subTest(url=url): self.assertEqual(self.client.get(url).status_code,200)

    def test_html_upload_edit_release_screenshot_and_bookmark(self):
        self.login()
        metadata={"title":"New creation","summary":"A new creation","description":"Some details","content_type":self.category.pk,"tags":"parking","status":"published"}
        result=self.client.post("/upload/",{**metadata,"version":"1.0.0","file":package(),"screenshots":[screenshot(),screenshot("second.png",(128,0,128))]})
        self.assertEqual(result.status_code,302)
        item=Item.objects.get(title="New creation")
        self.assertEqual(item.screenshots.count(),2)
        target=f"/items/{item.pk}/edit/"
        self.assertEqual(self.client.post(target,{**metadata,"title":"Edited","action":"metadata"}).status_code,302)
        self.assertEqual(item.revisions.count(),2)
        self.assertEqual(self.client.post(target,{"action":"release","version":"1.1.0","file":package()}).status_code,302)
        self.assertEqual(item.releases.count(),2)
        self.assertEqual(self.client.post(f"/items/{item.pk}/save/").status_code,302)
        self.assertEqual(item.bookmarks.count(),1)

    def test_csrf_enforced_on_session_mutations(self):
        client=APIClient(enforce_csrf_checks=True)
        client.force_login(self.author)
        self.assertEqual(client.patch(self.url,{"title":"Attack"}).status_code,403)

    def test_publish_requires_release_and_creates_draft_first(self):
        self.login()
        response=self.api.post("/api/v1/items/",{"title":"Draft","summary":"test","description":"test","content_type":"blueprints","status":"published"},format="json")
        self.assertEqual(response.status_code,201,response.data)
        self.assertEqual(response.data["status"],"draft")
        self.assertEqual(self.api.patch(f'/api/v1/items/{response.data["id"]}/',{"status":"published"}).status_code,400)

    @override_settings(DEBUG=False)
    def test_production_uploads_and_keys_without_email_verification(self):
        from allauth.account.models import EmailAddress
        EmailAddress.objects.create(user=self.author,email=self.author.email,verified=False,primary=True)
        self.client.force_login(self.author)
        for url in ["/upload/",f"/items/{self.item.pk}/edit/","/account/keys/"]:
            with self.subTest(url=url): self.assertEqual(self.client.get(url).status_code,200)
        self.api.force_login(self.author)
        self.assertEqual(self.api.post("/api/v1/keys/",{"name":"Unverified"}).status_code,201)
        self.assertEqual(self.release().status_code,201)
        self.assertEqual(self.api.patch(self.url,{"title":"Updated without verification"}).status_code,200)

    def test_manager_disconnect_revokes_all_its_credentials(self):
        self.login()
        app=Application.objects.create(name="Connected",user=self.author,client_type="public",authorization_grant_type="authorization-code",redirect_uris="http://127.0.0.1:8765/callback")
        token=AccessToken.objects.create(user=self.author,application=app,token="disconnect-token",scope="read",expires=timezone.now()+timedelta(minutes=10))
        RefreshToken.objects.create(user=self.author,application=app,token="disconnect-refresh",access_token=token)
        key,raw=APIKey.issue(user=self.author,name="Manager key",scopes=["read"],application=app)
        personal,_=APIKey.issue(user=self.author,name="Personal",scopes=["read"])
        self.assertContains(self.client.get("/account/keys/"),"Connected")
        self.assertEqual(self.client.post(f"/account/managers/{app.pk}/revoke/").status_code,302)
        self.assertFalse(AccessToken.objects.filter(application=app).exists())
        self.assertFalse(RefreshToken.objects.filter(application=app).exists())
        key.refresh_from_db(); personal.refresh_from_db()
        self.assertFalse(key.active)
        self.assertTrue(personal.active)

    def test_malformed_nested_identifiers_return_404(self):
        self.assertEqual(self.api.get(self.url+"releases/---/download/").status_code,404)
        self.assertEqual(self.api.get(self.url+"screenshots/---/image/").status_code,404)

    def test_openapi_security_and_upload_contract(self):
        from drf_spectacular.generators import SchemaGenerator
        schema=SchemaGenerator().get_schema(request=None,public=True)
        self.assertEqual(schema["openapi"],"3.1.0")
        paths=schema["paths"]
        self.assertIn({}, paths["/api/v1/items/"]["get"]["security"])
        self.assertIn({"oauth2":["write"]}, paths["/api/v1/items/{id}/"]["patch"]["security"])
        self.assertIn({"oauth2":["keys:write"]}, paths["/api/v1/keys/"]["post"]["security"])
        self.assertNotIn({"PersonalAPIKey":[]},paths["/api/v1/keys/"]["post"]["security"])
        self.assertIn("multipart/form-data", paths["/api/v1/items/{id}/releases/"]["post"]["requestBody"]["content"])
        key_days = schema["components"]["schemas"]["KeyCreateRequest"]["properties"]["days"]
        self.assertNotIn("days", schema["components"]["schemas"]["KeyCreateRequest"]["required"])
        self.assertIn("null", key_days["type"])

    def test_oauth_wrong_verifier_rejected_and_refresh_reuse_revokes(self):
        self.login()
        app=Application.objects.create(name="PKCE test",user=self.author,client_type="public",authorization_grant_type="authorization-code",redirect_uris="http://127.0.0.1:8765/callback")
        verifier="b"*64
        challenge=base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
        params={"client_id":app.client_id,"redirect_uri":app.redirect_uris,"response_type":"code","scope":"read","state":"state","code_challenge":challenge,"code_challenge_method":"S256"}
        auth=self.client.post("/o/authorize/",{**params,"allow":"Authorize"})
        code=parse_qs(urlparse(auth["Location"]).query)["code"][0]
        body={"grant_type":"authorization_code","client_id":app.client_id,"redirect_uri":app.redirect_uris,"code":code,"code_verifier":"c"*64}
        def exchange(data): return self.client.post("/o/token/",urlencode(data),content_type="application/x-www-form-urlencoded")
        self.assertEqual(exchange(body).status_code,400)
        body["code_verifier"]=verifier
        token=exchange(body).json()
        refresh={"grant_type":"refresh_token","client_id":app.client_id,"refresh_token":token["refresh_token"]}
        rotated=exchange(refresh)
        self.assertEqual(rotated.status_code,200)
        self.assertEqual(exchange(refresh).status_code,400)
        self.api.logout()
        self.api.credentials(HTTP_AUTHORIZATION="Bearer "+rotated.json()["access_token"])
        self.assertEqual(self.api.get("/api/v1/me/").status_code,401)

    def test_raw_scenario_is_allowed_in_blueprint_pack(self):
        self.login()
        self.item.content_type=ContentType.objects.get(slug="blueprint-packs")
        self.item.save()
        self.assertEqual(self.release(name="pack.cpcs",data=b"scenario-container").status_code,201)

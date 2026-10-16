from types import SimpleNamespace
from unittest.mock import Mock, patch
from urllib.parse import parse_qs, urlsplit

from allauth.socialaccount.models import SocialAccount
from django.contrib.auth import get_user_model
from django.core import mail
from django.test import Client, TestCase, override_settings
from openid.consumer.consumer import SUCCESS


PROVIDERS = {
    "steam": {"APPS": [{"client_id": "test-steam", "secret": "test-steam"}]},
    "discord": {"APPS": [{"client_id": "test-discord", "secret": "test-discord"}], "SCOPE": ["identify"]},
}


@override_settings(DEBUG=True, SECURE_SSL_REDIRECT=False, SOCIALACCOUNT_PROVIDERS=PROVIDERS,
                   EMAIL_BACKEND="django.core.mail.backends.locmem.EmailBackend")
class AccountTests(TestCase):
    def discord_flow(self, uid="discord-test", username="DiscordPlayer", connect=False):
        url = "/accounts/discord/login/"
        if connect:
            url += "?process=connect&next=/account/profile/"
        start = self.client.post(url)
        self.assertEqual(start.status_code, 302)
        query = parse_qs(urlsplit(start["Location"]).query)
        self.assertEqual(query["scope"], ["identify"])
        profile = Mock()
        profile.json.return_value = {"id": uid, "username": username, "discriminator": "0"}
        with patch("allauth.socialaccount.providers.oauth2.client.OAuth2Client.get_access_token",
                   return_value={"access_token": "test-token", "token_type": "Bearer"}), \
             patch("requests.Session.get", return_value=profile):
            return self.client.get("/accounts/discord/login/callback/",
                                   {"state": query["state"][0], "code": "test-code"})

    def test_password_authentication_and_generic_openid_are_unavailable(self):
        user = get_user_model().objects.create_superuser("oldadmin", password="OldPassword!123")
        login = self.client.get("/accounts/login/")
        self.assertContains(login, "Sign in through Steam")
        self.assertContains(login, "Continue with Discord")
        self.assertNotContains(login, 'type="password"')
        self.assertEqual(self.client.post("/accounts/login/", {"login": user.username, "password": "OldPassword!123"}).status_code, 403)
        self.assertEqual(self.client.post("/admin/login/", {"username": user.username, "password": "OldPassword!123"}).status_code, 302)
        self.assertNotIn("_auth_user_id", self.client.session)
        for url in ["/accounts/signup/", "/accounts/password/reset/", "/accounts/password/set/",
                    "/accounts/password/change/", "/accounts/openid/login/"]:
            self.assertEqual(self.client.get(url).status_code, 404, url)

    def test_steam_signup_without_email_or_password(self):
        with patch("allauth.socialaccount.providers.steam.provider._openid_consumer") as consumer:
            consumer.return_value.begin.return_value.redirectURL.return_value = "https://steamcommunity.com/openid/login"
            self.assertEqual(self.client.post("/accounts/steam/login/").status_code, 302)
        verified = SimpleNamespace(status=SUCCESS, identity_url="https://steamcommunity.com/openid/id/76561198000000001")
        with patch("allauth.socialaccount.providers.openid.views.OpenIDCallbackView.get_openid_response", return_value=verified), \
             patch("allauth.socialaccount.providers.steam.provider.request_steam_account_summary",
                   return_value={"steamid": "76561198000000001", "personaname": "SteamPlayer"}):
            response = self.client.get("/accounts/steam/callback/", {"openid.op_endpoint": "https://steamcommunity.com/openid/login"})
        self.assertRedirects(response, "/", fetch_redirect_response=False)
        user = SocialAccount.objects.get(provider="steam").user
        self.assertEqual(user.email, "")
        self.assertFalse(user.has_usable_password())
        self.assertFalse(user.is_staff)
        self.assertEqual(int(self.client.session["_auth_user_id"]), user.pk)
        self.assertEqual(len(mail.outbox), 0)

    def test_discord_signup_and_subsequent_login_use_same_account(self):
        self.assertRedirects(self.discord_flow(), "/", fetch_redirect_response=False)
        account = SocialAccount.objects.get(provider="discord")
        self.assertFalse(account.user.has_usable_password())
        self.client.logout()
        self.discord_flow()
        self.assertEqual(get_user_model().objects.count(), 1)
        self.assertEqual(int(self.client.session["_auth_user_id"]), account.user_id)
        self.assertEqual(len(mail.outbox), 0)

    def test_link_discord_to_existing_steam_profile(self):
        user = get_user_model().objects.create_user("SteamOwner")
        SocialAccount.objects.create(user=user, provider="steam", uid="76561198000000001")
        self.client.force_login(user)
        response = self.discord_flow(connect=True)
        self.assertRedirects(response, "/account/profile/", fetch_redirect_response=False)
        self.assertEqual(SocialAccount.objects.get(provider="discord").user_id, user.pk)
        self.assertEqual(get_user_model().objects.count(), 1)
        page = self.client.get("/account/profile/")
        self.assertContains(page, "Link Steam")
        self.assertContains(page, "Link Discord")
        self.assertContains(page, "process=connect")
        self.assertEqual(page["Cache-Control"], "private, no-store")

    def test_account_linked_to_someone_else_cannot_be_taken(self):
        owner = get_user_model().objects.create_user("DiscordOwner")
        stranger = get_user_model().objects.create_user("Stranger")
        account = SocialAccount.objects.create(user=owner, provider="discord", uid="already-linked")
        self.client.force_login(stranger)
        self.discord_flow(uid="already-linked", connect=True)
        account.refresh_from_db()
        self.assertEqual(account.user_id, owner.pk)
        self.assertEqual(int(self.client.session["_auth_user_id"]), stranger.pk)

    def test_disconnect_requires_ownership_csrf_and_another_login(self):
        owner = get_user_model().objects.create_user("Owner", password="StillCannotUnlink!123")
        other = get_user_model().objects.create_user("Other")
        steam = SocialAccount.objects.create(user=owner, provider="steam", uid="steam-owner")
        theirs = SocialAccount.objects.create(user=other, provider="steam", uid="steam-other")
        self.client.force_login(owner)
        for account in [steam, theirs]:
            self.assertEqual(self.client.post("/account/profile/", {"account": account.pk}).status_code, 200)
            self.assertTrue(SocialAccount.objects.filter(pk=account.pk).exists())
        discord = SocialAccount.objects.create(user=owner, provider="discord", uid="discord-owner")
        csrf_client = Client(enforce_csrf_checks=True)
        csrf_client.force_login(owner)
        self.assertEqual(csrf_client.post("/account/profile/", {"account": steam.pk}).status_code, 403)
        self.assertRedirects(self.client.post("/account/profile/", {"account": steam.pk}), "/account/profile/", fetch_redirect_response=False)
        self.assertFalse(SocialAccount.objects.filter(pk=steam.pk).exists())
        self.assertEqual(self.client.post("/accounts/3rdparty/", {"account": discord.pk}).status_code, 200)
        self.assertTrue(SocialAccount.objects.filter(pk=discord.pk).exists())

    def test_callback_with_unknown_state_cannot_sign_in(self):
        with patch("allauth.socialaccount.providers.oauth2.client.OAuth2Client.get_access_token") as exchange:
            self.client.get("/accounts/discord/login/callback/", {"state": "wrong", "code": "unused"})
            exchange.assert_not_called()
        self.assertNotIn("_auth_user_id", self.client.session)

    def test_profile_requires_login_and_admin_requires_staff(self):
        self.assertEqual(self.client.get("/account/profile/").status_code, 302)
        self.assertRedirects(self.client.get("/admin/login/"), "/accounts/login/?next=/admin/", fetch_redirect_response=False)
        user = get_user_model().objects.create_user("Regular")
        self.client.force_login(user)
        self.assertEqual(self.client.get("/admin/login/").status_code, 403)
        user.is_staff = user.is_superuser = True
        user.save()
        self.assertRedirects(self.client.get("/admin/login/"), "/admin/", fetch_redirect_response=False)

// Generated from migrations by npm run types:db. Do not edit.
export interface DatabaseTables {
  account_emailaddress: {
    id: number;
    verified: number;
    primary: number;
    user_id: number;
    email: string;
  };
  account_emailconfirmation: {
    id: number;
    created: string;
    sent: string | null;
    key: string;
    email_address_id: number;
  };
  auth_group: {
    id: number;
    name: string;
  };
  auth_group_permissions: {
    id: number;
    group_id: number;
    permission_id: number;
  };
  auth_permission: {
    id: number;
    content_type_id: number;
    codename: string;
    name: string;
  };
  auth_user: {
    id: number;
    password: string;
    last_login: string | null;
    is_superuser: number;
    username: string;
    last_name: string;
    email: string;
    is_staff: number;
    is_active: number;
    date_joined: string;
    first_name: string;
    username_changed_at: number | null;
    passkey_user_handle: string | null;
  };
  auth_user_groups: {
    id: number;
    user_id: number;
    group_id: number;
  };
  auth_user_user_permissions: {
    id: number;
    user_id: number;
    permission_id: number;
  };
  django_admin_log: {
    id: number;
    object_id: string | null;
    object_repr: string;
    action_flag: number;
    change_message: string;
    content_type_id: number | null;
    user_id: number;
    action_time: string;
  };
  django_content_type: {
    id: number;
    app_label: string;
    model: string;
  };
  django_migrations: {
    id: number;
    app: string;
    name: string;
    applied: string;
  };
  django_session: {
    session_key: string;
    session_data: string;
    expire_date: string;
  };
  hub_accountactivity: {
    id: number;
    item_title: string;
    action: string;
    ip_address: string | null;
    ip_source: string;
    user_agent: string;
    accept_language: string;
    auth_method: string;
    provider_uid: string;
    request_path: string;
    cf_ray: string;
    created_at: string;
    item_id: string | null;
    user_id: number;
  };
  hub_apikey: {
    id: string;
    name: string;
    prefix: string;
    digest: string;
    scopes: string;
    created_at: string;
    last_used_at: string | null;
    revoked_at: string | null;
    application_id: number | null;
    user_id: number;
    expires_at: string | null;
  };
  hub_bookmark: {
    id: number;
    created_at: string;
    user_id: number;
    item_id: string;
  };
  hub_contenttype: {
    id: number;
    name: string;
    slug: string;
    description: string;
    allowed_extensions: string;
    position: number;
    uploads_enabled: number;
  };
  hub_downloadip: {
    id: number;
    network: string;
    expires_at: string;
    item_id: string;
    release_id: string | null;
  };
  hub_downloaduser: {
    id: number;
    item_id: string;
    release_id: string | null;
    user_id: number;
  };
  hub_filedeletion: {
    id: number;
    name: string;
    created_at: string;
    bucket: string | null;
    not_before: number;
    attempts: number;
  };
  hub_item: {
    id: string;
    title: string;
    summary: string;
    description: string;
    tags: string;
    status: string;
    is_demo: number;
    artwork: number;
    downloads: number;
    created_at: string;
    updated_at: string;
    author_id: number;
    content_type_id: number;
    featured_at: string | null;
    featured_by_id: number | null;
    hidden_at: string | null;
    hidden_by_id: number | null;
    hidden_reason: string;
    is_hidden: number;
    deleted_at: string | null;
    content_revision: number;
    review_requested_at: string;
    reviewed_revision: number;
    publish_after_validation: number;
  };
  hub_item_tag_index: {
    id: number;
    item_id: string;
    tag_id: number;
  };
  hub_itemreview: {
    id: number;
    content_revision: number;
    note: string;
    created_at: string;
    item_id: string;
    reviewer_id: number | null;
  };
  hub_moderationlog: {
    id: number;
    item_title: string;
    username: string;
    action: string;
    reason: string;
    created_at: string;
    actor_id: number | null;
    item_id: string | null;
    target_user_id: number | null;
  };
  hub_release: {
    id: string;
    version: string;
    game_version: string;
    changelog: string;
    file: string;
    original_filename: string;
    sha256: string;
    size: number;
    downloads: number;
    created_at: string;
    item_id: string;
    file_stats: string;
  };
  hub_revision: {
    id: number;
    snapshot: string;
    created_at: string;
    editor_id: number | null;
    item_id: string;
  };
  hub_screenshot: {
    id: string;
    image: string;
    caption: string;
    created_at: string;
    item_id: string;
  };
  hub_sitemapentry: {
    id: number;
    path: string;
    last_modified: string | null;
    author_id: number | null;
    item_id: string | null;
  };
  hub_sitemapstate: {
    id: number;
    generated_at: string;
  };
  hub_storageusage: {
    id: number;
    backend: string;
    object_count: number;
    size_bytes: number;
    measured_at: string;
  };
  hub_tag: {
    id: number;
    name: string;
    category_group: string;
  };
  hub_tagsettings: {
    id: number;
    minimum_items: number;
  };
  hub_uploadevent: {
    id: number;
    created_at: string;
    user_id: number;
  };
  hub_uploadjob: {
    id: string;
    kind: string;
    status: string;
    original_filename: string;
    size: number;
    sha256: string;
    metadata: string;
    error: string;
    created_at: string;
    completed_at: string | null;
    item_id: string;
    release_id: string | null;
    screenshot_id: string | null;
    submitted_by_id: number | null;
  };
  hub_uploadsettings: {
    id: number;
    max_file_mb: number;
  };
  hub_usermoderation: {
    id: number;
    shadow_banned_at: string | null;
    shadow_banned_by_id: number | null;
    user_id: number;
  };
  hub_userpreferences: {
    id: number;
    ugc_warning_version: number;
    ugc_warning_acknowledged_at: string | null;
    user_id: number;
  };
  oauth2_provider_accesstoken: {
    id: number;
    token: string;
    expires: string;
    scope: string;
    application_id: number | null;
    user_id: number | null;
    created: string;
    updated: string;
    source_refresh_token_id: number | null;
    id_token_id: number | null;
    token_checksum: string;
    resource: string;
  };
  oauth2_provider_application: {
    id: number;
    redirect_uris: string;
    client_type: string;
    authorization_grant_type: string;
    client_secret: string;
    name: string;
    user_id: number | null;
    skip_authorization: number;
    created: string;
    updated: string;
    algorithm: string;
    post_logout_redirect_uris: string;
    hash_client_secret: number;
    allowed_origins: string;
    registration_source: string;
    cimd_expires_at: string | null;
    client_id: string;
  };
  oauth2_provider_devicegrant: {
    id: number;
    device_code: string;
    user_code: string;
    interval: number;
    expires: string;
    status: string;
    client_id: string;
    last_checked: string;
    user_id: number | null;
    scope: string;
  };
  oauth2_provider_grant: {
    id: number;
    code: string;
    expires: string;
    redirect_uri: string;
    scope: string;
    application_id: number;
    user_id: number;
    created: string;
    updated: string;
    code_challenge: string;
    code_challenge_method: string;
    nonce: string;
    claims: string;
    resource: string;
  };
  oauth2_provider_idtoken: {
    id: number;
    jti: string;
    expires: string;
    scope: string;
    created: string;
    updated: string;
    application_id: number | null;
    user_id: number | null;
  };
  oauth2_provider_refreshtoken: {
    id: number;
    token: string;
    access_token_id: number | null;
    application_id: number;
    user_id: number;
    created: string;
    updated: string;
    revoked: string | null;
    token_family: string | null;
    token_checksum: string;
    resource: string;
  };
  openid_openidnonce: {
    id: number;
    server_url: string;
    timestamp: number;
    salt: string;
    date_created: string;
  };
  openid_openidstore: {
    id: number;
    server_url: string;
    handle: string;
    secret: string;
    issued: number;
    lifetime: number;
    assoc_type: string;
  };
  socialaccount_socialaccount: {
    id: number;
    provider: string;
    uid: string;
    last_login: string;
    date_joined: string;
    user_id: number;
    extra_data: string;
  };
  socialaccount_socialapp: {
    id: number;
    provider: string;
    name: string;
    client_id: string;
    secret: string;
    key: string;
    provider_id: string;
    settings: string;
  };
  socialaccount_socialtoken: {
    id: number;
    token: string;
    token_secret: string;
    expires_at: string | null;
    account_id: number;
    app_id: number | null;
  };
  worker_cache_revision: {
    id: number;
    revision: number;
  };
  worker_collection_revision: {
    user_id: number;
    revision: number;
  };
  worker_cost_estimate: {
    id: number;
    payload: string;
    updated_at: string;
  };
  worker_job: {
    id: string;
    object_key: string;
    output_key: string | null;
    attempts: number;
    lease_until: number;
  };
  worker_login: {
    state: string;
    provider: string;
    expires_at: number;
    nonce: string;
  };
  worker_monthly_cost: {
    id: number;
    amount_cents: number;
    currency: string;
    month: string;
    updated_at: string;
  };
  worker_nonce: {
    nonce: string;
    expires_at: number;
  };
  worker_oauth_code: {
    digest: string;
    user_id: number;
    client_id: string;
    redirect_uri: string;
    challenge: string;
    scope: string;
    expires_at: number;
  };
  worker_passkey: {
    id: string;
    user_id: number;
    public_key: string;
    counter: number;
    transports: string;
    device_type: string;
    backed_up: number;
    created_at: string;
    last_used_at: string | null;
  };
  worker_passkey_challenge: {
    digest: string;
    kind: string;
    challenge: string;
    user_id: number | null;
    session_digest: string | null;
    user_handle: string | null;
    username: string | null;
    expires_at: number;
  };
  worker_session: {
    digest: string;
    user_id: number;
    csrf: string;
    expires_at: number;
  };
  worker_task: {
    name: string;
    lease_until: number;
  };
  worker_token: {
    digest: string;
    user_id: number;
    client_id: string;
    scope: string;
    kind: string;
    family: string;
    expires_at: number;
  };
}

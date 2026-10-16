"""Create a bucket-scoped application identity; keep root credentials out of Django."""
import argparse
import json
import os
import re
import tempfile
from pathlib import Path

import boto3
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError


def read_values(path):
    return dict(line.split("=", 1) for line in path.read_text().splitlines()
                if "=" in line and not line.lstrip().startswith("#"))


def write_env(path, updates):
    lines = path.read_text().splitlines()
    names = set(updates)
    lines = [line for line in lines if line.partition("=")[0] not in names]
    lines += [f"{key}={value}" for key, value in updates.items()]
    fd, temporary = tempfile.mkstemp(prefix=".env.", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as output:
            output.write("\n".join(lines) + "\n")
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def provision(credentials_path, env_path, user_name):
    config = {k: v.strip() for k, v in read_values(credentials_path).items()}
    env = read_values(env_path)
    bucket = config["bucket"]
    if not re.fullmatch(r"[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]", bucket):
        raise ValueError("Invalid bucket name.")
    credentials = {"aws_access_key_id": config["access-key"], "aws_secret_access_key": config["secret-key"]}
    client_config = Config(signature_version="s3v4", connect_timeout=5, read_timeout=30, retries={"max_attempts": 2})
    s3 = boto3.client("s3", endpoint_url="https://s3.wasabisys.com", region_name="us-east-1", config=client_config, **credentials)
    region = s3.get_bucket_location(Bucket=bucket).get("LocationConstraint") or "us-east-1"
    endpoint = f"https://s3.{region}.wasabisys.com"
    s3 = boto3.client("s3", endpoint_url=endpoint, region_name=region, config=client_config, **credentials)
    acl = s3.get_bucket_acl(Bucket=bucket)
    if any(g["Grantee"]["Type"] != "CanonicalUser" or g["Grantee"].get("ID") != acl["Owner"]["ID"]
           for g in acl["Grants"]):
        raise ValueError("The bucket has shared ACL grants. Remove public/shared grants before using it for private uploads.")
    try:
        s3.get_bucket_policy(Bucket=bucket)
    except ClientError as exc:
        if exc.response["Error"]["Code"] != "NoSuchBucketPolicy":
            raise
    else:
        raise ValueError("This bucket has an existing policy. Review it before provisioning private uploads.")

    iam = boto3.client("iam", endpoint_url="https://iam.wasabisys.com", region_name="us-east-1", **credentials)
    try:
        user = iam.get_user(UserName=user_name)["User"]
        if env.get("WASABI_IAM_USER") != user_name:
            raise ValueError("The IAM user already exists and is not recorded in this environment file.")
    except ClientError as exc:
        if exc.response["Error"]["Code"] != "NoSuchEntity":
            raise
        user = iam.create_user(UserName=user_name)["User"]
        write_env(env_path, {"WASABI_IAM_USER": user_name})

    policy_name = f"{user_name}-storage"
    policy = json.loads((Path(__file__).resolve().parents[1] / "deploy/wasabi-ugc-policy.json").read_text().replace("__BUCKET__", bucket))
    try:
        arn = iam.create_policy(PolicyName=policy_name, PolicyDocument=json.dumps(policy))["Policy"]["Arn"]
    except ClientError as exc:
        if exc.response["Error"]["Code"] != "EntityAlreadyExists":
            raise
        arn = f"arn:aws:iam::{user['Arn'].split(':')[4]}:policy/{policy_name}"
        existing = iam.get_policy(PolicyArn=arn)["Policy"]
        document = iam.get_policy_version(PolicyArn=arn, VersionId=existing["DefaultVersionId"])["PolicyVersion"]["Document"]
        if document != policy:
            raise ValueError("Existing application policy differs from the expected permissions.")
    iam.attach_user_policy(UserName=user_name, PolicyArn=arn)

    access_key = env.get("WASABI_ACCESS_KEY_ID")
    secret_key = env.get("WASABI_SECRET_ACCESS_KEY")
    if not (access_key and secret_key):
        key = iam.create_access_key(UserName=user_name)["AccessKey"]
        access_key, secret_key = key["AccessKeyId"], key["SecretAccessKey"]
    write_env(env_path, {
        "WASABI_IAM_USER": user_name, "WASABI_BUCKET_NAME": bucket, "WASABI_REGION": region,
        "WASABI_ENDPOINT_URL": endpoint, "WASABI_ACCESS_KEY_ID": access_key,
        "WASABI_SECRET_ACCESS_KEY": secret_key, "WASABI_SIGNED_URL_SECONDS": "300",
        # Cut over only after the existing files have been copied and verified.
        "MEDIA_STORAGE": env.get("MEDIA_STORAGE", "local"),
    })
    print(f"Configured {user_name} for bucket {bucket} in {region}. Restricted credentials saved to {env_path.name}.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--credentials-file", required=True, type=Path)
    parser.add_argument("--env-file", type=Path, default=Path(".env"))
    parser.add_argument("--user", default="cpchub-ugc-app")
    args = parser.parse_args()
    try:
        provision(args.credentials_file, args.env_file, args.user)
    except (BotoCoreError, ClientError, ValueError, KeyError, OSError) as exc:
        # Provider messages can contain identifiers; report only the error code.
        code = exc.response["Error"]["Code"] if isinstance(exc, ClientError) else type(exc).__name__
        raise SystemExit(f"Provisioning stopped ({code}). No root credentials were written to the application environment.")

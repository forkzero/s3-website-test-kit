#!/bin/bash
set -euo pipefail

# Upload the conformance dataset into an EXISTING bucket, with the exact
# content-types the conformance suite asserts, and set up the deterministic 403
# case via a bucket policy (not a legacy object ACL, which is a no-op under
# BucketOwnerEnforced / Block Public Access).
#
# To create the bucket from scratch as well, use bootstrap-s3-target.sh, which
# calls this script for the data step.
#
#   BUCKET=my-test-bucket ./setup-s3-data.sh
#
# Env:
#   BUCKET       (required) target bucket — no default; fails if unset.
#   AWS_REGION   (default: us-east-1)
#   PUBLIC_READ  (default: false) also grant anonymous s3:GetObject on the
#                dataset so the bucket can serve native S3 static-website
#                hosting. Requires Block Public Access to be disabled on the
#                bucket (bootstrap-s3-target.sh does this for you).

if [[ -z "${BUCKET:-}" ]]; then
  echo "Error: BUCKET is required." >&2
  echo "Usage: BUCKET=my-test-bucket [AWS_REGION=us-east-1] [PUBLIC_READ=true] $0" >&2
  exit 2
fi
REGION=${AWS_REGION:-"us-east-1"}
PUBLIC_READ=${PUBLIC_READ:-"false"}

echo "Uploading conformance dataset..."
echo "Bucket: $BUCKET"
echo "Region: $REGION"

if ! command -v aws &> /dev/null; then
    echo "Error: AWS CLI is not installed or not in PATH" >&2
    exit 1
fi

# Verify the bucket exists / is accessible before doing work.
if ! aws s3api head-bucket --bucket "$BUCKET" --region "$REGION" > /dev/null 2>&1; then
    echo "Error: cannot access bucket s3://$BUCKET" >&2
    echo "Create it first (see bootstrap-s3-target.sh) or check your credentials/permissions." >&2
    exit 1
fi

TEMP_DIR=$(mktemp -d)
trap 'rm -rf "$TEMP_DIR"' EXIT
echo "Staging test files in: $TEMP_DIR"

# index.html (338 bytes)
cat > "$TEMP_DIR/index.html" << 'EOF'
<!doctype html>

<html lang="en">
<head>
  <meta charset="utf-8">

  <title>s3proxy</title>
  <meta name="description" content="s3proxy landing page">
  <meta name="author" content="George Moon">
</head>

<body>
<h1>s3proxy public landing page</h1>
The public repo is <a href="https://github.com/gmoon/s3proxy">here</a>.
</body>
</html>

EOF

# large.bin (10 MB) and test1m.tmp (1 MB) — varied binary content.
gen_random() {
  local out="$1" bytes="$2" kb=$((${2} / 1024))
  if command -v openssl &> /dev/null; then
    openssl rand -out "$out" "$bytes"
  elif [[ -r /dev/urandom ]]; then
    dd if=/dev/urandom of="$out" bs=1024 count="$kb" 2>/dev/null
  else
    echo "Warning: no random source; generating pattern-based file for $out" >&2
    python3 -c "
with open('$out','wb') as f:
    f.write(bytes((i % 256) for i in range($bytes)))
"
  fi
}
echo "Generating large.bin (10MB)..."
gen_random "$TEMP_DIR/large.bin" 10485760
echo "Generating test1m.tmp (1MB)..."
gen_random "$TEMP_DIR/test1m.tmp" 1048576

# zerobytefile (0 bytes)
: > "$TEMP_DIR/zerobytefile"

# unauthorized.html — served 403 via the bucket policy below.
cat > "$TEMP_DIR/unauthorized.html" << 'EOF'
<!DOCTYPE html>
<html>
<head>
    <title>Unauthorized</title>
</head>
<body>
    <h1>This file should return 403</h1>
</body>
</html>
EOF

# Special-characters key (46 bytes). Exact literal key that the encoded
# conformance/range URLs decode to.
SPECIAL_CHARS_FILE="specialCharacters!-_.*'()&\$@=;:+  ,?\\{^}%\`]\">[~<#|."
echo "Test file with special characters in filename" > "$TEMP_DIR/$SPECIAL_CHARS_FILE"

echo ""
echo "Uploading files with conformance content-types..."

# key : local-file : content-type  (content-types must match conformance.yml)
upload() {
  local key="$1" file="$2" ctype="$3"
  aws s3api put-object \
    --bucket "$BUCKET" --region "$REGION" \
    --key "$key" --body "$file" --content-type "$ctype" \
    --no-cli-pager > /dev/null
  echo "  ✓ $key ($ctype)"
}
upload "index.html"          "$TEMP_DIR/index.html"          "text/html"
upload "large.bin"           "$TEMP_DIR/large.bin"           "application/octet-stream"
upload "test1m.tmp"          "$TEMP_DIR/test1m.tmp"          "binary/octet-stream"
upload "zerobytefile"        "$TEMP_DIR/zerobytefile"        "binary/octet-stream"
upload "unauthorized.html"   "$TEMP_DIR/unauthorized.html"   "text/html"
upload "$SPECIAL_CHARS_FILE" "$TEMP_DIR/$SPECIAL_CHARS_FILE" "binary/octet-stream"

# Deterministic 403: an explicit Deny on s3:GetObject for unauthorized.html.
# Explicit Deny beats every Allow (including the bucket owner's), so s3proxy —
# which reads with owner credentials — gets AccessDenied -> 403. Works under
# BucketOwnerEnforced / Block Public Access, where the old object ACL was a no-op.
# Optionally also grant anonymous read on everything else for native S3 website
# hosting. NOTE: this REPLACES the bucket policy — intended for a dedicated test
# bucket, not a shared one.
echo ""
echo "Applying bucket policy (403 on unauthorized.html)..."
DENY_STMT=$(cat <<EOF
    {
      "Sid": "DenyUnauthorizedGetObject",
      "Effect": "Deny",
      "Principal": "*",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::$BUCKET/unauthorized.html"
    }
EOF
)
if [[ "$PUBLIC_READ" == "true" ]]; then
  ALLOW_STMT=$(cat <<EOF
    {
      "Sid": "PublicReadGetObject",
      "Effect": "Allow",
      "Principal": "*",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::$BUCKET/*"
    },
EOF
)
  echo "  (PUBLIC_READ=true: also granting anonymous read for native S3 website hosting)"
else
  ALLOW_STMT=""
fi
POLICY=$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
$ALLOW_STMT$DENY_STMT
  ]
}
EOF
)
if aws s3api put-bucket-policy --bucket "$BUCKET" --region "$REGION" --policy "$POLICY" 2>/dev/null; then
  echo "  ✓ bucket policy applied"
else
  echo "  ⚠️  Could not apply bucket policy." >&2
  if [[ "$PUBLIC_READ" == "true" ]]; then
    echo "     A public-read Allow needs Block Public Access disabled (see bootstrap-s3-target.sh)." >&2
  fi
  echo "     unauthorized.html may not return 403." >&2
fi

echo ""
echo "Verifying uploads..."
aws s3 ls "s3://$BUCKET/" --region "$REGION" --human-readable --summarize

echo ""
echo "✅ Dataset ready in s3://$BUCKET/"

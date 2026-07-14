#!/bin/bash
set -euo pipefail

# Stand up (or tear down) a complete S3 conformance target from scratch in any
# account: create the bucket, load the dataset with the asserted content-types,
# and set the deterministic 403 case — everything the conformance suite expects.
# The data + policy step is delegated to the sibling setup-s3-data.sh.
#
#   BUCKET=my-test-bucket ./bootstrap-s3-target.sh            # create + load
#   BUCKET=my-test-bucket PUBLIC_READ=true ./bootstrap-s3-target.sh   # + native-website public read
#   BUCKET=my-test-bucket ./bootstrap-s3-target.sh teardown   # delete everything
#
# Commands:
#   create    (default) Create the bucket (if needed) and load the dataset.
#   teardown  Empty the bucket, drop its policy, and delete the bucket.
#
# Env:
#   BUCKET       (required) target bucket.
#   AWS_REGION   (default: us-east-1)
#   PUBLIC_READ  (default: false) also serve native S3 static-website hosting:
#                disables Block Public Access and grants anonymous read. Leave
#                false for an s3proxy-only target (s3proxy uses its own creds).

COMMAND="${1:-create}"

if [[ -z "${BUCKET:-}" ]]; then
  echo "Error: BUCKET is required." >&2
  echo "Usage: BUCKET=my-test-bucket [AWS_REGION=us-east-1] [PUBLIC_READ=true] $0 [create|teardown]" >&2
  exit 2
fi
REGION=${AWS_REGION:-"us-east-1"}
PUBLIC_READ=${PUBLIC_READ:-"false"}
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v aws &> /dev/null; then
  echo "Error: AWS CLI is not installed or not in PATH" >&2
  exit 1
fi

bucket_exists() {
  aws s3api head-bucket --bucket "$BUCKET" --region "$REGION" > /dev/null 2>&1
}

create_bucket() {
  if bucket_exists; then
    echo "Bucket s3://$BUCKET already exists — reusing it."
    return
  fi
  echo "Creating bucket s3://$BUCKET in $REGION..."
  # us-east-1 must NOT be given a LocationConstraint; every other region must.
  if [[ "$REGION" == "us-east-1" ]]; then
    aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" > /dev/null
  else
    aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" \
      --create-bucket-configuration "LocationConstraint=$REGION" > /dev/null
  fi
  echo "  ✓ bucket created"
}

case "$COMMAND" in
  create)
    create_bucket

    if [[ "$PUBLIC_READ" == "true" ]]; then
      # A public-read bucket policy is rejected while Block Public Access is on.
      echo "Disabling Block Public Access (PUBLIC_READ=true)..."
      aws s3api put-public-access-block --bucket "$BUCKET" --region "$REGION" \
        --public-access-block-configuration \
        BlockPublicAcls=false,IgnorePublicAcls=false,BlockPublicPolicy=false,RestrictPublicBuckets=false \
        > /dev/null
      echo "  ✓ Block Public Access disabled"
    fi

    # Delegate the dataset + bucket-policy (403) step.
    BUCKET="$BUCKET" AWS_REGION="$REGION" PUBLIC_READ="$PUBLIC_READ" \
      bash "$SCRIPT_DIR/setup-s3-data.sh"

    echo ""
    echo "✅ Conformance target ready: s3://$BUCKET"
    echo "   Run the conformance gate against it once it's fronted by a server:"
    echo "     artillery run --config configs/conformance.yml --target <URL> scenarios/core/conformance.yml"
    ;;

  teardown)
    if ! bucket_exists; then
      echo "Bucket s3://$BUCKET does not exist — nothing to tear down."
      exit 0
    fi
    echo "Tearing down s3://$BUCKET ..."
    aws s3api delete-bucket-policy --bucket "$BUCKET" --region "$REGION" 2>/dev/null \
      && echo "  ✓ bucket policy removed" || echo "  (no bucket policy)"
    aws s3 rm "s3://$BUCKET" --region "$REGION" --recursive > /dev/null \
      && echo "  ✓ objects deleted"
    aws s3api delete-bucket --bucket "$BUCKET" --region "$REGION" \
      && echo "  ✓ bucket deleted"
    echo "✅ Teardown complete."
    ;;

  *)
    echo "Error: unknown command '$COMMAND' (expected 'create' or 'teardown')." >&2
    exit 2
    ;;
esac

#!/bin/bash
# Apply S3 lifecycle rule to delete staging images after 24 hours

set -e

BUCKET="mirror-uploads-sparago-2026"
LIFECYCLE_CONFIG="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/s3-lifecycle-staging.json"

echo "Applying lifecycle rule to bucket: $BUCKET"
echo "Configuration file: $LIFECYCLE_CONFIG"
echo ""

# Check if AWS CLI is installed
if ! command -v aws &> /dev/null; then
    echo "Error: AWS CLI is not installed"
    echo "Install it with: brew install awscli"
    exit 1
fi

# Check if AWS credentials are configured
if ! aws sts get-caller-identity &> /dev/null; then
    echo "Error: AWS credentials are not configured"
    echo ""
    echo "You can configure them by:"
    echo "1. Running: aws configure"
    echo "2. Or setting environment variables:"
    echo "   export AWS_ACCESS_KEY_ID=your_access_key"
    echo "   export AWS_SECRET_ACCESS_KEY=your_secret_key"
    echo "   export AWS_DEFAULT_REGION=us-east-1"
    echo ""
    echo "Or you can apply this manually via AWS Console:"
    echo "1. Go to: https://s3.console.aws.amazon.com/s3/buckets/$BUCKET"
    echo "2. Click 'Management' tab"
    echo "3. Click 'Create lifecycle rule'"
    echo "4. Rule name: DeleteStagingImagesAfter24Hours"
    echo "5. Prefix: staging/"
    echo "6. Expiration: 1 day"
    exit 1
fi

# Apply the lifecycle configuration
echo "Applying lifecycle configuration..."
aws s3api put-bucket-lifecycle-configuration \
  --bucket "$BUCKET" \
  --lifecycle-configuration "file://$LIFECYCLE_CONFIG"

if [ $? -eq 0 ]; then
    echo ""
    echo "✓ Lifecycle rule applied successfully!"
    echo ""
    echo "The rule will automatically delete objects in staging/ after 24 hours."
    echo ""
    echo "To verify, run:"
    echo "  aws s3api get-bucket-lifecycle-configuration --bucket $BUCKET"
else
    echo ""
    echo "✗ Failed to apply lifecycle rule"
    exit 1
fi


#!/usr/bin/env bash
# Usage: ./scripts/add-admin.sh someone@example.com
# Cognito emails them a temporary password. On first sign-in at /admin.html they choose a new
# password and scan a QR code with an authenticator app (Google Authenticator, Authy, 1Password...).
set -euo pipefail
EMAIL="${1:?Usage: $0 email@example.com}"
POOL=$(node -e "console.log(require('./outputs.json').UnionElection.UserPoolId)")
aws cognito-idp admin-create-user \
  --region us-east-1 \
  --user-pool-id "$POOL" \
  --username "$EMAIL" \
  --user-attributes Name=email,Value="$EMAIL" Name=email_verified,Value=true \
  --desired-delivery-mediums EMAIL \
  --query 'User.Username' --output text
echo "Invite sent to $EMAIL. Check spam if it doesn't arrive within a few minutes."

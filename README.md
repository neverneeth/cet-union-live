A community experience of democracy for CETians, by CETians

# Union election live site

Unofficial live results, an anonymous exit poll and a noticeboard for the 2026 college union election. Serverless on AWS (us-east-1), deployed with one command.

```
Students' phones ──► CloudFront (+ WAF rate limits) ──┬─► S3: the site (HTML/JS/CSS)
                                                       ├─► S3: data/results.json, data/exitpoll.json  (cached 2 s)
                                                       └─► API Gateway ─► Lambda ─► DynamoDB
Admins ──► Cognito managed login (password + authenticator code) ──► /api/admin/* (JWT checked by API Gateway)
EventBridge ──► same Lambda every minute: republishes the two JSON files (exit-poll reveal happens here)
```

Viewers never touch Lambda or the database: they poll two small JSON files from the CDN, so a crowd refreshing at once cannot take the site down.

## Verify it yourself

- **The site your browser runs is this code.** The pages, JavaScript and CSS served by https://live.cetlivevotes.me are byte-for-byte the files in [`site/`](site/). Check it yourself with `./scripts/verify-site.sh`: it downloads every file in `site/` from the live site and prints `MATCH` or `DIFF` for each one. That is the code that hashes your university ID on your phone before anything is sent.
- **The server code is published but can't be verified from outside.** [`lambda/`](lambda/) is the code we deploy to AWS, but nobody outside can confirm what actually runs there. The design limits what the server could learn even if it were changed; see [section 3, Privacy design](#3-privacy-design-what-the-site-promises-and-its-limits).

---

## 1. Deploy (about 20 minutes, most of it waiting for CloudFront)

### Prerequisites in WSL

```bash
node -v                      # must be 20 or newer
curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o awscliv2.zip
unzip -q awscliv2.zip && sudo ./aws/install && rm -rf aws awscliv2.zip
aws login                    # opens a browser; uses your console sign-in, no access keys
aws configure set region us-east-1
aws sts get-caller-identity  # should print your account number
```

If you normally sign in to the console as the **root** user, create an IAM user with `AdministratorAccess` for yourself first and sign in with that instead.

### Option A: let Claude Code do it

In Claude Code, install the AWS toolkit plugin once (`/plugin install aws-core@claude-plugins-official`, needs `uv`), open this folder, and paste:

> Read README.md. Deploy this project to my AWS account in us-east-1, following section 1 exactly. Before running anything that creates resources, run `aws sts get-caller-identity` and show me the account. Copy deploy.config.example.json to deploy.config.json and set alertEmail to you@example.com (leave the other fields empty unless I give you values). Run `npm install`, `npm test`, `npx cdk bootstrap` (only if the account isn't bootstrapped yet) and `npm run deploy`. Then invite the admins with scripts/add-admin.sh (ask me for the emails), run scripts/smoke-test.sh, and give me the SiteUrl and AdminUrl from outputs.json. Do not create, change or delete anything outside this stack, and ask before any delete.

### Option B: by hand

```bash
cd election-live
cp deploy.config.example.json deploy.config.json   # put your email in alertEmail (budget alert at $10 of $20)
npm install                                        # also installs the Lambda's dependencies
npm test                                           # backend tests, ~1 s
npx cdk bootstrap                                  # once per account/region
npm run deploy                                     # ~10-15 min; writes outputs.json
./scripts/add-admin.sh you@example.com
./scripts/add-admin.sh coadmin@example.com
./scripts/smoke-test.sh                            # data/*.json can 403 for the first minute: rerun
```

Deploy from the same folder every time. The first run creates `secrets.local.json` (the CloudFront→API secret and the key that scrambles ID hashes). Keep it; don't commit it.

### Admin sign-in

Each admin gets an email with a temporary password. Open the **AdminUrl**, sign in, set a new password, then scan the QR code with an authenticator app. After that, every sign-in needs the 6-digit code. Sessions last 12 hours.

---

## 2. Optional extras

### Human check (recommended): Cloudflare Turnstile, free

Without it, someone with a script can submit many fake-but-valid-looking IDs (rate limits slow them down but don't stop them).

1. Cloudflare dashboard → Turnstile → Add widget. Mode: **Managed**.
2. Hostnames: your CloudFront domain (the `CloudFrontDomain` output, e.g. `d123abc.cloudfront.net`) and your custom domain if you have one.
3. Put the keys in `deploy.config.json` (`turnstileSiteKey`, `turnstileSecret`) and run `npm run deploy` again (~3 min).

### Custom domain

Use a subdomain such as `results.yourname.xyz` (a bare domain needs an ALIAS record that many registrars lack).

```bash
D=results.yourname.xyz
ARN=$(aws acm request-certificate --region us-east-1 --domain-name $D --validation-method DNS --query CertificateArn --output text)
sleep 10
aws acm describe-certificate --region us-east-1 --certificate-arn $ARN \
  --query 'Certificate.DomainValidationOptions[0].ResourceRecord'
# Add that CNAME at your registrar's DNS page, then:
aws acm wait certificate-validated --region us-east-1 --certificate-arn $ARN && echo issued
```

Put `domain` and `certificateArn` in `deploy.config.json`, run `npm run deploy`, then add a CNAME at your registrar: `results` → the `CloudFrontDomain` output. The CloudFront URL keeps working regardless, so this can be done after launch.

---

## 3. Privacy design (what the site promises, and its limits)

- The ID is checked against `^L?TVE\d{2}[A-Z]{1,6}\d{1,4}$` and SHA-256 hashed **in the browser**; only the hash is sent. The page shows the start of the hash it sends.
- The server re-hashes that with a secret key (HMAC), separately for the poll, posts, comments and reports, and stores it only in a cooldown table whose rows expire (DynamoDB TTL).
- **Exit-poll answers are never stored per person**: a submission only increments counters (overall, by programme, by year), in one atomic transaction with the "already answered" record.
- Breakdowns for groups with fewer than 5 respondents are not published. Results aren't published at all before the reveal time (enforced on the server, not just hidden in the page).
- No IPs, IDs or request bodies are logged by the app; WAF request sampling is off; fonts are self-hosted, so no third-party requests unless Turnstile is enabled.
- Honest limits, also stated on the site's Privacy page: roll numbers are guessable, so a hash is pseudonymous rather than anonymous to someone with server access; a person running the server who watched the post-cooldown table live could narrow down who posted in those few minutes; the exit poll is self-selected and gameable.

## 4. Security notes

- Admin API: Cognito JWT validated by API Gateway, plus MFA-required users with no self sign-up.
- API reachable only through CloudFront (secret origin header checked by the Lambda), so WAF limits can't be bypassed.
- WAF: AWS IP-reputation list; 150 public POSTs per IP per 5 minutes; 2000 API reads per IP per 5 minutes. Result viewers (static files and data JSON) are never rate limited, so a whole hostel on one Wi-Fi IP is fine.
- Strict Content-Security-Policy (no inline scripts), HSTS, no-referrer, frame denial. All user text is escaped before display.
- Noticeboard rejects links, phone numbers and roll numbers; 5–250 words for posts, 50 for comments; admin-editable blocked-word list.

## Project layout

```
bin/app.js            CDK app (creates secrets.local.json on first run)
lib/stack.js          all AWS resources
lib/csp.js            Content-Security-Policy (shared with the dev server)
lambda/               API code: app.js (routes), core.js (rules, results, poll maths), store-*.js, seed.js (47 posts)
site/                 static pages: index (results), poll, board, privacy, admin
dev/server.js         local practice server
test/                 backend tests (memory and DynamoDB-emulator), browser end-to-end test
scripts/              add-admin.sh, smoke-test.sh, verify-site.sh
```

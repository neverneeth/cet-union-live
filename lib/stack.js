'use strict';
const path = require('path');
const cdk = require('aws-cdk-lib');
const { Duration, RemovalPolicy, CfnOutput, Fn } = cdk;
const s3 = require('aws-cdk-lib/aws-s3');
const s3deploy = require('aws-cdk-lib/aws-s3-deployment');
const cloudfront = require('aws-cdk-lib/aws-cloudfront');
const origins = require('aws-cdk-lib/aws-cloudfront-origins');
const lambda = require('aws-cdk-lib/aws-lambda');
const ddb = require('aws-cdk-lib/aws-dynamodb');
const apigw = require('aws-cdk-lib/aws-apigatewayv2');
const integrations = require('aws-cdk-lib/aws-apigatewayv2-integrations');
const authorizers = require('aws-cdk-lib/aws-apigatewayv2-authorizers');
const cognito = require('aws-cdk-lib/aws-cognito');
const events = require('aws-cdk-lib/aws-events');
const targets = require('aws-cdk-lib/aws-events-targets');
const wafv2 = require('aws-cdk-lib/aws-wafv2');
const acm = require('aws-cdk-lib/aws-certificatemanager');
const logs = require('aws-cdk-lib/aws-logs');
const budgets = require('aws-cdk-lib/aws-budgets');
const { CSP } = require('./csp');

class ElectionStack extends cdk.Stack {
  constructor(scope, id, props) {
    super(scope, id, props);
    const { config, secrets } = props;
    const root = path.join(__dirname, '..');

    // ---------------- data ----------------
    const table = (name, withSort, extra = {}) => new ddb.Table(this, name, {
      partitionKey: { name: 'pk', type: ddb.AttributeType.STRING },
      ...(withSort ? { sortKey: { name: 'sk', type: ddb.AttributeType.STRING } } : {}),
      billingMode: ddb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY,
      ...extra,
    });
    const electionTable = table('ElectionTable', true, { pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true } });
    const auditTable = table('AuditTable', true);
    const pollTable = table('PollTable', false);
    const cooldownTable = table('CooldownTable', false, { timeToLiveAttribute: 'expiresAt' });
    const boardTable = table('BoardTable', true);

    const bucketProps = {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    };
    const siteBucket = new s3.Bucket(this, 'SiteBucket', bucketProps);
    const dataBucket = new s3.Bucket(this, 'DataBucket', bucketProps);

    // ---------------- admin sign-in ----------------
    const userPool = new cognito.UserPool(this, 'Admins', {
      userPoolName: 'election-admins',
      featurePlan: cognito.FeaturePlan.ESSENTIALS,
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      autoVerify: { email: true },
      mfa: cognito.Mfa.REQUIRED,
      mfaSecondFactor: { sms: false, otp: true },
      passwordPolicy: { minLength: 10, requireSymbols: false, tempPasswordValidity: Duration.days(3) },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const suffix = Fn.select(0, Fn.split('-', Fn.select(2, Fn.split('/', this.stackId))));
    const domainPrefix = Fn.join('', ['union-admin-', suffix]);
    // "Managed login" (not the classic hosted UI) walks a new admin through authenticator-app setup with a QR code.
    userPool.addDomain('LoginDomain', { cognitoDomain: { domainPrefix }, managedLoginVersion: cognito.ManagedLoginVersion.NEWER_MANAGED_LOGIN });
    const cognitoHost = Fn.join('', [domainPrefix, '.auth.', this.region, '.amazoncognito.com']);

    // ---------------- API ----------------
    const fnLogs = new logs.LogGroup(this, 'ApiLogs', { retention: logs.RetentionDays.ONE_WEEK, removalPolicy: RemovalPolicy.DESTROY });
    const fn = new lambda.Function(this, 'ApiFunction', {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(root, 'lambda'), { exclude: ['store-memory.js', 'package-lock.json'] }),
      memorySize: 512,
      timeout: Duration.seconds(20),
      logGroup: fnLogs,
      environment: {
        ELECTION_TABLE: electionTable.tableName,
        AUDIT_TABLE: auditTable.tableName,
        POLL_TABLE: pollTable.tableName,
        COOLDOWN_TABLE: cooldownTable.tableName,
        BOARD_TABLE: boardTable.tableName,
        DATA_BUCKET: dataBucket.bucketName,
        ORIGIN_SECRET: secrets.originSecret,
        HMAC_SECRET: secrets.hmacSecret,
        TURNSTILE_SECRET: config.turnstileSecret || '',
        NODE_OPTIONS: '--enable-source-maps',
      },
    });
    for (const t of [electionTable, auditTable, pollTable, cooldownTable, boardTable]) t.grantReadWriteData(fn);
    dataBucket.grantPut(fn);

    // Republish the public JSON files every minute (exit-poll reveal, self-healing).
    new events.Rule(this, 'PublishEveryMinute', {
      schedule: events.Schedule.rate(Duration.minutes(1)),
      targets: [new targets.LambdaFunction(fn, { event: events.RuleTargetInput.fromObject({ task: 'publish' }) })],
    });

    const httpApi = new apigw.HttpApi(this, 'HttpApi', { apiName: 'election-api' });
    const stage = httpApi.defaultStage.node.defaultChild;
    stage.defaultRouteSettings = { throttlingBurstLimit: 400, throttlingRateLimit: 200 };

    // ---------------- WAF (rate limits only on the API; result viewers are never limited) ----------------
    const visibility = (metricName) => ({ cloudWatchMetricsEnabled: true, metricName, sampledRequestsEnabled: false });
    const startsWith = (s) => ({ byteMatchStatement: { searchString: s, fieldToMatch: { uriPath: {} }, positionalConstraint: 'STARTS_WITH', textTransformations: [{ priority: 0, type: 'NONE' }] } });
    const notAdmin = { notStatement: { statement: startsWith('/api/admin/') } };
    const block429 = { block: { customResponse: { responseCode: 429, customResponseBodyKey: 'tooMany' } } };
    const waf = new wafv2.CfnWebACL(this, 'Waf', {
      scope: 'CLOUDFRONT',
      defaultAction: { allow: {} },
      visibilityConfig: visibility('electionWaf'),
      customResponseBodies: {
        tooMany: { contentType: 'APPLICATION_JSON', content: '{"error":"Too many requests from your network. Wait a minute and try again."}' },
      },
      rules: [
        {
          name: 'IpReputation', priority: 0, overrideAction: { none: {} }, visibilityConfig: visibility('ipReputation'),
          statement: { managedRuleGroupStatement: { vendorName: 'AWS', name: 'AWSManagedRulesAmazonIpReputationList' } },
        },
        {
          name: 'LimitPublicWrites', priority: 1, action: block429, visibilityConfig: visibility('publicWrites'),
          statement: {
            rateBasedStatement: {
              limit: 150, evaluationWindowSec: 300, aggregateKeyType: 'IP',
              scopeDownStatement: { andStatement: { statements: [
                { byteMatchStatement: { searchString: 'POST', fieldToMatch: { method: {} }, positionalConstraint: 'EXACTLY', textTransformations: [{ priority: 0, type: 'NONE' }] } },
                startsWith('/api/'),
                notAdmin,
              ] } },
            },
          },
        },
        {
          name: 'LimitApiReads', priority: 2, action: block429, visibilityConfig: visibility('apiReads'),
          statement: {
            rateBasedStatement: {
              limit: 2000, evaluationWindowSec: 300, aggregateKeyType: 'IP',
              scopeDownStatement: { andStatement: { statements: [startsWith('/api/'), notAdmin] } },
            },
          },
        },
      ],
    });

    // ---------------- CloudFront ----------------
    const headers = new cloudfront.ResponseHeadersPolicy(this, 'SecurityHeaders', {
      securityHeadersBehavior: {
        contentSecurityPolicy: { contentSecurityPolicy: CSP, override: true },
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
        referrerPolicy: { referrerPolicy: cloudfront.HeadersReferrerPolicy.NO_REFERRER, override: true },
        strictTransportSecurity: { accessControlMaxAge: Duration.days(365), includeSubdomains: false, override: true },
      },
    });
    const cachePolicy = (name, def, max, qs) => new cloudfront.CachePolicy(this, name, {
      defaultTtl: def, minTtl: Duration.seconds(0), maxTtl: max,
      queryStringBehavior: qs || cloudfront.CacheQueryStringBehavior.none(),
      enableAcceptEncodingGzip: true, enableAcceptEncodingBrotli: true,
    });
    const staticCache = cachePolicy('StaticCache', Duration.minutes(1), Duration.minutes(5));
    const dataCache = cachePolicy('DataCache', Duration.seconds(2), Duration.seconds(5));
    const apiCache = cachePolicy('ApiCache', Duration.seconds(0), Duration.seconds(10), cloudfront.CacheQueryStringBehavior.allowList('before'));

    const apiOrigin = new origins.HttpOrigin(`${httpApi.apiId}.execute-api.${this.region}.amazonaws.com`, {
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
      customHeaders: { 'x-origin-verify': secrets.originSecret },
    });

    const domainNames = config.domain ? [config.domain] : undefined;
    const certificate = config.domain && config.certificateArn ? acm.Certificate.fromCertificateArn(this, 'Cert', config.certificateArn) : undefined;
    if (config.domain && !certificate) throw new Error('deploy.config.json: "domain" needs "certificateArn" too (see README).');

    // Clean URLs (/poll -> poll.html) and 301s from the old *.html URLs. Same file runs in the dev server.
    const cleanUrls = new cloudfront.Function(this, 'CleanUrls', {
      code: cloudfront.FunctionCode.fromFile({ filePath: path.join(root, 'lib', 'clean-urls.js') }),
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      comment: 'Clean URLs and .html redirects for the election site',
    });

    const distribution = new cloudfront.Distribution(this, 'Site', {
      comment: 'Union election live site',
      defaultRootObject: 'index.html',
      priceClass: cloudfront.PriceClass.PRICE_CLASS_200,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      ...(certificate ? { minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021 } : {}),
      webAclId: waf.attrArn,
      domainNames,
      certificate,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(siteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: staticCache,
        responseHeadersPolicy: headers,
        compress: true,
        functionAssociations: [{ function: cleanUrls, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST }],
      },
      additionalBehaviors: {
        '/data/*': {
          origin: origins.S3BucketOrigin.withOriginAccessControl(dataBucket),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: dataCache,
          responseHeadersPolicy: headers,
          compress: true,
        },
        '/api/admin/*': {
          origin: apiOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          responseHeadersPolicy: headers,
        },
        '/api/*': {
          origin: apiOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: apiCache,
          responseHeadersPolicy: headers,
          compress: true,
        },
      },
    });

    const siteHosts = [distribution.distributionDomainName, ...(config.domain ? [config.domain] : [])];
    const client = userPool.addClient('AdminWeb', {
      generateSecret: false,
      authFlows: { userSrp: true },
      preventUserExistenceErrors: true,
      supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.COGNITO],
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL],
        // /admin is the redirect the site uses; /admin.html stays allowed for old bookmarks and during rollout.
        callbackUrls: siteHosts.flatMap((h) => [`https://${h}/admin`, `https://${h}/admin.html`]),
        logoutUrls: siteHosts.flatMap((h) => [`https://${h}/admin`, `https://${h}/admin.html`]),
      },
      idTokenValidity: Duration.hours(12),
      accessTokenValidity: Duration.hours(12),
      refreshTokenValidity: Duration.days(2),
    });

    new cognito.CfnManagedLoginBranding(this, 'LoginBranding', {
      userPoolId: userPool.userPoolId,
      clientId: client.userPoolClientId,
      useCognitoProvidedValues: true,
    });

    const integration = new integrations.HttpLambdaIntegration('ApiIntegration', fn);
    const jwt = new authorizers.HttpJwtAuthorizer('AdminJwt', `https://cognito-idp.${this.region}.amazonaws.com/${userPool.userPoolId}`, {
      jwtAudience: [client.userPoolClientId],
    });
    httpApi.addRoutes({ path: '/api/admin/{proxy+}', methods: [apigw.HttpMethod.ANY], integration, authorizer: jwt });
    httpApi.addRoutes({ path: '/api/{proxy+}', methods: [apigw.HttpMethod.GET, apigw.HttpMethod.POST], integration });

    // Two uploads because one BucketDeployment sets a single Cache-Control for every file.
    // Pages, scripts, styles and config.json: browsers revalidate on every load, CloudFront keeps a copy up to 60 s.
    // The exclude also keeps this deployment from pruning the fonts and favicon uploaded by the second one.
    const longLived = ['fonts/*', 'favicon.svg'];
    new s3deploy.BucketDeployment(this, 'DeploySite', {
      sources: [
        s3deploy.Source.asset(path.join(root, 'site'), { exclude: longLived }),
        s3deploy.Source.jsonData('config.json', {
          mode: 'prod',
          cognitoDomain: cognitoHost,
          clientId: client.userPoolClientId,
          turnstileSiteKey: config.turnstileSiteKey || '',
        }),
      ],
      exclude: longLived,
      cacheControl: [s3deploy.CacheControl.fromString('public, max-age=0, s-maxage=60, must-revalidate')],
      destinationBucket: siteBucket,
      distribution,
      distributionPaths: ['/*'],
      memoryLimit: 512,
    });
    // Fonts and the favicon rarely change: browsers may keep them for a week.
    new s3deploy.BucketDeployment(this, 'DeploySiteStatic', {
      sources: [s3deploy.Source.asset(path.join(root, 'site'), { exclude: ['*', '!fonts', '!fonts/*', '!favicon.svg'] })],
      prune: false,
      cacheControl: [s3deploy.CacheControl.fromString('public, max-age=604800')],
      destinationBucket: siteBucket,
      distribution,
      distributionPaths: ['/fonts/*', '/favicon.svg'],
      memoryLimit: 512,
    });

    if (config.alertEmail) {
      new budgets.CfnBudget(this, 'Budget', {
        budget: { budgetName: 'election-site', budgetType: 'COST', timeUnit: 'MONTHLY', budgetLimit: { amount: 20, unit: 'USD' } },
        notificationsWithSubscribers: [{
          notification: { notificationType: 'ACTUAL', comparisonOperator: 'GREATER_THAN', threshold: 50, thresholdType: 'PERCENTAGE' },
          subscribers: [{ subscriptionType: 'EMAIL', address: config.alertEmail }],
        }],
      });
    }

    const siteUrl = `https://${config.domain || distribution.distributionDomainName}`;
    new CfnOutput(this, 'SiteUrl', { value: siteUrl });
    new CfnOutput(this, 'AdminUrl', { value: `${siteUrl}/admin` });
    new CfnOutput(this, 'CloudFrontDomain', { value: distribution.distributionDomainName, description: 'Point your custom domain CNAME here' });
    new CfnOutput(this, 'UserPoolId', { value: userPool.userPoolId });
    new CfnOutput(this, 'FunctionName', { value: fn.functionName });
    new CfnOutput(this, 'DistributionId', { value: distribution.distributionId });
  }
}

module.exports = { ElectionStack };

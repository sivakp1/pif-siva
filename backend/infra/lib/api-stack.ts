import * as path from 'path';
import { CfnOutput, Duration, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpJwtAuthorizer, HttpLambdaAuthorizer, HttpLambdaResponseType } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Platform } from 'aws-cdk-lib/aws-ecr-assets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { DynamoEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import { bedrockModelArns, PifConfig } from './config';

export const LAMBDAS_DIR = path.join(__dirname, '..', '..', 'lambdas');
export const LAYER_DIR = path.join(__dirname, '..', '..', 'build', 'layer');

export interface ApiStackProps extends StackProps {
  config: PifConfig;
  key: kms.IKey;
  pepper: secretsmanager.ISecret;
  ssmPrefix: string;
  apps: dynamodb.ITable;
  verdicts: dynamodb.ITable;
  stats: dynamodb.ITable;
  evalRuns: dynamodb.ITable;
  evalBucket: s3.IBucket;
}

export function evalStateMachineName(stage: string): string {
  return `pif-${stage}-eval-runner`;
}

/** Creates a Python 3.12 function with tracing, a retention-limited log group and the pif_core layer. */
export function pyFunction(
  scope: Construct,
  id: string,
  opts: { dir: string; handler: string; layer: lambda.ILayerVersion; memory: number; timeout: Duration; env: Record<string, string> },
): lambda.Function {
  const logGroup = new logs.LogGroup(scope, `${id}Logs`, { retention: logs.RetentionDays.ONE_MONTH, removalPolicy: RemovalPolicy.DESTROY });
  return new lambda.Function(scope, id, {
    runtime: lambda.Runtime.PYTHON_3_12,
    architecture: lambda.Architecture.X86_64,
    handler: opts.handler,
    code: lambda.Code.fromAsset(path.join(LAMBDAS_DIR, opts.dir), { exclude: ['__pycache__', '*.pyc'] }),
    layers: [opts.layer],
    memorySize: opts.memory,
    timeout: opts.timeout,
    tracing: lambda.Tracing.ACTIVE,
    logGroup,
    environment: { POWERTOOLS_SERVICE_NAME: 'pif', ...opts.env },
  });
}

const indexArns = (t: dynamodb.ITable) => [t.tableArn, `${t.tableArn}/index/*`];

/** BE-01 … BE-23: data plane + control plane HTTP APIs, Lambdas, Cognito. */
export class ApiStack extends Stack {
  readonly orchestrator: lambda.Function;
  /** ARN of the classifier's `live` alias; stable across deploys, so safe to share with the Eval stack. */
  readonly classifierAliasArn: string;
  readonly layer: lambda.LayerVersion;
  readonly dataApi: apigw.HttpApi;
  readonly dataStage: apigw.HttpStage;
  readonly controlApi: apigw.HttpApi;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);
    const { config, key, pepper, apps, verdicts, stats, evalRuns, evalBucket } = props;
    const stage = config.stage;

    this.layer = new lambda.LayerVersion(this, 'PifCoreLayer', {
      code: lambda.Code.fromAsset(LAYER_DIR),
      compatibleRuntimes: [lambda.Runtime.PYTHON_3_12],
      description: 'pif_core, pif_common, pif_eval, PyYAML, aws-xray-sdk',
    });

    const tableEnv = {
      TABLE_APPS: apps.tableName,
      TABLE_VERDICTS: verdicts.tableName,
      TABLE_STATS: stats.tableName,
      TABLE_EVAL_RUNS: evalRuns.tableName,
      ENV_NAME: stage,
    };
    const kmsUse = new iam.PolicyStatement({ actions: ['kms:Decrypt', 'kms:GenerateDataKey', 'kms:DescribeKey'], resources: [key.keyArn] });

    // ---------------------------------------------------------------- classifier (L2)
    const classifierLogs = new logs.LogGroup(this, 'ClassifierLogs', { retention: logs.RetentionDays.ONE_MONTH, removalPolicy: RemovalPolicy.DESTROY });
    const classifier = new lambda.DockerImageFunction(this, 'Classifier', {
      code: lambda.DockerImageCode.fromImageAsset(path.join(LAMBDAS_DIR, 'classifier'), { platform: Platform.LINUX_AMD64 }),
      architecture: lambda.Architecture.X86_64,
      memorySize: 3008,
      // first call loads the ~740 MB model; warm calls are well under a second
      timeout: Duration.seconds(60),
      tracing: lambda.Tracing.ACTIVE,
      logGroup: classifierLogs,
      description: 'PIF L2 classifier (ProtectAI deberta-v3-base-prompt-injection-v2, ONNX)',
    });
    const classifierAlias = new lambda.Alias(this, 'ClassifierLive', {
      aliasName: 'live',
      version: classifier.currentVersion,
      provisionedConcurrentExecutions: config.classifierProvisioned > 0 ? config.classifierProvisioned : undefined,
    });
    this.classifierAliasArn = classifierAlias.functionArn;

    // ---------------------------------------------------------------- scan orchestrator
    const modelIds = [config.judgeModelId, config.chatModelId, ...config.extraChatModelIds];
    this.orchestrator = pyFunction(this, 'ScanOrchestrator', {
      dir: 'scan_orchestrator',
      handler: 'pif_orchestrator.handler',
      layer: this.layer,
      memory: 1024,
      timeout: Duration.seconds(10),
      env: {
        ...tableEnv,
        CLASSIFIER_FUNCTION: classifierAlias.functionArn,
        CLASSIFIER_TIMEOUT_MS: String(config.classifierTimeoutMs),
        PEPPER_SECRET_ARN: pepper.secretArn,
        SSM_PREFIX: props.ssmPrefix,
        VERDICT_TTL_DAYS: String(config.verdictTtlDays),
        POLICY_CACHE_SECONDS: '60',
      },
    });
    // BE-21: invoke only the classifier and the configured Bedrock models; GetItem apps; PutItem verdicts
    this.orchestrator.addToRolePolicy(new iam.PolicyStatement({ actions: ['lambda:InvokeFunction'], resources: [classifierAlias.functionArn] }));
    this.orchestrator.addToRolePolicy(
      new iam.PolicyStatement({ actions: ['bedrock:InvokeModel'], resources: bedrockModelArns(modelIds, this.region, this.account) }),
    );
    this.orchestrator.addToRolePolicy(new iam.PolicyStatement({ actions: ['dynamodb:GetItem'], resources: [apps.tableArn] }));
    this.orchestrator.addToRolePolicy(new iam.PolicyStatement({ actions: ['dynamodb:PutItem'], resources: [verdicts.tableArn] }));
    this.orchestrator.addToRolePolicy(new iam.PolicyStatement({ actions: ['secretsmanager:GetSecretValue'], resources: [pepper.secretArn] }));
    this.orchestrator.addToRolePolicy(
      new iam.PolicyStatement({ actions: ['ssm:GetParameter'], resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter${props.ssmPrefix}/*`] }),
    );
    this.orchestrator.addToRolePolicy(kmsUse);

    // ---------------------------------------------------------------- authorizer
    const authorizerFn = pyFunction(this, 'ApiKeyAuthorizer', {
      dir: 'authorizer',
      handler: 'pif_authorizer.handler',
      layer: this.layer,
      memory: 256,
      timeout: Duration.seconds(5),
      env: tableEnv,
    });
    authorizerFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:Query'],
        resources: [`${apps.tableArn}/index/by-key-hash`, `${apps.tableArn}/index/by-prev-key-hash`],
      }),
    );
    authorizerFn.addToRolePolicy(kmsUse);

    // ---------------------------------------------------------------- stats aggregator
    const statsFn = pyFunction(this, 'StatsAggregator', {
      dir: 'stats_aggregator',
      handler: 'pif_stats.handler',
      layer: this.layer,
      memory: 256,
      timeout: Duration.seconds(30),
      env: tableEnv,
    });
    statsFn.addToRolePolicy(new iam.PolicyStatement({ actions: ['dynamodb:UpdateItem'], resources: [stats.tableArn] }));
    statsFn.addToRolePolicy(kmsUse);
    statsFn.addEventSource(
      new DynamoEventSource(verdicts, {
        startingPosition: lambda.StartingPosition.LATEST,
        batchSize: 100,
        retryAttempts: 3,
        bisectBatchOnError: true,
        reportBatchItemFailures: true,
        maxBatchingWindow: Duration.seconds(5),
      }),
    );

    // ---------------------------------------------------------------- admin api
    const smArn = `arn:aws:states:${this.region}:${this.account}:stateMachine:${evalStateMachineName(stage)}`;
    const adminFn = pyFunction(this, 'AdminApi', {
      dir: 'admin_api',
      handler: 'pif_admin.handler',
      layer: this.layer,
      memory: 512,
      timeout: Duration.seconds(29),
      env: {
        ...tableEnv,
        ORCHESTRATOR_FUNCTION: this.orchestrator.functionArn,
        EVAL_BUCKET: evalBucket.bucketName,
        EVAL_STATE_MACHINE_ARN: smArn,
        KEY_GRACE_HOURS: String(config.keyGraceHours),
        PLAYGROUND_PER_MINUTE: '30',
        POLICY_CACHE_SECONDS: '0',
      },
    });
    const adminDdb: [string[], string[]][] = [
      [['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:Scan'], [apps.tableArn]],
      [['dynamodb:Query'], indexArns(verdicts)],
      [['dynamodb:Query', 'dynamodb:UpdateItem'], [stats.tableArn]],
      [['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:Scan'], [evalRuns.tableArn]],
    ];
    for (const [actions, resources] of adminDdb) adminFn.addToRolePolicy(new iam.PolicyStatement({ actions, resources }));
    // BE-21: playground goes through the orchestrator; admin-api has no Bedrock permission
    adminFn.addToRolePolicy(new iam.PolicyStatement({ actions: ['lambda:InvokeFunction'], resources: [this.orchestrator.functionArn] }));
    adminFn.addToRolePolicy(new iam.PolicyStatement({ actions: ['states:StartExecution'], resources: [smArn] }));
    adminFn.addToRolePolicy(
      new iam.PolicyStatement({ actions: ['s3:ListBucket'], resources: [evalBucket.bucketArn], conditions: { StringLike: { 's3:prefix': ['datasets/*'] } } }),
    );
    adminFn.addToRolePolicy(
      new iam.PolicyStatement({ actions: ['s3:GetObject'], resources: [evalBucket.arnForObjects('datasets/*'), evalBucket.arnForObjects('runs/*')] }),
    );
    adminFn.addToRolePolicy(kmsUse);

    // ---------------------------------------------------------------- Cognito (dashboard users)
    const userPool = new cognito.UserPool(this, 'Users', {
      userPoolName: `pif-${stage}-users`,
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      autoVerify: { email: true },
      mfa: cognito.Mfa.OPTIONAL,
      mfaSecondFactor: { otp: true, sms: false },
      passwordPolicy: { minLength: 12, requireDigits: true, requireLowercase: true, requireUppercase: true, requireSymbols: true },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: stage === 'prod' ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });
    for (const group of ['admin', 'analyst']) {
      new cognito.CfnUserPoolGroup(this, `Group-${group}`, { userPoolId: userPool.userPoolId, groupName: group, description: `PIF ${group}` });
    }
    const domain = userPool.addDomain('HostedUi', { cognitoDomain: { domainPrefix: `pif-${stage}-${this.account}` } });
    const callbackUrls = config.dashboardOrigins.map((o) => `${o}/api/auth/callback/cognito`);
    const client = userPool.addClient('Dashboard', {
      userPoolClientName: `pif-${stage}-dashboard`,
      generateSecret: true,
      authFlows: { userSrp: true },
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
        callbackUrls,
        logoutUrls: config.dashboardOrigins.map((o) => `${o}/login`),
      },
      accessTokenValidity: Duration.hours(1),
      idTokenValidity: Duration.hours(1),
      refreshTokenValidity: Duration.hours(8),
      preventUserExistenceErrors: true,
      supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.COGNITO],
    });
    const issuer = `https://cognito-idp.${this.region}.amazonaws.com/${userPool.userPoolId}`;

    // ---------------------------------------------------------------- HTTP APIs
    const accessLog = (name: string) =>
      new logs.LogGroup(this, `${name}AccessLogs`, { retention: logs.RetentionDays.THREE_MONTHS, removalPolicy: RemovalPolicy.DESTROY });
    const logFormat = JSON.stringify({
      requestId: '$context.requestId',
      ip: '$context.identity.sourceIp',
      requestTime: '$context.requestTime',
      routeKey: '$context.routeKey',
      status: '$context.status',
      responseLength: '$context.responseLength',
      integrationLatency: '$context.integrationLatency',
      authorizerError: '$context.authorizer.error',
    });
    const withStage = (api: apigw.HttpApi, name: string): apigw.HttpStage => {
      const st = new apigw.HttpStage(this, `${name}Stage`, {
        httpApi: api,
        stageName: '$default',
        autoDeploy: true,
        throttle: { rateLimit: 50, burstLimit: 100 },
      });
      const cfn = st.node.defaultChild as apigw.CfnStage;
      cfn.accessLogSettings = { destinationArn: accessLog(name).logGroupArn, format: logFormat };
      return st;
    };

    // Data plane: server-to-server, so no CORS (BE-23)
    this.dataApi = new apigw.HttpApi(this, 'DataPlaneApi', { apiName: `pif-${stage}-data`, createDefaultStage: false });
    this.dataStage = withStage(this.dataApi, 'DataPlane');
    const keyAuthorizer = new HttpLambdaAuthorizer('ApiKeyAuthorizer', authorizerFn, {
      responseTypes: [HttpLambdaResponseType.SIMPLE],
      identitySource: ['$request.header.x-api-key'],
      resultsCacheTtl: Duration.seconds(300),
    });
    const orchIntegration = new HttpLambdaIntegration('OrchestratorIntegration', this.orchestrator);
    this.dataApi.addRoutes({ path: '/v1/scan', methods: [apigw.HttpMethod.POST], integration: orchIntegration, authorizer: keyAuthorizer });
    this.dataApi.addRoutes({ path: '/v1/chat', methods: [apigw.HttpMethod.POST], integration: orchIntegration, authorizer: keyAuthorizer });
    this.dataApi.addRoutes({ path: '/healthz', methods: [apigw.HttpMethod.GET], integration: orchIntegration });

    // Control plane: Cognito JWT; CORS limited to dashboard origins (BE-23)
    this.controlApi = new apigw.HttpApi(this, 'ControlPlaneApi', {
      apiName: `pif-${stage}-control`,
      createDefaultStage: false,
      corsPreflight: {
        allowOrigins: config.dashboardOrigins,
        allowMethods: [apigw.CorsHttpMethod.GET, apigw.CorsHttpMethod.POST, apigw.CorsHttpMethod.PUT, apigw.CorsHttpMethod.PATCH],
        allowHeaders: ['authorization', 'content-type'],
        maxAge: Duration.hours(1),
      },
    });
    const controlStage = withStage(this.controlApi, 'ControlPlane');
    const jwt = new HttpJwtAuthorizer('CognitoJwt', issuer, { jwtAudience: [client.userPoolClientId] });
    const adminIntegration = new HttpLambdaIntegration('AdminIntegration', adminFn);
    const routes: [apigw.HttpMethod, string][] = [
      [apigw.HttpMethod.POST, '/v1/admin/playground/scan'],
      [apigw.HttpMethod.GET, '/v1/admin/verdicts'],
      [apigw.HttpMethod.GET, '/v1/admin/verdicts/{verdict_id}'],
      [apigw.HttpMethod.GET, '/v1/admin/stats'],
      [apigw.HttpMethod.GET, '/v1/admin/apps'],
      [apigw.HttpMethod.POST, '/v1/admin/apps'],
      [apigw.HttpMethod.PATCH, '/v1/admin/apps/{app_id}'],
      [apigw.HttpMethod.POST, '/v1/admin/apps/{app_id}/rotate-key'],
      [apigw.HttpMethod.GET, '/v1/admin/apps/{app_id}/policy'],
      [apigw.HttpMethod.PUT, '/v1/admin/apps/{app_id}/policy'],
      [apigw.HttpMethod.GET, '/v1/admin/datasets'],
      [apigw.HttpMethod.POST, '/v1/admin/eval-runs'],
      [apigw.HttpMethod.GET, '/v1/admin/eval-runs'],
      [apigw.HttpMethod.GET, '/v1/admin/eval-runs/{run_id}'],
    ];
    for (const [method, p] of routes) {
      this.controlApi.addRoutes({ path: p, methods: [method], integration: adminIntegration, authorizer: jwt });
    }

    // ---------------------------------------------------------------- outputs
    new CfnOutput(this, 'DataPlaneUrl', { value: this.dataStage.url });
    new CfnOutput(this, 'ControlPlaneUrl', { value: controlStage.url, description: 'PIF_API_BASE_URL for Vercel' });
    new CfnOutput(this, 'CognitoIssuer', { value: issuer, description: 'AUTH_COGNITO_ISSUER for Vercel' });
    new CfnOutput(this, 'CognitoClientId', { value: client.userPoolClientId, description: 'AUTH_COGNITO_ID for Vercel' });
    new CfnOutput(this, 'CognitoUserPoolId', { value: userPool.userPoolId });
    new CfnOutput(this, 'CognitoDomain', { value: domain.baseUrl() });
    new CfnOutput(this, 'OrchestratorFunctionName', { value: this.orchestrator.functionName });
  }
}

import { Stack, StackProps, RemovalPolicy, Duration } from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';
import { PifConfig } from './config';

export interface DataStackProps extends StackProps {
  config: PifConfig;
  key: kms.IKey;
}

/** BE-06 … BE-11: DynamoDB tables and the evaluation bucket. */
export class DataStack extends Stack {
  readonly apps: dynamodb.Table;
  readonly verdicts: dynamodb.Table;
  readonly stats: dynamodb.Table;
  readonly evalRuns: dynamodb.Table;
  readonly evalBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);
    const { config, key } = props;
    const removal = config.stage === 'prod' ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;
    const S = dynamodb.AttributeType.STRING;
    const common = {
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: key,
      pointInTimeRecovery: true,
      removalPolicy: removal,
    };

    this.apps = new dynamodb.Table(this, 'Apps', { ...common, tableName: `pif-apps-${config.stage}`, partitionKey: { name: 'app_id', type: S } });
    this.apps.addGlobalSecondaryIndex({ indexName: 'by-key-hash', partitionKey: { name: 'key_hash', type: S } });
    this.apps.addGlobalSecondaryIndex({ indexName: 'by-prev-key-hash', partitionKey: { name: 'prev_key_hash', type: S } });

    this.verdicts = new dynamodb.Table(this, 'Verdicts', {
      ...common,
      tableName: `pif-verdicts-${config.stage}`,
      partitionKey: { name: 'pk', type: S },
      sortKey: { name: 'sk', type: S },
      timeToLiveAttribute: 'ttl',
      stream: dynamodb.StreamViewType.NEW_IMAGE,
    });
    this.verdicts.addGlobalSecondaryIndex({ indexName: 'by-id', partitionKey: { name: 'verdict_id', type: S } });
    this.verdicts.addGlobalSecondaryIndex({ indexName: 'by-action', partitionKey: { name: 'gsi_action_pk', type: S }, sortKey: { name: 'sk', type: S } });

    this.stats = new dynamodb.Table(this, 'Stats', {
      ...common,
      tableName: `pif-stats-${config.stage}`,
      partitionKey: { name: 'pk', type: S },
      sortKey: { name: 'sk', type: S },
      timeToLiveAttribute: 'ttl',
    });

    this.evalRuns = new dynamodb.Table(this, 'EvalRuns', { ...common, tableName: `pif-eval-runs-${config.stage}`, partitionKey: { name: 'run_id', type: S } });

    const accessLogs = new s3.Bucket(this, 'AccessLogs', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_PREFERRED,
      lifecycleRules: [{ expiration: Duration.days(90) }],
      removalPolicy: RemovalPolicy.RETAIN,
    });
    NagSuppressions.addResourceSuppressions(accessLogs, [
      { id: 'AwsSolutions-S1', reason: 'This is the server access log destination bucket; logging it to itself would recurse.' },
    ]);

    this.evalBucket = new s3.Bucket(this, 'EvalBucket', {
      bucketName: `pif-eval-${this.account}-${config.stage}`,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: key,
      bucketKeyEnabled: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      versioned: true,
      enforceSSL: true,
      serverAccessLogsBucket: accessLogs,
      serverAccessLogsPrefix: 'eval-bucket/',
      removalPolicy: RemovalPolicy.RETAIN,
    });
  }
}

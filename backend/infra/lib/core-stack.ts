import { Stack, StackProps, RemovalPolicy } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subs from 'aws-cdk-lib/aws-sns-subscriptions';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { PifConfig } from './config';

export interface CoreStackProps extends StackProps {
  config: PifConfig;
}

/** KMS CMK, HMAC pepper, alarm topic and SSM parameters (BE-22, BE-25). */
export class CoreStack extends Stack {
  readonly key: kms.Key;
  readonly pepper: secretsmanager.Secret;
  readonly alarmTopic: sns.Topic;
  readonly ssmPrefix: string;

  constructor(scope: Construct, id: string, props: CoreStackProps) {
    super(scope, id, props);
    const { config } = props;
    this.ssmPrefix = `/pif/${config.stage}`;

    this.key = new kms.Key(this, 'DataKey', {
      alias: `alias/pif-${config.stage}`,
      description: 'PIF customer-managed key for tables, buckets, secrets and topics',
      enableKeyRotation: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    // CloudWatch alarms publish to the CMK-encrypted SNS topic
    this.key.addToResourcePolicy(
      new iam.PolicyStatement({
        principals: [new iam.ServicePrincipal('cloudwatch.amazonaws.com')],
        actions: ['kms:Decrypt', 'kms:GenerateDataKey*'],
        resources: ['*'],
      }),
    );

    this.pepper = new secretsmanager.Secret(this, 'InputHashPepper', {
      description: 'HMAC pepper for input hashing (P1)',
      encryptionKey: this.key,
      generateSecretString: { passwordLength: 48, excludePunctuation: true },
    });

    this.alarmTopic = new sns.Topic(this, 'AlarmTopic', {
      displayName: `PIF ${config.stage} alarms`,
      masterKey: this.key,
      enforceSSL: true,
    });
    if (config.alarmEmail) {
      this.alarmTopic.addSubscription(new subs.EmailSubscription(config.alarmEmail));
    }

    const params: Record<string, string> = {
      judge_model_id: config.judgeModelId,
      chat_model_id: config.chatModelId,
      verdict_ttl_days: String(config.verdictTtlDays),
      classifier_timeout_ms: String(config.classifierTimeoutMs),
    };
    for (const [name, value] of Object.entries(params)) {
      new ssm.StringParameter(this, `Param-${name}`, { parameterName: `${this.ssmPrefix}/${name}`, stringValue: value });
    }
  }
}

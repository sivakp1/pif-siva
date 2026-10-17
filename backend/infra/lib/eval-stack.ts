import { CfnOutput, Duration, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import * as bedrock from 'aws-cdk-lib/aws-bedrock';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import { Construct } from 'constructs';
import { evalStateMachineName, LAYER_DIR, pyFunction } from './api-stack';
import { PifConfig } from './config';

export interface EvalStackProps extends StackProps {
  config: PifConfig;
  key: kms.IKey;
  orchestrator: lambda.IFunction;
  /** EVAL-08: the scan task warms this alias before L2 scans. */
  classifierAliasArn: string;
  evalRuns: dynamodb.ITable;
  evalBucket: s3.IBucket;
}

/** EVAL-03 … EVAL-06: Step Functions eval runner and the Bedrock Guardrails baseline. */
export class EvalStack extends Stack {
  constructor(scope: Construct, id: string, props: EvalStackProps) {
    super(scope, id, props);
    const { config, key, orchestrator, classifierAliasArn, evalRuns, evalBucket } = props;
    // Own copy of the pif_core layer: importing the Api stack's layer ARN would create a
    // CloudFormation export whose value changes on every code update, which CloudFormation rejects.
    const layer = new lambda.LayerVersion(this, 'PifCoreLayer', {
      code: lambda.Code.fromAsset(LAYER_DIR),
      compatibleRuntimes: [lambda.Runtime.PYTHON_3_12],
      description: 'pif_core, pif_common, pif_eval (eval runner copy)',
    });

    const guardrail = new bedrock.CfnGuardrail(this, 'BaselineGuardrail', {
      name: `pif-${config.stage}-baseline`,
      description: 'Evaluation baseline only: prompt-attack filter HIGH',
      blockedInputMessaging: 'Blocked by guardrail.',
      blockedOutputsMessaging: 'Blocked by guardrail.',
      contentPolicyConfig: { filtersConfig: [{ type: 'PROMPT_ATTACK', inputStrength: 'HIGH', outputStrength: 'NONE' }] },
    });
    const guardrailVersion = new bedrock.CfnGuardrailVersion(this, 'BaselineGuardrailVersion', { guardrailIdentifier: guardrail.attrGuardrailId });

    const env = {
      TABLE_EVAL_RUNS: evalRuns.tableName,
      EVAL_BUCKET: evalBucket.bucketName,
      ORCHESTRATOR_FUNCTION: orchestrator.functionArn,
      CLASSIFIER_FUNCTION: classifierAliasArn,
      GUARDRAIL_ID: guardrail.attrGuardrailId,
      GUARDRAIL_VERSION: guardrailVersion.attrVersion,
      EVAL_BATCH_SIZE: '50',
      EVAL_SCAN_WORKERS: '4',
    };
    const fn = (name: string, handler: string, timeout: Duration, memory = 512) =>
      pyFunction(this, name, { dir: 'eval_runner', handler: `pif_eval_tasks.${handler}`, layer, memory, timeout, env });
    const prepareFn = fn('EvalPrepare', 'prepare', Duration.minutes(2));
    const scanFn = fn('EvalScanBatch', 'scan_batch', Duration.minutes(10));
    const aggregateFn = fn('EvalAggregate', 'aggregate', Duration.minutes(10), 1024);
    const failFn = fn('EvalMarkFailed', 'mark_failed', Duration.seconds(30), 256);

    const kmsUse = new iam.PolicyStatement({ actions: ['kms:Decrypt', 'kms:GenerateDataKey', 'kms:DescribeKey'], resources: [key.keyArn] });
    const runsUpdate = new iam.PolicyStatement({ actions: ['dynamodb:UpdateItem'], resources: [evalRuns.tableArn] });
    const datasetsRead = new iam.PolicyStatement({ actions: ['s3:GetObject'], resources: [evalBucket.arnForObjects('datasets/*')] });
    for (const f of [prepareFn, scanFn, aggregateFn, failFn]) {
      f.addToRolePolicy(kmsUse);
      f.addToRolePolicy(runsUpdate);
    }
    prepareFn.addToRolePolicy(datasetsRead);
    prepareFn.addToRolePolicy(new iam.PolicyStatement({ actions: ['s3:PutObject'], resources: [evalBucket.arnForObjects('runs/*')] }));
    scanFn.addToRolePolicy(datasetsRead);
    scanFn.addToRolePolicy(new iam.PolicyStatement({ actions: ['s3:PutObject'], resources: [evalBucket.arnForObjects('runs/*')] }));
    scanFn.addToRolePolicy(new iam.PolicyStatement({ actions: ['lambda:InvokeFunction'], resources: [orchestrator.functionArn, classifierAliasArn] }));
    scanFn.addToRolePolicy(new iam.PolicyStatement({ actions: ['bedrock:ApplyGuardrail'], resources: [guardrail.attrGuardrailArn] }));
    aggregateFn.addToRolePolicy(datasetsRead);
    aggregateFn.addToRolePolicy(new iam.PolicyStatement({ actions: ['s3:GetObject', 's3:PutObject'], resources: [evalBucket.arnForObjects('runs/*')] }));
    aggregateFn.addToRolePolicy(
      new iam.PolicyStatement({ actions: ['s3:ListBucket'], resources: [evalBucket.bucketArn], conditions: { StringLike: { 's3:prefix': ['runs/*'] } } }),
    );

    const invoke = (id: string, f: lambda.IFunction, payload?: sfn.TaskInput) =>
      new tasks.LambdaInvoke(this, id, { lambdaFunction: f, payloadResponseOnly: true, payload });

    const markFailed = invoke(
      'MarkFailed',
      failFn,
      sfn.TaskInput.fromObject({ run_id: sfn.JsonPath.stringAt('$.run_id'), error: sfn.JsonPath.objectAt('$.error') }),
    ).next(new sfn.Fail(this, 'RunFailed'));

    const prepare = invoke('Prepare', prepareFn);
    const scanBatch = invoke('ScanBatch', scanFn).addRetry({
      errors: ['States.TaskFailed', 'Lambda.TooManyRequestsException', 'Lambda.ServiceException'],
      interval: Duration.seconds(5),
      maxAttempts: 3,
      backoffRate: 2,
    });
    const scanAll = new sfn.Map(this, 'ScanAll', { itemsPath: sfn.JsonPath.stringAt('$.tasks'), maxConcurrency: 5, resultPath: '$.batches' });
    scanAll.itemProcessor(scanBatch);
    const aggregate = invoke('Aggregate', aggregateFn);
    for (const s of [prepare, aggregate]) s.addCatch(markFailed, { resultPath: '$.error' });
    scanAll.addCatch(markFailed, { resultPath: '$.error' });

    const smLogs = new logs.LogGroup(this, 'EvalRunnerLogs', { retention: logs.RetentionDays.ONE_MONTH, removalPolicy: RemovalPolicy.DESTROY });
    const sm = new sfn.StateMachine(this, 'EvalRunner', {
      stateMachineName: evalStateMachineName(config.stage),
      stateMachineType: sfn.StateMachineType.STANDARD,
      definitionBody: sfn.DefinitionBody.fromChainable(prepare.next(scanAll).next(aggregate)),
      tracingEnabled: true,
      logs: { destination: smLogs, level: sfn.LogLevel.ALL, includeExecutionData: false },
      timeout: Duration.hours(6),
    });

    new CfnOutput(this, 'EvalStateMachineArn', { value: sm.stateMachineArn });
    new CfnOutput(this, 'GuardrailId', { value: guardrail.attrGuardrailId });
  }
}

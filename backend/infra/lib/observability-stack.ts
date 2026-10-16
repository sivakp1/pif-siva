import { Duration, Stack, StackProps } from 'aws-cdk-lib';
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import * as cw from 'aws-cdk-lib/aws-cloudwatch';
import * as actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import { Construct } from 'constructs';
import { PifConfig } from './config';

export interface ObservabilityStackProps extends StackProps {
  config: PifConfig;
  topic: sns.ITopic;
  dataApi: apigw.IHttpApi;
}

/** BE-19 alarms on the app-agnostic EMF rollups (namespace PIF) and API Gateway metrics. */
export class ObservabilityStack extends Stack {
  constructor(scope: Construct, id: string, props: ObservabilityStackProps) {
    super(scope, id, props);
    const { topic, dataApi } = props;
    const pif = (name: string, statistic: string, period: Duration) => new cw.Metric({ namespace: 'PIF', metricName: name, statistic, period });
    const action = new actions.SnsAction(topic);
    const add = (alarm: cw.Alarm) => {
      alarm.addAlarmAction(action);
      alarm.addOkAction(action);
    };

    add(
      new cw.Alarm(this, 'WarmP95Latency', {
        alarmDescription: 'p95 judge-free scan latency > 500 ms for 5 minutes (P9 / NFR-01 early warning)',
        metric: pif('ScanLatencyNoJudgeMs', 'p95', Duration.minutes(1)),
        threshold: 500,
        evaluationPeriods: 5,
        datapointsToAlarm: 5,
        comparisonOperator: cw.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cw.TreatMissingData.NOT_BREACHING,
      }),
    );

    const apiMetric = (metricName: string) =>
      new cw.Metric({ namespace: 'AWS/ApiGateway', metricName, dimensionsMap: { ApiId: dataApi.apiId, Stage: '$default' }, statistic: 'Sum', period: Duration.minutes(5) });
    add(
      new cw.Alarm(this, 'DataPlane5xxRate', {
        alarmDescription: '5xx rate > 2% over 5 minutes',
        metric: new cw.MathExpression({ expression: 'IF(cnt > 0, 100 * err / cnt, 0)', usingMetrics: { err: apiMetric('5xx'), cnt: apiMetric('Count') }, period: Duration.minutes(5) }),
        threshold: 2,
        evaluationPeriods: 1,
        comparisonOperator: cw.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cw.TreatMissingData.NOT_BREACHING,
      }),
    );

    add(
      new cw.Alarm(this, 'JudgeErrorRate', {
        alarmDescription: 'JudgeErrors / JudgeInvocations > 10% over 10 minutes',
        metric: new cw.MathExpression({
          expression: 'IF(inv > 0, 100 * e / inv, 0)',
          usingMetrics: { e: pif('JudgeErrors', 'Sum', Duration.minutes(10)), inv: pif('JudgeInvocations', 'Sum', Duration.minutes(10)) },
          period: Duration.minutes(10),
        }),
        threshold: 10,
        evaluationPeriods: 1,
        comparisonOperator: cw.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cw.TreatMissingData.NOT_BREACHING,
      }),
    );

    add(
      new cw.Alarm(this, 'DegradedRate', {
        alarmDescription: 'Degraded verdicts > 5% over 10 minutes',
        metric: new cw.MathExpression({
          expression: 'IF(req > 0, 100 * d / req, 0)',
          usingMetrics: { d: pif('Degraded', 'Sum', Duration.minutes(10)), req: pif('Requests', 'Sum', Duration.minutes(10)) },
          period: Duration.minutes(10),
        }),
        threshold: 5,
        evaluationPeriods: 1,
        comparisonOperator: cw.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cw.TreatMissingData.NOT_BREACHING,
      }),
    );

    add(
      new cw.Alarm(this, 'VerdictWriteErrors', {
        alarmDescription: 'Verdict writes are failing (BE-14)',
        metric: pif('VerdictWriteErrors', 'Sum', Duration.minutes(5)),
        threshold: 0,
        evaluationPeriods: 1,
        comparisonOperator: cw.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cw.TreatMissingData.NOT_BREACHING,
      }),
    );
  }
}

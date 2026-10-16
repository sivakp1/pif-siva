// test_AC_BE_11 / NFR-01: 1,000 benign requests at 20 rps against warm prod; p95 <= 300 ms
// for requests that did not invoke the judge.
//   k6 run -e PIF_DATA_URL=https://... -e PIF_API_KEY=pif_live_... -e PIF_APP_ID=loadtest backend/tests/load/scan.k6.js
import http from 'k6/http';
import { check } from 'k6';
import { Trend } from 'k6/metrics';

const noJudge = new Trend('scan_no_judge_ms', true);

export const options = {
  scenarios: {
    benign: { executor: 'constant-arrival-rate', rate: 20, timeUnit: '1s', duration: '50s', preAllocatedVUs: 20, maxVUs: 60 },
  },
  thresholds: { scan_no_judge_ms: ['p(95)<=300'], http_req_failed: ['rate<0.01'] },
};

const INPUTS = [
  'Where is my order #4521?',
  'What are your store hours on Sunday?',
  'Can I change the delivery address after ordering?',
  'How do I reset my password?',
];

export default function () {
  const body = JSON.stringify({ app_id: __ENV.PIF_APP_ID, input: INPUTS[Math.floor(Math.random() * INPUTS.length)] });
  const res = http.post(`${__ENV.PIF_DATA_URL}/v1/scan`, body, {
    headers: { 'content-type': 'application/json', 'x-api-key': __ENV.PIF_API_KEY },
  });
  check(res, { 'status 200': (r) => r.status === 200 });
  if (res.status === 200) {
    const judged = (res.json('segments') || []).some((s) => s.layers && s.layers.judge && s.layers.judge.label);
    if (!judged) noJudge.add(res.timings.duration);
  }
}

# Deploying PIF (AWS us-east-1 + Vercel)

Everything deploys from GitHub Actions. You never need AWS keys on your machine.

## 1. Push the repo to GitHub

Create an empty repository on github.com, for example `pif`. Then, in `D:\PythonCode\pif`:

```bash
git remote add origin https://github.com/<you>/pif.git
git push -u origin main
```

The first `ci` run checks the build. `deploy-backend` fails until steps 2–4 are done; that is expected.

## 2. AWS one-time setup (console only)

1. **Bedrock model access.** Open the Bedrock console in us-east-1 and go to *Model access*. Enable **Anthropic Claude Haiku 4.5**, filling in Anthropic's use-case form if asked.
2. **CDK bootstrap.** Open **AWS CloudShell** in us-east-1. It has Node.js preinstalled. Run:
   ```bash
   npx -y aws-cdk@2.170.0 bootstrap aws://$(aws sts get-caller-identity --query Account --output text)/us-east-1
   ```
3. **GitHub OIDC role.** Go to CloudFormation, choose *Create stack*, and upload `infra-bootstrap/github-oidc-role.yaml`. Set `GitHubOwner` and `GitHubRepo`. Copy the `DeployRoleArn` output.

## 3. GitHub settings (repo, then Settings)

- **Secrets and variables → Actions → Secrets:** set `AWS_DEPLOY_ROLE_ARN` to the role ARN from step 2.3.
- **Variables:**
  - `PIF_DEV_DASHBOARD_ORIGINS`: for example `https://pif-git-main-<you>.vercel.app,http://localhost:3000`
  - `PIF_PROD_DASHBOARD_ORIGINS`: for example `https://pif-<you>.vercel.app`
  - `PIF_ALARM_EMAIL` (optional)
- **Environments:** create `dev` and `prod`. On `prod`, add yourself as a **required reviewer**. That is the manual approval gate (BE-26).

## 4. Deploy the backend

Go to **Actions → deploy-backend → Run workflow**, or push to `main`. The first run builds the classifier container image, which downloads the model from Hugging Face during the build; that takes about 10 minutes.

The pipeline runs these steps:
1. Deploy dev.
2. Run integration and contract tests.
3. Run the L1+L2 smoke gate.
4. Wait for your approval.
5. Deploy prod.

The first smoke-gate run writes `eval/smoke/baseline.L1L2.json` inside the runner. To make the gate a regression check, add that file to the repo: copy the numbers from the job log into it and commit them.

## 5. Vercel

1. Go to vercel.com → *Add New Project* and import the GitHub repo. Set **Root Directory** to `frontend`. The framework is detected as Next.js.
2. Run **Actions → ops → Run workflow** with `task=show-vercel-env` and `stage=prod`. It prints `PIF_API_BASE_URL`, `AUTH_COGNITO_ID` and `AUTH_COGNITO_ISSUER`. Get `AUTH_COGNITO_SECRET` from the Cognito console under the app client `pif-prod-dashboard`.
3. In Vercel, go to *Settings → Environment Variables* and add those four values plus:
   - `AUTH_SECRET`: generate it with `openssl rand -base64 32`
   - `AUTH_TRUST_HOST=true`

   Use the dev values for *Preview* and the prod values for *Production*.
4. Redeploy. Put the final Vercel URLs into the `PIF_*_DASHBOARD_ORIGINS` variables and re-run `deploy-backend` so the Cognito callback URLs and CORS match.

## 6. First users

Run **Actions → ops** with `task=create-admin-user`, your email, `group=admin` and `stage=prod`. Cognito emails you a temporary password. Sign in at the Vercel URL.

## 7. Full evaluation dataset (optional)

Run **Actions → ops** with `task=upload-dataset-v1`. It builds dataset v1 from the public sources and uploads it to S3. Then start a run from the dashboard's **Evaluation** page.

## Load test (AC-BE-11, before a prod release)

```bash
k6 run -e PIF_DATA_URL=<DataPlaneUrl> -e PIF_API_KEY=<key> -e PIF_APP_ID=<app> backend/tests/load/scan.k6.js
```

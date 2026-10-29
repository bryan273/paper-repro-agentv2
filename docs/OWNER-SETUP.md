# Owner setup for CI/CD (one time, about five minutes)

The checks on pull requests need nothing. Automatic **deployment after a merge** needs two credentials that only the owner
should create, because they let a workflow write to other places. Until they exist, the deploy jobs print a notice and skip,
nothing breaks.

## 1. Deploy key for the Pages site (publishes the web apps and the Repro page)

```bash
ssh-keygen -t ed25519 -N "" -C "repro-suite-site-deploy" -f site_deploy

# allow that key to push to the site repo (and only that repo)
gh api repos/bryan273/repro-suite/keys -f title="site-deploy (CI of the app repos)" -f key="$(cat site_deploy.pub)" -F read_only=false

# give the private half to every repo that publishes into it
for r in paper-explainer repro-lite reading-companion repro-desk indexboard repro-suite-hub paper-repro-agentv2; do
  gh secret set SITE_DEPLOY_KEY -R bryan273/$r < site_deploy
done

rm site_deploy site_deploy.pub     # nothing else needs them
```

## 2. Supabase token (deploys the edge functions)

Create a **new** token for CI at https://supabase.com/dashboard/account/tokens (name it `github-ci`; do not reuse the one on your laptop, so you can revoke it alone), then:

```bash
gh secret set SUPABASE_ACCESS_TOKEN -R bryan273/paper-repro-agentv2
```

## 3. Check it works

Merge any pull request that touches `supabase/functions/**` and watch the `deploy-supabase` run, or start it by hand:
`gh workflow run deploy-supabase.yml -R bryan273/paper-repro-agentv2 -f all=true`.
For the apps, `gh workflow run ci-cd.yml -R bryan273/<repo>` builds and publishes that app.

## What a collaborator with write access can and cannot do

- They **cannot** read the secrets in a pull request: the checks use none.
- They **can**, by pushing to `main` or merging, run a workflow that uses the secrets. A free private repo cannot enforce
  branch protection, so the rule "branch, pull request, owner merges" is a team agreement. Give people who only need to
  suggest changes the **Triage** or **Read** role (or ask them to fork) and keep **Write** for people you trust with the
  deploy credentials.
- If a key or token is ever pasted into a file, issue or chat: revoke it first, then clean up.

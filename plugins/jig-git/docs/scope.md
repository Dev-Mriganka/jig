# Scope: what jig-git leaves out

Back to the [jig-git overview](../README.md).

## Left out on purpose

| Not offered | Why |
|---|---|
| Starting a workflow by hand | A workflow can deploy; deploys belong to a company deploy tool with its own rules |
| A raw GitHub API tool | Its writes cannot be classified |
| Approving a pull request | Approval stays human |
| Deleting tags, `reset --hard`, `clean` | They destroy work and are rarely needed; you can run them yourself |

## Not in this plugin

- **Other CI systems** (GitLab CI, Jenkins, Buildkite), deploy tools and
  container registry checks. They belong in a company plugin.
- **Gates on commit and push,** such as "no push without a review". They are
  `jig-flow` rules, not git code.
- **A company's conventions,** such as branch names, protected branches and the
  pull request template. They are the settings under
  [Configure](../README.md#configure), set by the company plugin.

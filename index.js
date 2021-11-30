const { Buffer } = require('buffer');
const yaml = require('js-yaml');
const bluebird = require('bluebird');

const getConfigFile = async (context, owner) => {
  const repoPaths = {
    '.infraway': 'config.yaml',
    'charts': '.infraway/config.yaml',
  };
  const content = await Object.keys(repoPaths)
    .reduce(async (prev, repo) => {
      try {
        const prevContent = await prev;
        if (prevContent) {
          return prevContent;
        }
        const { data: { content } } = await context.octokit.repos.getContent({
          owner,
          repo,
          path: repoPaths[repo],
        });
        return content;
      } catch (e) {
        return;
      }
    }, Promise.resolve());
  return content ? yaml.load(Buffer.from(content, 'base64').toString('utf8')) : null;
}

const getTagByCommit = async (context, owner, repo, sha) => {
  const tags = await context.octokit.repos.listTags({
    owner,
    repo,
    per_page: 200,
  });
  if (!tags || !tags.data) {
    return null;
  }
  return tags.data.find(t => t.commit.sha === sha);
}

const getLatestReleaseTag = async (context, owner, repo) => {
  const releases = await context.octokit.repos.listReleases({
    owner,
    repo,
    per_page: 1,
  });
  if (!releases || !releases.data) {
    return null;
  }
  const [latest] = releases.data;
  return latest ? latest.tag_name : null;
}

const findOpenPullRequestNumber = async (context, owner, repo, sha) => {
  const pulls = await context.octokit.repos.listPullRequestsAssociatedWithCommit({
    owner,
    repo,
    commit_sha: sha,
  });
  const pr = pulls.data.length > 0 && pulls.data.find(el => el.state === 'open');
  return pr ? pr.number : null;
};

const getLatestCommitInPullRequest = async (context, owner, repo, pullNumber) => {
  const pull = await context.octokit.pulls.get({
    owner,
    repo,
    pull_number: pullNumber,
  });
  if (!pull || !pull.data) {
    return null;
  }
  return pull.data.head.sha;
};

const configMap = {};
const configMapPromise = {};
const getConfig = (owner) => configMap[owner];

const syncConfig = async (context, owner) => {
  if (!configMap[owner]) {
    configMap[owner] = await getConfigFile(context, owner);
  }

  if (!configMapPromise[owner]) {
    configMapPromise[owner] = new Promise((resolve, reject) => {
      setInterval(async () => {
        configMap[owner] = await getConfigFile(context, owner);
      }, 20 * 60 * 1000);
    });
  }
}

const getDeployPayloads = async (context, { owner, repo, pullNumber, sha }, components = []) => {
  const config = getConfig(owner);
  const componentsMap = new Map(components.map((c) => [c.component, c]));
  const domain = config.domain;
  // find deploy by repo
  const deploy = config.deploy.find((d) => d.name === repo);
  if (!deploy) {
    return [];
  }

  const charts = (deploy.components || [])
    .filter((c) => {
      return !components.length || componentsMap.get(c.name)
    })
    .map(({ name, chart, version, needs }) => {
      if (!chart) {
        const found = deploy.components.find(({ needs = [] }) => needs.includes(name));
        if (found && found.chart) {
          chart = found.chart;
        }
      }
      const versionOverwrite = componentsMap.get(name);
      if (versionOverwrite) {
        version = versionOverwrite.version;
      }
      return {
        name, chart, version,
      };
    })
    .filter(({ chart }) => !!chart);

  return charts.reduce(async (acc, { name, version, chart }) => {
    const val = await acc;
    let gitVersion;
    if (!version || version === 'commit') {
      version = sha || await getLatestCommitInPullRequest(context, owner, repo, pullNumber);
      gitVersion = version;
      version = version.substr(0, 7);
    }
    if (version === 'release') {
      version = await getLatestReleaseTag(context, owner, repo);
      gitVersion = version;
    }
    const description = `Deploy ${chart} for ${repo}/pull/${pullNumber}`;
    const environment = `pr-${pullNumber}`;
    return [...val, { repo, component: name, gitVersion, version, chart, description, environment, domain }];
  }, Promise.resolve([]));
}

const createDeployments = async (app, context, owner, payloads) => {
  await bluebird.mapSeries(payloads, async ({ repo, component, chart, version, gitVersion, environment, description, domain }) => {
    app.log.info({ repo, component, chart, version, gitVersion, environment, description, domain });
    const res = await context.octokit.repos.createDeployment({
      owner: owner,
      repo: 'charts',
      ref: 'master', // The ref to deploy. This can be a branch, tag, or SHA.
      task: 'deploy', // Specifies a task to execute (e.g., deploy or deploy:migrations).
      auto_merge: false, // Attempts to automatically merge the default branch into the requested ref, if it is behind the default branch.
      required_contexts: [], // The status contexts to verify against commit status checks. If this parameter is omitted, then all unique contexts will be verified before a deployment is created. To bypass checking entirely pass an empty array. Defaults to all unique contexts.
      payload: {
        repo,
        chart,
        version,
        component,
        gitVersion,
        domain: `${environment}.${domain}`,
        environment,
      }, // JSON payload with extra information about the deployment. Default: ""
      environment, // Name for the target deployment environment (e.g., production, staging, qa)
      description, // Short description of the deployment
      transient_environment: true, // Specifies if the given environment is specific to the deployment and will no longer exist at some point in the future.
      production_environment: false, // Specifies if the given environment is one that end-users directly interact with.
    });
    app.log.info(`Created deployment #${res.data.id} for pull request ${environment}`);

    const deploymentId = res.data.id;
    await context.octokit.repos.createDeploymentStatus({
      owner,
      repo: 'charts',
      deployment_id: deploymentId,
      state: 'pending', // The state of the status. Can be one of error, failure, inactive, pending, or success
      description, // A short description of the status.
      environment,
      environment_url: `https://${environment}.${domain}`, // Sets the URL for accessing your environment.
      auto_inactive: true, // Adds a new inactive status to all prior non-transient, non-production environment deployments with the same repository and environment name as the created status's deployment. An inactive status is only added to deployments that had a success state.
    });
  });
};

/**
 * This is the main entrypoint to your Probot app
 * @param {import('probot').Probot} app
 */
module.exports = (app) => {
  // Your code here
  app.log.info("Yay, the app was loaded!");
  app.on(
    "issue_comment.created",
    async (context) => {
      const command = '\deploy'
      const {
        comment: { body: comment },
        repository: { owner: { login: owner }, name: repo },
      } = context.payload;
      if (
        !comment ||
        comment.indexOf(command) !== -1
      ) {
        app.log.debug(`Missing comment body or comment doesn't start with /deploy message`);
        return;
      }
      app.log.info('issue_comment.created');
      app.log.info(context.payload);

      const pullNumber = context.payload.issue.html_url.indexOf('/pull/')
        ? context.payload.issue.number : null;

      await syncConfig(context, owner);

      if (!pullNumber) {
        app.log.debug('Cannot find pull request. Deploy dismissed.');
        return;
      }

      const components = context.payload.comment.body
        .toLowerCase()
        .substr(command.length)
        .split(' ')
        .map((component) => {
          const parts = component.split(':');
          return {
            component: parts[0],
            version: parts[1],
          };
        });

      const payloads = await getDeployPayloads(context, { owner, repo, pullNumber }, components);
      await createDeployments(app, context, owner, payloads);
    },
  );
  // app.on(
  //   "deployment_status",
  //   async (context) => {
  //     app.log.info('deployment_status');
  //     app.log.info(context.payload);
  //   },
  // );
  app.on(
    "status",
    async (context) => {
      const {
        state,
        context: ctx,
        commit: { sha },
        repository: { owner: { login: owner }, name: repo },
      } = context.payload;
      app.log.info('status', { state, owner, repo, sha, ctx });
      if (state !== 'success' || !ctx && ctx.toString().match(/publish/) === null) {
        return;
      }
      await syncConfig(context, owner);

      const pullNumber = await findOpenPullRequestNumber(context, owner, repo, sha);
      if (!pullNumber) {
        app.log.debug(`Open pull request for sha ${sha} cannot be find. Deploy dismissed.`);
      }

      const payloads = await getDeployPayloads(context, { owner, repo, pullNumber, sha });
      await createDeployments(app, context, owner, payloads);
    },
  );
  // app.on(
  //   "check_run",
  //   async (context) => {
  //     app.log.info('check_run');
  //     app.log.info(context.payload);
  //   },
  // );
  // app.on(
  //   "check_suite",
  //   async (context) => {
  //     app.log.info('check_suite');
  //     app.log.info(context.payload);
  //   },
  // );
};

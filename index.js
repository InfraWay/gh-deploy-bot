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

const getDeployPayloads = async (context, { owner, repo, pullNumber, sha = '' }, components = [], action = '', logger = null) => {
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
      return (
        // filter by passed components
        (!components.length || componentsMap.get(c.name)) &&
        (action === 'comment' || !c.addon)
      );
    })
    .map(({ name, chart, version, needs }) => {
      if (!chart) {
        const found = deploy.components.find(({ needs = [] }) => needs.includes(name));
        if (found && found.chart) {
          chart = found.chart;
        }
      }
      const versionOverwrite = componentsMap.get(name);
      logger && logger.info(`name=${name}, version=${version}, versionOverwrite=${versionOverwrite.version}`);
      if (versionOverwrite) {
        version = versionOverwrite.version;
      }
      return {
        name, chart, version,
      };
    })
    .filter(({ chart }) => !!chart);

  return charts.reduce(async (acc, { name, version, chart, addon }) => {
    const val = await acc;
    let gitVersion;
    if (!version || version === 'commit') {
      version = sha || await getLatestCommitInPullRequest(context, owner, repo, pullNumber);
      gitVersion = version;
      version = version.substr(0, 7);
    }
    if (version === 'release') {
      version = await getLatestReleaseTag(context, owner, name || repo);
      gitVersion = version;
    }
    const description = `Deploy ${chart} for ${repo}/pull/${pullNumber}`;
    const environment = `${repo.replace('.', '-')}-pull-${pullNumber}`;
    return [...val, {
      repo,
      component: name.replace('.', '-'),
      addon,
      gitVersion,
      version,
      chart,
      description,
      environment,
      domain: `${environment}.${domain}`,
      action: 'deploy'
    }];
  }, Promise.resolve([]));
}

const getDeletePayloads = async (context, { owner, repo, pullNumber, sha }) => {
  const config = getConfig(owner);
  const domain = config.domain;
  // find deploy by repo
  const deploy = config.deploy.find((d) => d.name === repo);
  if (!deploy) {
    return [];
  }

  const charts = deploy.components
    .map(({ name }) => ({ name }));

  return charts.reduce(async (acc, { name }) => {
    const val = await acc;
    const description = `Delete ${name} for ${repo}/pull/${pullNumber}`;
    const environment = `${repo.replace('.', '-')}-pull-${pullNumber}`;
    return [...val, {
      repo,
      component: name.replace('.', '-'),
      description,
      environment,
      domain: `${environment}.${domain}`,
      action: 'delete',
    }];
  }, Promise.resolve([]));
}

const createDeployments = async (app, context, owner, payloads) => {
  await bluebird.mapSeries(payloads, async ({ repo, component, chart, version, gitVersion, environment, description, domain, action, addon = false }) => {
    app.log.info({ repo, component, chart, version, gitVersion, environment, description, domain, action });
    const res = await context.octokit.repos.createDeployment({
      owner: owner,
      repo: 'charts',
      ref: 'master', // The ref to deploy. This can be a branch, tag, or SHA.
      task: 'deploy', // Specifies a task to execute (e.g., deploy or deploy:migrations).
      auto_merge: false, // Attempts to automatically merge the default branch into the requested ref, if it is behind the default branch.
      required_contexts: [], // The status contexts to verify against commit status checks. If this parameter is omitted, then all unique contexts will be verified before a deployment is created. To bypass checking entirely pass an empty array. Defaults to all unique contexts.
      payload: {
        repo, chart, version, gitVersion, component, action, domain, environment, addon,
      }, // JSON payload with extra information about the deployment. Default: ""
      environment, // Name for the target deployment environment (e.g., production, staging, qa)
      description, // Short description of the deployment
      transient_environment: true, // Specifies if the given environment is specific to the deployment and will no longer exist at some point in the future.
      production_environment: false, // Specifies if the given environment is one that end-users directly interact with.
    });
    app.log.info(`Created deployment #${res.data.id} for pull request ${environment}`);
  });
};

const deleteDeployments = async (app, context, owner, payloads) => {
  await bluebird.mapSeries(payloads, async ({ repo, component, environment, description, domain, action }) => {
    app.log.info({ repo, component, environment, description, domain, action });
    const res = await context.octokit.repos.createDeployment({
      owner: owner,
      repo: 'charts',
      ref: 'master', // The ref to deploy. This can be a branch, tag, or SHA.
      task: 'delete', // Specifies a task to execute (e.g., deploy or deploy:migrations).
      auto_merge: false, // Attempts to automatically merge the default branch into the requested ref, if it is behind the default branch.
      required_contexts: [], // The status contexts to verify against commit status checks. If this parameter is omitted, then all unique contexts will be verified before a deployment is created. To bypass checking entirely pass an empty array. Defaults to all unique contexts.
      payload: {
        repo, component, domain, action, environment,
      }, // JSON payload with extra information about the deployment. Default: ""
      environment, // Name for the target deployment environment (e.g., production, staging, qa)
      description, // Short description of the deployment
      transient_environment: true, // Specifies if the given environment is specific to the deployment and will no longer exist at some point in the future.
      production_environment: false, // Specifies if the given environment is one that end-users directly interact with.
    });
    app.log.info(`Created delete deployment #${res.data.id} for pull request ${environment}`);
  });
  // if (payloads.length === 0) {
  //   return;
  // }
  // const environment = payloads[0].environment;
  // // find all deployments related to environment
  // app.log.info('context.octokit.repos.listDeployments');
  // app.log.info({ owner: owner, repo: 'charts', ref: 'master', environment });
  // const deploymentsList = await context.octokit.repos.listDeployments({
  //   owner: owner,
  //   repo: 'charts',
  //   ref: 'master',
  //   environment,
  // });
  // app.log.info('deploymentsList');
  // app.log.info(deploymentsList);
  // const deployments = (deploymentsList && deploymentsList.data) || [];
  // await bluebird.mapSeries(deployments || [], ({ id }) => context.octokit.repos.deleteDeployment({
  //     owner: owner,
  //     repo: 'charts',
  //     deployment_id: id,
  //   }),
  // );
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
        comment.indexOf(command) === -1
      ) {
        app.log.info(`Missing comment body or comment doesn't start with /deploy message`);
        return;
      }
      app.log.info('issue_comment.created');
      app.log.info(context.payload);

      const pullNumber = context.payload.issue.html_url.indexOf('/pull/')
        ? context.payload.issue.number : null;

      await syncConfig(context, owner);

      if (!pullNumber) {
        app.log.info('Cannot find pull request. Deploy dismissed.');
        return;
      }

      const components = context.payload.comment.body
        .toLowerCase()
        .substr(command.length)
        .split(' ')
        .filter(Boolean)
        .map((component) => {
          const parts = component.split(':');
          return {
            component: parts[0],
            version: parts[1],
          };
        });

      app.log.info('comment>deploy');
      app.log.info(components);

      const payloads = await getDeployPayloads(
        context, { owner, repo, pullNumber }, components, 'comment', app.log,
      );
      app.log.info(payloads);
      await createDeployments(app, context, owner, payloads);
    },
  );
  app.on(
    "push",
    async (context) => {
      const {
        context: ctx,
        head_commit: { id: sha },
        repository: { owner: { login: owner }, name: repo },
      } = context.payload;
      app.log.info('push');
      app.log.info({ owner, repo, sha, ctx });
      await syncConfig(context, owner);

      const pullNumber = await findOpenPullRequestNumber(context, owner, repo, sha);
      if (!pullNumber) {
        app.log.debug(`Open pull request for sha ${sha} cannot be find. Deploy dismissed.`);
        return;
      }

      const payloads = await getDeployPayloads(
        context, { owner, repo, pullNumber, sha }, [],'push',
      );
      await createDeployments(app, context, owner, payloads);
    },
  );
  app.on(
    "pull_request",
    async (context) => {
      const {
        context: ctx,
        pull_request: { number: pullNumber },
        repository: { owner: { login: owner }, name: repo },
        action,
      } = context.payload;
      if (!pullNumber) {
        app.log.info(`Close pull request cannot be found. Delete dismissed.`);
        return;
      }
      app.log.info(`pull_request.${action}`);
      app.log.info({ owner, repo, ctx, pullNumber });
      await syncConfig(context, owner);

      if (['opened', 'reopened'].includes(action)) {
        const payloads = await getDeployPayloads(
          context, { owner, repo, pullNumber }, [],'pull_request',
        );
        await createDeployments(app, context, owner, payloads);
      }

      if (['closed', 'merged'].includes(action)) {
        app.log.info(`Action on pull request. But action ${action} is not appropriate. Skipping...`);
        const payloads = await getDeletePayloads(context, { owner, repo, pullNumber });
        await deleteDeployments(app, context, owner, payloads);
      }
    },
  );
};

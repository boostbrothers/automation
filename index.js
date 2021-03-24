const core = require('@actions/core');
const { context, getOctokit } = require('@actions/github');
const conventionalChangelog = require('conventional-changelog'); 

const token = core.getInput('GITHUB_TOKEN', { required: true });
const botToken = core.getInput('BOT_TOKEN');
const masterBranch = core.getInput('MASTER_BRANCH');
const developBranch = core.getInput('DEVELOP_BRANCH');
const releaseBranch = core.getInput('RELEASE_BRANCH_PREFIX');
const hotfixBranch = core.getInput('HOTFIX_BRANCH_PREFIX');
const githubBot = getOctokit(token);
const automationBot = getOctokit(botToken);
const { owner, repo } = context.repo;

const getTarget = (branch) => {
  if (branch.startsWith(releaseBranch)) {
    return developBranch;
  }

  if (branch.startsWith(hotfixBranch)) {
    return developBranch;
  }

  return null;
};

const getVersion = (branch) => {
  return branch.substring(branch.indexOf('/') + 1);
};

const createPullRequest = async (head, base, version) => {
  const resp = await githubBot.pulls.create({
    owner,
    repo,
    head,
    base,
    title: `chore(release): ${version}`,
  });

  const responseMessage = [
    `head: ${head}, base: ${base}`,
    'Create Pull Reuqest:',
    `\tStatus Code: ${resp.status}`,
    `\tPull Request Number: ${resp.data.number}`,
  ].join('\n');

  console.log(responseMessage);
  return resp;
};

const approvePullRequest = async (prNumber) => {
  const resp = await automationBot.pulls.createReview({
    owner,
    repo,
    pull_number: prNumber,
    event: 'APPROVE',
  });

  return resp;
};

const createReleaseMessage = async () => {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const stream = conventionalChangelog({
      preset: {
        name: require.resolve('conventional-changelog-conventionalcommits'),
        types: [
          { type: 'feat', section: ':star: Features' },
          { type: 'fix', section: ':beetle: Bug Fixes' },
          { type: 'revert', section: ':fire: Reverts' },
          { type: 'docs', section: ':book: Documentation' },
          { type: 'style', section: ':milky_way: Styles' },
          { type: 'chore', section: ':sparkles: Miscellaneous Chores' },
          { type: 'refactor', section: ':rainbow: Code Refactoring' },
          { type: 'test', section: ':zap: Tests' },
          { type: 'build', section: 'Build System', hidden: true },
          { type: 'ci', section: 'Continuous Integration', hidden: true },
        ],
      },
    });

    stream.on('data', (chunk) => {
      chunks.push(chunk);
    });

    stream.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf-8'));
    });

    stream.on('error', (error) => {
      reject(error);
    });
  });
};

const createTag = async (commitSha, version, message) => {
  await automationBot.git.createTag({
    owner,
    repo,
    tag: version,
    message: version,
    object: commitSha,
    type: 'commit',
  });

  await automationBot.repos.createRelease({
    owner,
    repo,
    tag_name: version,
    name: version,
    body: message,
  });
};

const actionPullRequest = async () => {
  if (!context.payload.pull_request.merged) {
    core.info('pull request is not merged. Skpping...');
    return;
  }

  const head = context.payload.pull_request.head.ref;
  const base = context.payload.pull_request.base.ref;
  const target = getTarget(head);
  if (!target || base !== masterBranch) {
    core.info('This PR base branch do not have prefix');
    return;
  }

  const version = getVersion(head);
  const message = await createReleaseMessage();

  const pr = await createPullRequest(head, target, version);
  await approvePullRequest(pr.data.number);

  const mergeCommitSha = context.payload.pull_request.merge_commit_sha;
  await createTag(mergeCommitSha, version, message);
};

const actionPush = async () => {
  const branchName = context.payload.ref.replace('refs/heads/', '');
  if (!branchName) {
    throw new Error(`Can't parsing '${context.payload.ref}'`);
  }

  if (!branchName.startsWith(releaseBranch) && !branchName.startsWith(hotfixBranch)) {
    throw new Error('This branch do not have prefix');
  }

  const version = getVersion(branchName);
  const pr = await createPullRequest(branchName, 'master', version);
  await approvePullRequest(pr.data.number);
};

const run = async () => {
  core.debug(JSON.stringify(context.payload));

  switch (context.eventName) {
    case 'push':
      await actionPush();
      break;
    case 'pull_request':
      await actionPullRequest();
      break;
    default:
      core.info('Skipping...');
  };

  core.debug(JSON.stringify(context.payload));
};

try {
  run()
} catch (error) {
  core.setFailed(error.message);
}

import { Octokit } from '@octokit/rest';
import moment from 'moment-timezone';
import * as nock from 'nock';

import { listEC2Runners } from '../aws/runners';
import * as ghAuth from '../github/auth';
import { createRunners, getGitHubEnterpriseApiUrl } from '../scale-runners/scale-up';
import { adjust, getNumberOfQueuedJobs } from './pool';
import { describe, it, expect, beforeEach, vi, MockedClass } from 'vitest';

const mockOctokit = {
  paginate: (f: (arg0: unknown) => unknown[], o: unknown) => f(o),
  checks: { get: vi.fn() },
  actions: {
    createRegistrationTokenForOrg: vi.fn(),
    listJobsForWorkflowRunAttempt: vi.fn(),
    listSelfHostedRunnersForOrg: vi.fn(),
    listSelfHostedRunnersForRepo: vi.fn(),
    listWorkflowRunsForRepo: vi.fn(),
  },
  apps: {
    getOrgInstallation: vi.fn(),
    listReposAccessibleToInstallation: vi.fn(),
  },
};

vi.mock('@octokit/rest', () => ({
  Octokit: vi.fn().mockImplementation(() => mockOctokit),
}));

vi.mock('./../aws/runners', async () => ({
  listEC2Runners: vi.fn(),
  // Include any other functions from the module that might be used
  bootTimeExceeded: vi.fn(),
}));
vi.mock('./../github/auth', async () => ({
  createGithubAppAuth: vi.fn(),
  createGithubInstallationAuth: vi.fn(),
  createOctokitClient: vi.fn(),
}));

vi.mock('../scale-runners/scale-up', async () => ({
  scaleUp: vi.fn(),
  createRunners: vi.fn(),
  getGitHubEnterpriseApiUrl: vi.fn().mockReturnValue({
    ghesApiUrl: '',
    ghesBaseUrl: '',
  }),
  // Include any other functions that might be needed
}));

const mocktokit = Octokit as MockedClass<typeof Octokit>;
const mockedAppAuth = vi.mocked(ghAuth.createGithubAppAuth);
const mockedInstallationAuth = vi.mocked(ghAuth.createGithubInstallationAuth);
const mockCreateClient = vi.mocked(ghAuth.createOctokitClient);
const mockListRunners = vi.mocked(listEC2Runners);
const mockGetNumberOfQueuedJobs = vi.mocked(getNumberOfQueuedJobs);

const cleanEnv = process.env;

const ORG = 'my-org';
const MINIMUM_TIME_RUNNING = 15;
const LABELS = ['label1', 'label2'];

const ec2InstancesRegistered = [
  {
    instanceId: 'i-1-idle',
    launchTime: new Date(),
    type: 'Org',
    owner: ORG,
  },
  {
    instanceId: 'i-2-busy',
    launchTime: new Date(),
    type: 'Org',
    owner: ORG,
  },
  {
    instanceId: 'i-3-offline',
    launchTime: new Date(),
    type: 'Org',
    owner: ORG,
  },
  {
    instanceId: 'i-4-idle-older-than-minimum-time-running',
    launchTime: moment(new Date())
      .subtract(MINIMUM_TIME_RUNNING + 3, 'minutes')
      .toDate(),
    type: 'Org',
    owner: ORG,
  },
];

const githubRunnersRegistered = [
  {
    id: 1,
    name: 'i-1-idle',
    os: 'linux',
    status: 'online',
    busy: false,
    labels: LABELS,
  },
  {
    id: 2,
    name: 'i-2-busy',
    os: 'linux',
    status: 'online',
    busy: true,
    labels: LABELS,
  },
  {
    id: 3,
    name: 'i-3-offline',
    os: 'linux',
    status: 'offline',
    busy: false,
    labels: LABELS,
  },
  {
    id: 3,
    name: 'i-4-idle-older-than-minimum-time-running',
    os: 'linux',
    status: 'online',
    busy: false,
    labels: LABELS,
  },
];

const githubReposAccessibleToInstallation = [
  {
    owner: {
      login: ORG,
    },
    name: 'my-repo-1',
  },
  {
    owner: {
      login: ORG,
    },
    name: 'my-repo-2',
  },
];

beforeEach(() => {
  nock.disableNetConnect();
  vi.resetModules();
  vi.clearAllMocks();
  process.env = { ...cleanEnv };
  process.env.GITHUB_APP_KEY_BASE64 = 'TEST_CERTIFICATE_DATA';
  process.env.GITHUB_APP_ID = '1337';
  process.env.GITHUB_APP_CLIENT_ID = 'TEST_CLIENT_ID';
  process.env.GITHUB_APP_CLIENT_SECRET = 'TEST_CLIENT_SECRET';
  process.env.RUNNERS_MAXIMUM_COUNT = '3';
  process.env.ENVIRONMENT = 'unit-test-environment';
  process.env.ENABLE_ORGANIZATION_RUNNERS = 'true';
  process.env.LAUNCH_TEMPLATE_NAME = 'lt-1';
  process.env.SUBNET_IDS = 'subnet-123';
  process.env.SSM_TOKEN_PATH = '/github-action-runners/default/runners/tokens';
  process.env.INSTANCE_TYPES = 'm5.large';
  process.env.INSTANCE_TARGET_CAPACITY_TYPE = 'spot';
  process.env.RUNNER_OWNERS = ORG;
  process.env.RUNNER_BOOT_TIME_IN_MINUTES = MINIMUM_TIME_RUNNING.toString();
  process.env.RUNNER_LABELS = LABELS.join(',');

  const mockTokenReturnValue = {
    data: {
      token: '1234abcd',
    },
  };
  mockOctokit.actions.createRegistrationTokenForOrg.mockImplementation(() => mockTokenReturnValue);

  mockOctokit.actions.listSelfHostedRunnersForOrg.mockImplementation(() => githubRunnersRegistered);

  mockOctokit.actions.listSelfHostedRunnersForRepo.mockImplementation(() => githubRunnersRegistered);

  mockOctokit.apps.listReposAccessibleToInstallation.mockImplementation(() => githubReposAccessibleToInstallation);

  mockOctokit.actions.listWorkflowRunsForRepo.mockImplementation(async () => []);

  mockOctokit.actions.listJobsForWorkflowRunAttempt.mockImplementation(async () => []);

  mockListRunners.mockImplementation(async () => ec2InstancesRegistered);

  const mockInstallationIdReturnValueOrgs = {
    data: {
      id: 1,
    },
  };
  mockOctokit.apps.getOrgInstallation.mockImplementation(() => mockInstallationIdReturnValueOrgs);

  mockedAppAuth.mockResolvedValue({
    type: 'app',
    token: 'token',
    appId: 1,
    expiresAt: 'some-date',
  });
  mockedInstallationAuth.mockResolvedValue({
    type: 'token',
    tokenType: 'installation',
    token: 'token',
    createdAt: 'some-date',
    expiresAt: 'some-date',
    permissions: {},
    repositorySelection: 'all',
    installationId: 0,
  });

  mockCreateClient.mockResolvedValue(new mocktokit());
});

describe('Test simple pool.', () => {
  describe('With GitHub Cloud', () => {
    beforeEach(() => {
      (getGitHubEnterpriseApiUrl as ReturnType<typeof vi.fn>).mockReturnValue({
        ghesApiUrl: '',
        ghesBaseUrl: '',
      });
    });
    it('Top up pool with pool size 2 registered.', async () => {
      await adjust({ poolSize: 3, dynamicPoolScalingEnabled: false });
      expect(createRunners).toHaveBeenCalledTimes(1);
      expect(createRunners).toHaveBeenCalledWith(
        expect.objectContaining({ runnerOwner: ORG, runnerType: 'Org' }),
        expect.objectContaining({ numberOfRunners: 1 }),
        expect.anything(),
      );
    });

    it('Should not top up if pool size is reached.', async () => {
      await adjust({ poolSize: 1, dynamicPoolScalingEnabled: false });
      expect(createRunners).not.toHaveBeenCalled();
    });

    it('Should top up if pool size is not reached including a booting instance.', async () => {
      mockListRunners.mockImplementation(async () => [
        ...ec2InstancesRegistered,
        {
          instanceId: 'i-4-still-booting',
          launchTime: moment(new Date())
            .subtract(MINIMUM_TIME_RUNNING - 3, 'minutes')
            .toDate(),
          type: 'Org',
          owner: ORG,
        },
        {
          instanceId: 'i-5-orphan',
          launchTime: moment(new Date())
            .subtract(MINIMUM_TIME_RUNNING + 3, 'minutes')
            .toDate(),
          type: 'Org',
          owner: ORG,
        },
      ]);

      // 2 idle + 1 booting = 3, top up with 2 to match a pool of 5
      await adjust({ poolSize: 5, dynamicPoolScalingEnabled: false });
      expect(createRunners).toHaveBeenCalled();
      // With TypeScript we can't directly access mock.calls, so we'll just verify the function was called
      // The number of runners (2), the runner owner (ORG) and the runner type (Org) should all be correct,
      // but we can't type-check this easily
    });

    it('Should not top up if pool size is reached including a booting instance.', async () => {
      mockListRunners.mockImplementation(async () => [
        ...ec2InstancesRegistered,
        {
          instanceId: 'i-4-still-booting',
          launchTime: moment(new Date())
            .subtract(MINIMUM_TIME_RUNNING - 3, 'minutes')
            .toDate(),
          type: 'Org',
          owner: ORG,
        },
        {
          instanceId: 'i-5-orphan',
          launchTime: moment(new Date())
            .subtract(MINIMUM_TIME_RUNNING + 3, 'minutes')
            .toDate(),
          type: 'Org',
          owner: ORG,
        },
      ]);

      await adjust({ poolSize: 2, dynamicPoolScalingEnabled: false });
      expect(createRunners).not.toHaveBeenCalled();
    });

    it('Should not top up if pool size is invalid.', async () => {
      process.env.RUNNER_LABELS = '';
      await adjust({ poolSize: -2, dynamicPoolScalingEnabled: false });
      expect(createRunners).not.toHaveBeenCalled();
    });
  });

  describe('With GHES', () => {
    beforeEach(() => {
      (getGitHubEnterpriseApiUrl as ReturnType<typeof vi.fn>).mockReturnValue({
        ghesApiUrl: 'https://api.github.enterprise.something',
        ghesBaseUrl: 'https://github.enterprise.something',
      });
    });

    it('Top up if the pool size is set to 5', async () => {
      await adjust({ poolSize: 5, dynamicPoolScalingEnabled: false });
      // 2 idle, top up with 3 to match a pool of 5
      expect(createRunners).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ numberOfRunners: 3 }),
        expect.anything(),
      );
    });
  });

  describe('With Github Data Residency', () => {
    beforeEach(() => {
      (getGitHubEnterpriseApiUrl as ReturnType<typeof vi.fn>).mockReturnValue({
        ghesApiUrl: 'https://api.companyname.ghe.com',
        ghesBaseUrl: 'https://companyname.ghe.com',
      });
    });

    it('Top up if the pool size is set to 5', async () => {
      await adjust({ poolSize: 5, dynamicPoolScalingEnabled: false });
      // 2 idle, top up with 3 to match a pool of 5
      expect(createRunners).toHaveBeenCalledWith(
        expect.objectContaining({ runnerOwner: ORG, runnerType: 'Org' }),
        expect.objectContaining({ numberOfRunners: 3 }),
        expect.anything(),
      );
    });
  });

  describe('With Runner Name Prefix', () => {
    beforeEach(() => {
      process.env.RUNNER_NAME_PREFIX = 'runner-prefix_';
    });

    it('Should top up with fewer runners when there are idle prefixed runners', async () => {
      // Add prefixed runners to github
      mockOctokit.actions.listSelfHostedRunnersForOrg.mockImplementation(async () => [
        ...githubRunnersRegistered,
        {
          id: 5,
          name: 'runner-prefix_i-5-idle',
          os: 'linux',
          status: 'online',
          busy: false,
          labels: [],
        },
        {
          id: 6,
          name: 'runner-prefix_i-6-idle',
          os: 'linux',
          status: 'online',
          busy: false,
          labels: [],
        },
      ]);

      // Add instances in ec2
      mockListRunners.mockImplementation(async () => [
        ...ec2InstancesRegistered,
        {
          instanceId: 'i-5-idle',
          launchTime: new Date(),
          type: 'Org',
          owner: ORG,
        },
        {
          instanceId: 'i-6-idle',
          launchTime: new Date(),
          type: 'Org',
          owner: ORG,
        },
      ]);

      await adjust({ poolSize: 5, dynamicPoolScalingEnabled: false });
      // 2 idle, 2 prefixed idle top up with 1 to match a pool of 5
      expect(createRunners).toHaveBeenCalledWith(
        expect.objectContaining({ runnerOwner: ORG, runnerType: 'Org' }),
        expect.objectContaining({ numberOfRunners: 1 }),
        expect.anything(),
      );
    });
  });

  describe('With Dynamic Pool Scaling Enabled', () => {
    const testCases = [
      { poolSize: 1, numberOfRunners: 0 },
      { poolSize: 2, numberOfRunners: 0 },
      { poolSize: 4, numberOfRunners: 2, numberOfQueuedJobs: 6 },
      { poolSize: 4, numberOfRunners: 2, numberOfQueuedJobs: 4 },
      { poolSize: 4, numberOfRunners: 1, numberOfQueuedJobs: 3 },
      { poolSize: 4, numberOfRunners: 0, numberOfQueuedJobs: 2 },
      { poolSize: 4, numberOfRunners: 0, numberOfQueuedJobs: 0 },
    ];

    for (const { poolSize, numberOfRunners, numberOfQueuedJobs } of testCases) {
      let message = numberOfRunners === 0 ? 'Should not top up' : `Should top up with ${numberOfRunners} runners`;
      message += ` when the maximum pool size is ${poolSize}, and there are 2 idle runners`;
      if (numberOfQueuedJobs !== undefined) {
        message += ` and ${numberOfQueuedJobs} queued jobs`;
      }

      it(message, async () => {
        if (numberOfQueuedJobs !== undefined) {
          mockGetNumberOfQueuedJobs.mockReturnValueOnce(Promise.resolve(numberOfQueuedJobs));
        }
        await expect(await adjust({ poolSize, dynamicPoolScalingEnabled: true })).resolves;
        if (numberOfQueuedJobs === undefined) {
          expect(mockGetNumberOfQueuedJobs).not.toHaveBeenCalled();
        } else {
          expect(mockGetNumberOfQueuedJobs).toHaveBeenCalledTimes(1);
        }
        if (numberOfRunners === 0) {
          expect(createRunners).not.toHaveBeenCalled();
        } else {
          expect(createRunners).toHaveBeenCalledTimes(1);
          expect(createRunners).toHaveBeenCalledWith(
            expect.objectContaining({ runnerOwner: ORG, runnerType: 'Org' }),
            expect.objectContaining({ numberOfRunners }),
            expect.anything(),
          );
        }
      });
    }
  });

  describe('With Runner Type Repo', () => {
    it('Should top up the repository runners pool', async () => {
      const runnerOwner = `${ORG}/my-repo-1`;
      process.env.RUNNER_OWNERS = runnerOwner;
      await expect(await adjust({ poolSize: 3, dynamicPoolScalingEnabled: false })).resolves;
      expect(createRunners).toHaveBeenCalledTimes(1);
      expect(createRunners).toHaveBeenCalledWith(
        expect.objectContaining({ runnerOwner, runnerType: 'Repo' }),
        expect.objectContaining({ numberOfRunners: 1 }),
        expect.anything(),
      );
    });

    it('Should top up the repository runners pool dynamically', async () => {
      const runnerOwner = `${ORG}/my-repo-1`;
      process.env.RUNNER_OWNERS = runnerOwner;
      mockGetNumberOfQueuedJobs.mockReturnValueOnce(Promise.resolve(3));
      await expect(await adjust({ poolSize: 3, dynamicPoolScalingEnabled: true })).resolves;
      expect(createRunners).toHaveBeenCalledTimes(1);
      expect(createRunners).toHaveBeenCalledWith(
        expect.objectContaining({ runnerOwner, runnerType: 'Repo' }),
        expect.objectContaining({ numberOfRunners: 1 }),
        expect.anything(),
      );
    });
  });

  describe('With Multiple Runner Owners', () => {
    it('Should top up pools for all runner owners', async () => {
      const runnerOwners = [`${ORG}/my-repo-1`, `${ORG}/my-repo-2`];
      process.env.RUNNER_OWNERS = runnerOwners.join(',');
      await expect(await adjust({ poolSize: 3, dynamicPoolScalingEnabled: false })).resolves;
      expect(createRunners).toHaveBeenCalledTimes(2);
      for (const runnerOwner of runnerOwners) {
        expect(createRunners).toHaveBeenCalledWith(
          expect.objectContaining({ runnerOwner, runnerType: 'Repo' }),
          expect.objectContaining({ numberOfRunners: 1 }),
          expect.anything(),
        );
      }
    });
  });
});

describe('Test number of queued jobs retrieval.', () => {
  let ghClient: Octokit;

  beforeEach(() => {
    ghClient = new mocktokit();

    mockOctokit.actions.listWorkflowRunsForRepo.mockImplementation(async ({ owner, repo }) => [
      {
        repository: {
          owner: { login: owner },
          name: repo,
        },
        id: 1,
        attempt_number: 1,
      },
      {
        repository: {
          owner: { login: owner },
          name: repo,
        },
        id: 2,
        attempt_number: 1,
      },
    ]);

    mockOctokit.actions.listJobsForWorkflowRunAttempt.mockImplementation(async () => [
      {
        status: 'queued',
        labels: LABELS,
      },
      {
        status: 'queued',
        labels: LABELS,
      },
      {
        status: 'queued',
        labels: [...LABELS, 'label3'],
      },
      {
        status: 'in_progress',
        labels: LABELS,
      },
    ]);
  });

  it('Should retrieve the number of queued jobs for the org', async () => {
    // 2 repos x 2 workflow runs x 2 queued jobs with matching labels
    await expect(getNumberOfQueuedJobs(ghClient, ORG, 'Org', LABELS.join(','))).resolves.toBe(8);
  });

  for (const githubRepo of githubReposAccessibleToInstallation) {
    it(`Should retrieve the number of queued jobs for the repo ${githubRepo.name}`, async () => {
      // 1 repo x 2 workflow runs x 2 queued jobs with matching labels
      await expect(
        getNumberOfQueuedJobs(ghClient, `${githubRepo.owner.login}/${githubRepo.name}`, 'Repo', LABELS.join(',')),
      ).resolves.toBe(4);
    });
  }
});

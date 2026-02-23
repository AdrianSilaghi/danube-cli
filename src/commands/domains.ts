import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { ApiClient } from '../lib/api-client.js';
import { readProjectConfig } from '../lib/project.js';
import { NotLinkedError } from '../lib/errors.js';
import { formatTable, statusColor } from '../lib/output.js';
import type { StaticSiteDomain, MessageWithDataResponse, MessageResponse } from '../types/api.js';

const lsCommand = new Command('ls')
  .description('List domains')
  .action(async () => {
    const project = await readProjectConfig();
    if (!project) throw new NotLinkedError();

    const api = await ApiClient.create();
    const res = await api.get<{ data: StaticSiteDomain[] }>(
      `/api/v1/static-sites/${project.siteId}/domains`,
    );

    if (res.data.length === 0) {
      console.log('No domains configured.');
      return;
    }

    const rows = res.data.map(d => [
      d.domain,
      d.type,
      statusColor(d.status),
      d.verified_at || '-',
    ]);

    console.log(formatTable(['DOMAIN', 'TYPE', 'STATUS', 'VERIFIED'], rows));
  });

const addCommand = new Command('add')
  .description('Add a custom domain')
  .argument('<domain>', 'Domain name to add')
  .action(async (domain: string) => {
    const project = await readProjectConfig();
    if (!project) throw new NotLinkedError();

    const api = await ApiClient.create();
    const spinner = ora(`Adding ${domain}...`).start();

    const res = await api.post<MessageWithDataResponse<StaticSiteDomain>>(
      `/api/v1/static-sites/${project.siteId}/domains`,
      { domain },
    );

    spinner.succeed(`Added ${chalk.bold(domain)}`);

    if (res.data.verification_record) {
      console.log(`\nAdd a CNAME record to verify ownership:`);
      console.log(chalk.cyan(`  ${res.data.verification_record}`));
      console.log(`\nThen run: ${chalk.bold(`danube pages domains verify ${domain}`)}`);
    }
  });

const removeCommand = new Command('remove')
  .description('Remove a custom domain')
  .argument('<domain>', 'Domain name to remove')
  .action(async (domain: string) => {
    const project = await readProjectConfig();
    if (!project) throw new NotLinkedError();

    const api = await ApiClient.create();

    // Find domain by name
    const domainsRes = await api.get<{ data: StaticSiteDomain[] }>(
      `/api/v1/static-sites/${project.siteId}/domains`,
    );

    const domainObj = domainsRes.data.find(d => d.domain === domain);
    if (!domainObj) {
      console.error(chalk.red(`Domain ${domain} not found.`));
      process.exit(1);
    }

    const spinner = ora(`Removing ${domain}...`).start();
    await api.delete<MessageResponse>(
      `/api/v1/static-sites/${project.siteId}/domains/${domainObj.id}`,
    );

    spinner.succeed(`Removed ${domain}`);
  });

const verifyCommand = new Command('verify')
  .description('Verify a custom domain')
  .argument('<domain>', 'Domain name to verify')
  .action(async (domain: string) => {
    const project = await readProjectConfig();
    if (!project) throw new NotLinkedError();

    const api = await ApiClient.create();

    // Find domain by name
    const domainsRes = await api.get<{ data: StaticSiteDomain[] }>(
      `/api/v1/static-sites/${project.siteId}/domains`,
    );

    const domainObj = domainsRes.data.find(d => d.domain === domain);
    if (!domainObj) {
      console.error(chalk.red(`Domain ${domain} not found.`));
      process.exit(1);
    }

    const spinner = ora(`Verifying ${domain}...`).start();
    await api.post<MessageResponse>(
      `/api/v1/static-sites/${project.siteId}/domains/${domainObj.id}/verify`,
    );

    spinner.succeed(`Verification started for ${chalk.bold(domain)}`);
  });

export const domainsCommand = new Command('domains')
  .description('Manage custom domains')
  .addCommand(lsCommand)
  .addCommand(addCommand)
  .addCommand(removeCommand)
  .addCommand(verifyCommand);

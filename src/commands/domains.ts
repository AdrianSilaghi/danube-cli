import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import type { ApiClient } from '../lib/api-client.js';
import { openLinkedSite } from '../lib/linked-site.js';
import { formatTable, statusColor } from '../lib/output.js';
import { isJsonMode, jsonEnvelope, jsonOutput } from '../lib/json-mode.js';
import { sleep } from '../lib/sleep.js';
import type { StaticSite, StaticSiteDomain, MessageWithDataResponse, MessageResponse } from '../types/api.js';

/** Verification is one DNS lookup in a queued job: seconds, normally. */
export const VERIFY_TIMEOUT_MS = 30_000;
const VERIFY_POLL_MS = 2_000;

/** The host a custom domain has to point at: the site's own pages.danubedata.ro name. */
function siteHost(site: StaticSite): string {
  return new URL(site.url).host;
}

async function listDomains(api: ApiClient, siteId: string): Promise<StaticSiteDomain[]> {
  const res = await api.get<{ data: StaticSiteDomain[] }>(`/api/v1/static-sites/${siteId}/domains`);

  return res.data;
}

async function findDomain(api: ApiClient, siteId: string, name: string): Promise<StaticSiteDomain> {
  const found = (await listDomains(api, siteId)).find(d => d.domain === name);
  if (!found) {
    console.error(chalk.red(`Domain ${name} not found.`));
    process.exit(1);
  }

  return found;
}

/** Both records a custom domain needs, in the order they have to be created. */
function printDnsSetup(domain: StaticSiteDomain, site: StaticSite): void {
  const txt = domain.dns_instructions;

  if (txt) {
    console.log(`\n1. Prove you own ${chalk.bold(domain.domain)} with this DNS record:`);
    console.log(chalk.cyan(`     ${txt.record_type}  ${txt.record_name}  ${txt.record_value}`));
    console.log(`   then run: ${chalk.bold(`danube pages domains verify ${domain.domain}`)}`);
  }

  console.log(`\n${txt ? '2' : '1'}. Point the domain at your site:`);
  console.log(chalk.cyan(`     ${domain.domain}  CNAME  ${siteHost(site)}`));
  console.log(chalk.dim('   For an apex domain (example.com), use an ALIAS or ANAME record instead of a CNAME.'));
}

const lsCommand = new Command('ls')
  .description('List domains')
  .action(async () => {
    const { api, site } = await openLinkedSite();
    const domains = await listDomains(api, site.id);

    if (isJsonMode()) {
      jsonOutput(domains);
      return;
    }

    console.log(`Default: ${chalk.bold(siteHost(site))}`);

    if (domains.length === 0) {
      console.log('No custom domains configured.');
      return;
    }

    const rows = domains.map(d => [
      d.domain,
      statusColor(d.verification_status),
      statusColor(d.tls_status),
      d.is_primary ? 'yes' : '-',
    ]);

    console.log(formatTable(['DOMAIN', 'VERIFICATION', 'TLS', 'PRIMARY'], rows));
  });

const addCommand = new Command('add')
  .description('Add a custom domain')
  .argument('<domain>', 'Domain name to add')
  .action(async (domain: string) => {
    const { api, site } = await openLinkedSite();
    const spinner = isJsonMode() ? null : ora(`Adding ${domain}...`).start();

    const res = await api.post<MessageWithDataResponse<StaticSiteDomain>>(
      `/api/v1/static-sites/${site.id}/domains`,
      { domain },
    );

    if (isJsonMode()) {
      jsonOutput({ ...res.data, cname_target: siteHost(site) });
      return;
    }

    spinner!.succeed(`Added ${chalk.bold(domain)}`);
    printDnsSetup(res.data, site);
  });

const removeCommand = new Command('remove')
  .description('Remove a custom domain')
  .argument('<domain>', 'Domain name to remove')
  .action(async (domain: string) => {
    const { api, site } = await openLinkedSite();
    const domainObj = await findDomain(api, site.id, domain);

    const spinner = isJsonMode() ? null : ora(`Removing ${domain}...`).start();
    await api.delete<MessageResponse>(
      `/api/v1/static-sites/${site.id}/domains/${domainObj.id}`,
    );

    if (isJsonMode()) {
      jsonOutput({ status: 'removed', domain });
      return;
    }
    spinner!.succeed(`Removed ${domain}`);
  });

/**
 * Poll until the domain verifies, its status moves off where it started (the
 * check ran and failed), or the wait runs out. A domain that had already
 * failed stays `failed` whatever the new check finds, so only `verified` ends
 * that wait early. Returns the last state seen.
 */
async function waitForVerification(api: ApiClient, siteId: string, before: StaticSiteDomain): Promise<StaticSiteDomain | undefined> {
  const deadline = Date.now() + VERIFY_TIMEOUT_MS;
  let latest: StaticSiteDomain | undefined;

  while (Date.now() < deadline) {
    await sleep(VERIFY_POLL_MS);
    latest = (await listDomains(api, siteId)).find(d => d.domain === before.domain);
    if (latest?.verification_status === 'verified') break;
    if (latest && latest.verification_status !== before.verification_status) break;
  }

  return latest;
}

const verifyCommand = new Command('verify')
  .description('Verify a custom domain')
  .argument('<domain>', 'Domain name to verify')
  .option('--no-wait', 'Start verification without waiting for the result')
  .action(async (domain: string, opts: { wait: boolean }) => {
    const { api, site } = await openLinkedSite();
    const domainObj = await findDomain(api, site.id, domain);

    const spinner = isJsonMode() ? null : ora(`Verifying ${domain}...`).start();
    await api.post<MessageResponse>(
      `/api/v1/static-sites/${site.id}/domains/${domainObj.id}/verify`,
    );

    if (!opts.wait) {
      if (isJsonMode()) {
        jsonOutput({ status: 'verification_started', domain });
        return;
      }
      spinner!.succeed(`Verification started for ${chalk.bold(domain)}`);
      return;
    }

    const result = await waitForVerification(api, site.id, domainObj);

    if (result?.verification_status === 'verified') {
      if (isJsonMode()) {
        jsonOutput({ status: 'verified', domain, cname_target: siteHost(site) });
        return;
      }
      spinner!.succeed(`Verified ${chalk.bold(domain)}`);
      console.log(`\nPoint it at your site if you have not yet: ${chalk.cyan(`${domain}  CNAME  ${siteHost(site)}`)}`);
      return;
    }

    const message = `${domain} is not verified: the TXT record was not found. DNS changes can take a while to propagate — run this again later.`;
    if (isJsonMode()) {
      jsonEnvelope({ status: 'not_verified', domain }, { error: { code: 'static_site.domain_not_verified', message, retryable: true } });
      process.exit(1);
    }

    spinner!.fail(`${domain} is not verified yet`);
    console.error(chalk.red(message));
    printDnsSetup(result ?? domainObj, site);
    process.exit(1);
  });

export const domainsCommand = new Command('domains')
  .description('Manage custom domains')
  .addCommand(lsCommand)
  .addCommand(addCommand)
  .addCommand(removeCommand)
  .addCommand(verifyCommand);

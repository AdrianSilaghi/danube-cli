import { Command } from 'commander';
import chalk from 'chalk';
import { ApiClient } from '../../lib/api-client.js';
import { resolveContainer } from './resolve.js';
import { runsApi } from '../../lib/rapids-runs.js';
import { isJsonMode, jsonOutput, jsonEnvelope, jsonError } from '../../lib/json-mode.js';
import { formatTable, formatDate, printDetails } from '../../lib/output.js';
import type { Envelope, ServerlessRunSchedule } from '../../types/api.js';

const schedulesPath = (containerId: string): string => `/api/v1/serverless/${containerId}/schedules`;
const schedulePath = (containerId: string, id: string): string => `${schedulesPath(containerId)}/${id}`;

const formatCommand = (command: string[] | null): string =>
  !command || command.length === 0 ? chalk.dim('(image default)') : command.join(' ');

const formatWhen = (iso: string | null): string => (iso ? formatDate(iso) : '-');

const enabledLabel = (enabled: boolean): string =>
  enabled ? chalk.green('enabled') : chalk.yellow('paused');

/**
 * Schedules are addressed by NAME on the command line — that is what a person
 * wrote down — but by id over the wire. Resolving through the list also means
 * a name that does not exist is reported here, before any schedule-specific
 * call can 404 and be mistaken for the feature being switched off.
 */
async function resolveSchedule(
  api: { get: <T>(path: string) => Promise<T> },
  containerId: string,
  nameOrId: string,
): Promise<ServerlessRunSchedule> {
  const res = await runsApi(() =>
    api.get<Envelope<ServerlessRunSchedule[]>>(schedulesPath(containerId)),
  );

  const match = res.data.find((s) => s.name === nameOrId || s.id === nameOrId);

  if (!match) {
    const message = `No schedule named '${nameOrId}' on this container.`;
    if (isJsonMode()) {
      jsonError({ code: 'serverless.schedule_not_found', message });
    } else {
      console.error(chalk.red(message));
    }
    process.exit(1);
  }

  return match;
}

function printSchedule(schedule: ServerlessRunSchedule): void {
  const lines: Array<[string, string]> = [
    ['Name', schedule.name],
    ['ID', schedule.id],
    ['State', enabledLabel(schedule.enabled)],
    ['Repeats', `${schedule.cron_expression} (${schedule.timezone})`],
    ['Command', formatCommand(schedule.command)],
    ['Image tag', schedule.image_tag ?? chalk.dim("(container's current tag)")],
    ['Timeout', `${schedule.timeout_seconds}s`],
    ['Next run', formatWhen(schedule.next_run_at)],
    ['Last run', formatWhen(schedule.last_run_at)],
  ];

  // Only worth the customer's attention when there is one — and when there is,
  // it is usually the answer to "why did nothing happen last night?".
  if (schedule.last_skipped_at) {
    lines.push(['Last skipped', formatWhen(schedule.last_skipped_at)]);
    lines.push(['Reason', schedule.last_skip_reason ?? '-']);
  }

  printDetails(lines);
}

export const lsCommand = new Command('ls')
  .description('List a rapids container\'s schedules')
  .argument('<name-or-id>', 'Container name or ID')
  .action(async (nameOrId: string) => {
    const api = await ApiClient.create();
    const container = await resolveContainer(api, nameOrId);

    const res = await runsApi(() =>
      api.get<Envelope<ServerlessRunSchedule[]>>(schedulesPath(container.id)),
    );

    if (isJsonMode()) {
      jsonEnvelope(res.data, { error: res.error ?? null, meta: res.meta ?? {} });
      return;
    }

    if (res.data.length === 0) {
      console.log(chalk.dim('No schedules yet.'));
      return;
    }

    console.log(
      formatTable(
        ['NAME', 'STATE', 'REPEATS', 'TIMEZONE', 'NEXT RUN', 'COMMAND'],
        res.data.map((s) => [
          s.name,
          enabledLabel(s.enabled),
          s.cron_expression,
          s.timezone,
          formatWhen(s.next_run_at),
          formatCommand(s.command),
        ]),
      ),
    );
  });

export const showCommand = new Command('show')
  .description('Show one schedule')
  .argument('<container>', 'Container name or ID')
  .argument('<schedule>', 'Schedule name or ID')
  .action(async (containerRef: string, scheduleRef: string) => {
    const api = await ApiClient.create();
    const container = await resolveContainer(api, containerRef);
    const schedule = await resolveSchedule(api, container.id, scheduleRef);

    if (isJsonMode()) {
      jsonOutput(schedule);
      return;
    }

    printSchedule(schedule);
  });

export const createCommand = new Command('create')
  .description('Create a schedule that runs a command on a repeating basis')
  .argument('<container>', 'Container name or ID')
  .argument('[command...]', "Command to run (omit to use the image's entrypoint)")
  .requiredOption('--name <name>', 'Schedule name, unique per container')
  .requiredOption('--cron <expression>', 'Five-field cron expression, e.g. "0 3 * * *"')
  .option('--timezone <zone>', 'IANA timezone the expression is read in', 'UTC')
  .option('--tag <tag>', "Pin an image tag (default: the container's current tag)")
  .option('--timeout <seconds>', 'Run timeout in seconds (60-3600)', '900')
  .action(async (containerRef: string, command: string[], options: {
    name: string;
    cron: string;
    timezone: string;
    tag?: string;
    timeout: string;
  }) => {
    const api = await ApiClient.create();
    const container = await resolveContainer(api, containerRef);

    // No --env here, deliberately: a schedule is stored, and override values
    // are never kept at rest. A scheduled run uses the container's own
    // environment.
    const body: Record<string, unknown> = {
      name: options.name,
      cron_expression: options.cron,
      timezone: options.timezone,
      timeout_seconds: Number(options.timeout),
    };
    if (command.length > 0) body.command = command;
    if (options.tag) body.image_tag = options.tag;

    const res = await runsApi(() =>
      api.post<Envelope<ServerlessRunSchedule>>(schedulesPath(container.id), body),
    );

    if (isJsonMode()) {
      jsonOutput(res.data);
      return;
    }

    console.log(chalk.green(`Created schedule '${res.data.name}'.`));
    printSchedule(res.data);
  });

export const rmCommand = new Command('rm')
  .description('Delete a schedule (runs it already produced are kept)')
  .argument('<container>', 'Container name or ID')
  .argument('<schedule>', 'Schedule name or ID')
  .action(async (containerRef: string, scheduleRef: string) => {
    const api = await ApiClient.create();
    const container = await resolveContainer(api, containerRef);
    const schedule = await resolveSchedule(api, container.id, scheduleRef);

    await runsApi(() => api.delete<Envelope<null>>(schedulePath(container.id, schedule.id)));

    if (isJsonMode()) {
      jsonOutput({ id: schedule.id, name: schedule.name, deleted: true });
      return;
    }

    console.log(chalk.green(`Deleted schedule '${schedule.name}'.`));
  });

function setEnabled(name: string, enabled: boolean, description: string): Command {
  return new Command(name)
    .description(description)
    .argument('<container>', 'Container name or ID')
    .argument('<schedule>', 'Schedule name or ID')
    .action(async (containerRef: string, scheduleRef: string) => {
      const api = await ApiClient.create();
      const container = await resolveContainer(api, containerRef);
      const schedule = await resolveSchedule(api, container.id, scheduleRef);

      const res = await runsApi(() =>
        api.patch<Envelope<ServerlessRunSchedule>>(
          schedulePath(container.id, schedule.id),
          { enabled },
        ),
      );

      if (isJsonMode()) {
        jsonOutput(res.data);
        return;
      }

      // Resuming re-arms it, so the next run time is the useful part of the
      // answer rather than a bare "ok".
      console.log(
        chalk.green(`Schedule '${res.data.name}' is ${enabled ? 'enabled' : 'paused'}.`) +
          (enabled ? ` Next run ${formatWhen(res.data.next_run_at)}.` : ''),
      );
    });
}

export const pauseCommand = setEnabled('pause', false, 'Pause a schedule without deleting it');
export const resumeCommand = setEnabled('resume', true, 'Resume a paused schedule');

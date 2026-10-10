import { UsageError } from './errors.js';
import type { Team, TeamsResponse } from '../types/api.js';

/**
 * Which project an API token is held to, read from `GET /api/v1/user/teams`.
 *
 * A token made for "This project only" (the console's default) is refused in
 * every other project, so the CLI must never be pointed at one: every command
 * would then fail with a 403 that names no project. `token_team_id` is null
 * for a token that works in every project of the account, and missing from
 * deployments older than 2026-10.
 */
export function lockedTeamId(res: TeamsResponse): number | null {
  return typeof res.token_team_id === 'number' ? res.token_team_id : null;
}

/** What the token reaches, in words, or null when the server does not say. */
export function tokenReach(res: TeamsResponse, teams: Team[]): string | null {
  if (res.token_team_id === undefined) {
    return null;
  }

  const locked = lockedTeamId(res);

  return locked === null ? 'all your projects' : `${teamLabel(locked, teams)} only`;
}

/** Refuses a project the token would be refused in. */
export function assertTokenReaches(teamId: number, res: TeamsResponse, teams: Team[]): void {
  const locked = lockedTeamId(res);

  if (locked === null || locked === teamId) {
    return;
  }

  throw new UsageError(
    `This token works in ${teamLabel(locked, teams)} only, and the API refuses it in any other project. `
      + 'Select that one, or log in with a token made for all your projects (Security, API tokens, Project access: All your projects).',
  );
}

function teamLabel(teamId: number, teams: Team[]): string {
  const team = teams.find(t => t.id === teamId);

  return team ? `${team.name} (id ${team.id})` : `project ${teamId}`;
}

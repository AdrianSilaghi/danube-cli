import { UsageError } from '../../lib/errors.js';

/**
 * `--acl` syntax for Kafka users: `<resource>:<name>:<pattern>:<op>,<op>`.
 *
 *   topic:orders.:prefix:read,describe
 *   group:billing:literal:read
 *   topic:orders:read,write          (pattern defaults to literal)
 *   cluster:describe                 (cluster has no name or pattern)
 *
 * Topic and group names cannot contain ':' on Kafka, so splitting on it is safe.
 */

export interface AclRule {
  resource_type: string;
  name?: string;
  pattern?: string;
  operations: string[];
}

const OPERATIONS: Record<string, readonly string[]> = {
  topic: ['read', 'write', 'create', 'delete', 'alter', 'describe', 'describe_configs', 'alter_configs', 'all'],
  group: ['read', 'describe', 'delete', 'describe_configs', 'alter_configs', 'all'],
  transactional_id: ['describe', 'write', 'all'],
  cluster: ['create', 'describe', 'describe_configs', 'idempotent_write'],
};

const PATTERNS = ['literal', 'prefix'] as const;

export const ACL_SYNTAX = 'Expected <resource>:<name>:<literal|prefix>:<op>,<op> (e.g. topic:orders.:prefix:read,describe) or cluster:<op>.';

function fail(spec: string, problem: string): never {
  throw new UsageError(`Invalid --acl "${spec}": ${problem} ${ACL_SYNTAX}`);
}

export function parseAcl(spec: string): AclRule {
  const parts = spec.split(':').map((p) => p.trim());
  const resource = (parts[0] ?? '').toLowerCase().replace(/-/g, '_');
  const allowed = OPERATIONS[resource];
  if (!allowed) {
    return fail(spec, `unknown resource "${parts[0]}" (use ${Object.keys(OPERATIONS).join(', ')}).`);
  }

  let name: string | undefined;
  let pattern: string | undefined;
  let opsText: string;

  if (resource === 'cluster') {
    if (parts.length !== 2) return fail(spec, 'a cluster rule has only operations.');
    opsText = parts[1] ?? '';
  } else if (parts.length === 3) {
    [, name, opsText] = parts as [string, string, string];
    pattern = 'literal';
  } else if (parts.length === 4) {
    [, name, pattern, opsText] = parts as [string, string, string, string];
    pattern = pattern.toLowerCase();
    if (!(PATTERNS as readonly string[]).includes(pattern)) {
      return fail(spec, `unknown pattern "${pattern}" (use literal or prefix).`);
    }
  } else {
    return fail(spec, 'wrong number of parts.');
  }

  if (name !== undefined && name === '') return fail(spec, 'the name is empty.');
  if (name === '*' && pattern !== 'literal') return fail(spec, '"*" is only valid with the literal pattern.');

  const operations = opsText.split(',').map((o) => o.trim().toLowerCase()).filter(Boolean);
  if (operations.length === 0) return fail(spec, 'no operations given.');
  const bad = operations.filter((o) => !allowed.includes(o));
  if (bad.length > 0) {
    return fail(spec, `${bad.join(', ')} not allowed on ${resource} (use ${allowed.join(', ')}).`);
  }

  return resource === 'cluster'
    ? { resource_type: resource, operations: [...new Set(operations)] }
    : { resource_type: resource, name, pattern, operations: [...new Set(operations)] };
}

export function parseAcls(specs: string[]): AclRule[] {
  return specs.map(parseAcl);
}

export function formatAcl(rule: AclRule): string {
  const target = rule.resource_type === 'cluster' ? 'cluster' : `${rule.resource_type}:${rule.name}:${rule.pattern ?? 'literal'}`;
  return `${target}:${rule.operations.join(',')}`;
}
